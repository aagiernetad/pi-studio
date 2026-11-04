use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{broadcast, mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};

use super::protocol::{
    RuntimeEvent, RuntimeOutboundMessage, RuntimeResponse, encode_request, parse_outbound_line,
};

const MAX_OUTPUT_LINE_BYTES: usize = 1024 * 1024;

type PendingRequests =
    Arc<Mutex<HashMap<String, oneshot::Sender<Result<RuntimeResponse, String>>>>>;

/// 一个独立 Node Runtime 进程的通信连接。
///
/// 请求可以并发发送；后台任务负责串行写入、
/// 读取响应、分发事件与处理连接终止。
pub struct RuntimeSupervisor {
    child: Child,
    input: mpsc::Sender<String>,
    pending: PendingRequests,
    events: broadcast::Sender<Arc<RuntimeEvent>>,
    next_id: AtomicU64,
    writer_task: JoinHandle<()>,
    reader_task: JoinHandle<()>,
    stderr_task: JoinHandle<()>,
}

impl RuntimeSupervisor {
    /// 开发环境启动入口。
    ///
    /// 正式发布版本将使用打包后的 Sidecar，
    /// 不依赖 node_modules 或用户安装的 Node.js。
    pub fn start_dev() -> Result<Self, String> {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("Cannot determine project root")?
            .to_path_buf();

        let tsx = project_root.join("node_modules/tsx/dist/cli.mjs");

        let entry = project_root.join("runtime/src/index.ts");

        if !tsx.is_file() || !entry.is_file() {
            return Err("Runtime entry or tsx CLI not found".into());
        }

        let mut command = Command::new("node");

        command
            .arg(tsx)
            .arg(entry)
            .current_dir(&project_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        command.creation_flags(0x08000000);

        let mut child = command
            .spawn()
            .map_err(|e| format!("Runtime spawn failed: {e}"))?;

        let mut stdin = child.stdin.take().ok_or("Cannot open Runtime stdin")?;

        let stdout = child.stdout.take().ok_or("Cannot open Runtime stdout")?;

        let stderr = child.stderr.take().ok_or("Cannot open Runtime stderr")?;

        let (input, mut input_rx) = mpsc::channel::<String>(128);
        let (events, _) = broadcast::channel(128);

        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));

        // 一个写入者，保证 JSONL 消息不交错。
        let writer_task = tokio::spawn(async move {
            while let Some(line) = input_rx.recv().await {
                if let Err(error) = stdin.write_all(line.as_bytes()).await {
                    eprintln!("[transport] write error: {error}");
                    break;
                }
            }
        });

        // 一个持续读取者，按请求 ID 分发响应。
        let reader_pending = Arc::clone(&pending);
        let reader_events = events.clone();

        let reader_task = tokio::spawn(async move {
            let result = read_stdout(stdout, &reader_pending, &reader_events).await;

            let reason = match result {
                Ok(()) => "Runtime stdout closed".to_string(),
                Err(error) => error,
            };

            // Runtime 退出或协议损坏，所有未完成请求失败。
            let mut requests = reader_pending.lock().unwrap();

            for (_, sender) in requests.drain() {
                let _ = sender.send(Err(reason.clone()));
            }
        });

        // stderr 只用于日志，不参与 IPC。
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();

            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[node-runtime] {line}");
            }
        });

        Ok(Self {
            child,
            input,
            pending,
            events,
            next_id: AtomicU64::new(1),
            writer_task,
            reader_task,
            stderr_task,
        })
    }

    /// 发送请求并等待对应响应。
    ///
    /// 超时表示结果未知，不代表 Node 业务操作已停止。
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<RuntimeResponse, String> {
        let id = format!(
            "rust-{}-{}",
            std::process::id(),
            self.next_id.fetch_add(1, Ordering::Relaxed),
        );

        let line = encode_request(&id, method, params).map_err(|e| e.to_string())?;

        let (sender, receiver) = oneshot::channel();

        self.pending.lock().unwrap().insert(id.clone(), sender);

        // 写入排队和响应等待共用一个截止时间。
        let result = timeout(deadline, async {
            self.input
                .send(line)
                .await
                .map_err(|_| "Runtime writer closed".to_string())?;

            receiver
                .await
                .map_err(|_| "Response channel closed".to_string())?
        })
        .await;

        self.pending.lock().unwrap().remove(&id);

        match result {
            Ok(response) => response,
            Err(_) => Err("IPC_TIMEOUT: request outcome is unknown".into()),
        }
    }

    /// 订阅 Runtime 主动发送的事件。
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<RuntimeEvent>> {
        self.events.subscribe()
    }

    /// 正常关闭进程，超时后强制终止。
    pub async fn shutdown(self) -> Result<(), String> {
        let Self {
            mut child,
            input,
            writer_task,
            reader_task,
            stderr_task,
            ..
        } = self;

        // 关闭写入通道，最终关闭子进程 stdin。
        drop(input);

        let exit = timeout(Duration::from_secs(6), child.wait()).await;

        match exit {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                let _ = child.kill().await;
                return Err(error.to_string());
            }
            Err(_) => {
                child.kill().await.map_err(|e| e.to_string())?;
            }
        }

        // 让后台读写任务完成收尾。
        let _ = timeout(Duration::from_secs(2), writer_task).await;

        let _ = timeout(Duration::from_secs(2), reader_task).await;

        let _ = timeout(Duration::from_secs(2), stderr_task).await;

        Ok(())
    }
}

/// 从 stdout 读取有大小限制的 JSONL 消息。
async fn read_stdout(
    mut stdout: tokio::process::ChildStdout,
    pending: &PendingRequests,
    events: &broadcast::Sender<Arc<RuntimeEvent>>,
) -> Result<(), String> {
    let mut chunk = [0u8; 8192];
    let mut line = Vec::new();

    loop {
        let count = stdout.read(&mut chunk).await.map_err(|e| e.to_string())?;

        if count == 0 {
            return if line.is_empty() {
                Ok(())
            } else {
                Err("Truncated JSONL message".into())
            };
        }

        for &byte in &chunk[..count] {
            if byte == b'\n' {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }

                let text = std::str::from_utf8(&line).map_err(|e| e.to_string())?;

                if !text.is_empty() {
                    route_message(text, pending, events)?;
                }

                line.clear();
            } else {
                if line.len() >= MAX_OUTPUT_LINE_BYTES {
                    return Err("IPC output line too large".into());
                }

                line.push(byte);
            }
        }
    }
}

/// Response 按 ID 分发，Event 通过广播通道发布。
fn route_message(
    line: &str,
    pending: &PendingRequests,
    events: &broadcast::Sender<Arc<RuntimeEvent>>,
) -> Result<(), String> {
    match parse_outbound_line(line).map_err(|e| e.to_string())? {
        RuntimeOutboundMessage::Response(response) => {
            if let Some(sender) = pending.lock().unwrap().remove(&response.id) {
                let _ = sender.send(Ok(response));
            }
        }

        RuntimeOutboundMessage::Event(event) => {
            let _ = events.send(Arc::new(event));
        }
    }

    Ok(())
}

/// 跨进程集成测试：验证 Rust 与真实 Node Runtime 通信。
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn should_handle_concurrent_runtime_requests() {
        let runtime = RuntimeSupervisor::start_dev().unwrap();

        let (first, second) = tokio::join!(
            runtime.request(
                "runtime.ping",
                json!({"message": "hello"}),
                Duration::from_secs(10),
            ),
            runtime.request("runtime.info", json!({}), Duration::from_secs(10),),
        );

        let first = first.unwrap();
        let second = second.unwrap();

        assert!(first.success);
        assert!(second.success);
        assert_ne!(first.id, second.id);

        assert_eq!(first.result.unwrap()["message"], "hello");

        assert_eq!(second.result.unwrap()["name"], "Pi Studio Runtime");

        runtime.shutdown().await.unwrap();
    }
}
