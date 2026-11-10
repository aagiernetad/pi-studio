use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
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

// 统一管理写入请求和关闭命令
enum WriterCommand {
    Line(String),
    Shutdown,
}

/// 可克隆通信句柄，不拥有 Node.js 子进程。
#[derive(Clone)]
pub struct RuntimeClient {
    input: mpsc::Sender<WriterCommand>,
    pending: PendingRequests,
    events: broadcast::Sender<Arc<RuntimeEvent>>,
    next_id: Arc<AtomicU64>,
    closed: Arc<AtomicBool>,
}

/// 请求等待被取消时，自动清理 Pending Map。
struct PendingGuard {
    id: String,
    pending: PendingRequests,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

/// Runtime 进程所有者。
pub struct RuntimeSupervisor {
    child: Child,
    client: RuntimeClient,
    writer_task: JoinHandle<()>,
    reader_task: JoinHandle<()>,
    stderr_task: JoinHandle<()>,
}

impl RuntimeSupervisor {
    /// 启动本地开发 Runtime。
    pub fn start_dev(data_dir: &Path) -> Result<Self, String> {
        if !data_dir.is_dir() {
            return Err(format!(
                "Runtime data directory does not exist: {}",
                data_dir.display()
            ));
        }

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
            .env("PI_STUDIO_DATA_DIR", data_dir.as_os_str())
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

        let (input, mut input_rx) = mpsc::channel::<WriterCommand>(128);

        let (events, _) = broadcast::channel(128);

        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));

        let closed = Arc::new(AtomicBool::new(false));

        // 唯一 stdin 写入者
        let writer_pending = Arc::clone(&pending);
        let writer_closed = Arc::clone(&closed);

        let writer_task = tokio::spawn(async move {
            while let Some(command) = input_rx.recv().await {
                match command {
                    WriterCommand::Line(line) => {
                        if let Err(error) = stdin.write_all(line.as_bytes()).await {
                            writer_closed.store(true, Ordering::Release);

                            fail_pending(&writer_pending, format!("Runtime write failed: {error}"));
                            break;
                        }
                    }

                    WriterCommand::Shutdown => {
                        let _ = stdin.shutdown().await;
                        break;
                    }
                }
            }
        });

        // 唯一 stdout 读取者
        let reader_pending = Arc::clone(&pending);
        let reader_events = events.clone();
        let reader_closed = Arc::clone(&closed);

        let reader_task = tokio::spawn(async move {
            let reason = read_stdout(stdout, &reader_pending, &reader_events)
                .await
                .err()
                .unwrap_or_else(|| "Runtime stdout closed".into());

            reader_closed.store(true, Ordering::Release);
            fail_pending(&reader_pending, reason);
        });

        // stderr 只记录日志，不参与 IPC
        let stderr_task = tokio::spawn(async move {
            let mut stderr = stderr;
            let mut buffer = [0u8; 4096];

            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(size) => {
                        eprint!(
                            "[node-runtime] {}",
                            String::from_utf8_lossy(&buffer[..size])
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        let client = RuntimeClient {
            input,
            pending,
            events,
            next_id: Arc::new(AtomicU64::new(1)),
            closed,
        };

        Ok(Self {
            child,
            client,
            writer_task,
            reader_task,
            stderr_task,
        })
    }

    pub fn client(&self) -> RuntimeClient {
        self.client.clone()
    }

    /// 正常关闭，超过宽限期则强制终止。
    pub async fn shutdown(mut self) -> Result<(), String> {
        self.client.closed.store(true, Ordering::Release);

        // 限制发送关闭命令的等待时间
        let _ = timeout(
            Duration::from_secs(1),
            self.client.input.send(WriterCommand::Shutdown),
        )
        .await;

        let exit = timeout(Duration::from_secs(6), self.child.wait()).await;

        match exit {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                let _ = self.child.kill().await;
                return Err(error.to_string());
            }
            Err(_) => {
                self.child.kill().await.map_err(|e| e.to_string())?;
            }
        }

        let _ = timeout(Duration::from_secs(2), &mut self.writer_task).await;

        let _ = timeout(Duration::from_secs(2), &mut self.reader_task).await;

        let _ = timeout(Duration::from_secs(2), &mut self.stderr_task).await;

        self.writer_task.abort();
        self.reader_task.abort();
        self.stderr_task.abort();

        Ok(())
    }
}

impl RuntimeClient {
    /// 并发发送请求，通过 ID 匹配响应。
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<RuntimeResponse, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("Runtime is closed".into());
        }

        let id = format!(
            "rust-{}-{}",
            std::process::id(),
            self.next_id.fetch_add(1, Ordering::Relaxed),
        );

        let line = encode_request(&id, method, params).map_err(|e| e.to_string())?;

        let (sender, receiver) = oneshot::channel();

        {
            let mut pending = self.pending.lock().map_err(|_| "Pending lock poisoned")?;

            if self.closed.load(Ordering::Acquire) {
                return Err("Runtime is closed".into());
            }

            pending.insert(id.clone(), sender);
        }

        // 即使 Future 被取消，也能释放等待者。
        let _guard = PendingGuard {
            id,
            pending: Arc::clone(&self.pending),
        };

        let operation = async {
            self.input
                .send(WriterCommand::Line(line))
                .await
                .map_err(|_| "Runtime writer closed".to_string())?;

            receiver
                .await
                .map_err(|_| "Response channel closed".to_string())?
        };

        match timeout(deadline, operation).await {
            Ok(result) => result,
            Err(_) => Err("IPC_TIMEOUT: request outcome is unknown".into()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<RuntimeEvent>> {
        self.events.subscribe()
    }
}

fn fail_pending(pending: &PendingRequests, reason: String) {
    if let Ok(mut requests) = pending.lock() {
        for (_, sender) in requests.drain() {
            let _ = sender.send(Err(reason.clone()));
        }
    }
}

async fn read_stdout(
    mut stdout: tokio::process::ChildStdout,
    pending: &PendingRequests,
    events: &broadcast::Sender<Arc<RuntimeEvent>>,
) -> Result<(), String> {
    let mut buffer = [0u8; 8192];
    let mut line = Vec::new();

    loop {
        let count = stdout.read(&mut buffer).await.map_err(|e| e.to_string())?;

        if count == 0 {
            return if line.is_empty() {
                Ok(())
            } else {
                Err("Truncated JSONL message".into())
            };
        }

        for &byte in &buffer[..count] {
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

fn route_message(
    line: &str,
    pending: &PendingRequests,
    events: &broadcast::Sender<Arc<RuntimeEvent>>,
) -> Result<(), String> {
    match parse_outbound_line(line).map_err(|e| e.to_string())? {
        RuntimeOutboundMessage::Response(response) => {
            if let Ok(mut requests) = pending.lock() {
                if let Some(sender) = requests.remove(&response.id) {
                    let _ = sender.send(Ok(response));
                }
            }
        }

        RuntimeOutboundMessage::Event(event) => {
            let _ = events.send(Arc::new(event));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_DATA_DIR_SEQUENCE: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(1);

    fn test_data_dir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pi-studio-runtime-test-{}-{}",
            std::process::id(),
            TEST_DATA_DIR_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));

        std::fs::create_dir_all(&path).unwrap();

        path
    }

    use serde_json::json;

    // 1. 验证两个请求能并发执行并正确关联响应
    #[tokio::test]
    async fn should_handle_concurrent_requests() {
        let data_dir = test_data_dir();
        let supervisor = RuntimeSupervisor::start_dev(&data_dir).unwrap();
        let client = supervisor.client();

        let (ping, info) = tokio::join!(
            client.request(
                "runtime.ping",
                json!({"message": "hello"}),
                Duration::from_secs(10),
            ),
            client.request("runtime.info", json!({}), Duration::from_secs(10),),
        );

        let ping = ping.unwrap();
        let info = info.unwrap();

        assert!(ping.success);
        assert!(info.success);
        assert_ne!(ping.id, info.id);

        assert_eq!(ping.result.unwrap()["message"], "hello");
        let info_result = info.result.unwrap();
        assert_eq!(info_result["name"], "Pi Studio Runtime");
        assert_eq!(info_result["dataDirectoryConfigured"], true);

        supervisor.shutdown().await.unwrap();

        // 进程关闭后，新请求必须被拒绝
        assert!(
            client
                .request("runtime.ping", json!({}), Duration::from_secs(1),)
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // 2. 请求超时后，不应该遗留 Pending Request
    #[tokio::test]
    async fn should_cleanup_pending_on_timeout() {
        let data_dir = test_data_dir();
        let supervisor = RuntimeSupervisor::start_dev(&data_dir).unwrap();
        let client = supervisor.client();

        // 零时长用于确定性测试截止时间，
        // 不依赖操作系统调度速度
        let result = client
            .request("runtime.ping", json!({}), Duration::ZERO)
            .await;

        assert!(result.is_err());

        assert!(result.unwrap_err().contains("IPC_TIMEOUT"));

        // 超时后必须清理请求关联表
        assert!(client.pending.lock().unwrap().is_empty());

        supervisor.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // 3. Node.js 异常退出后，所有等待者都应失败
    #[tokio::test]
    async fn should_fail_pending_when_runtime_crashes() {
        let data_dir = test_data_dir();
        let mut supervisor = RuntimeSupervisor::start_dev(&data_dir).unwrap();
        let client = supervisor.client();

        // 注入一个测试用等待者，用于验证连接中断清理。
        // 不需要新增生产环境的模拟 Handler。
        let (sender, receiver) = oneshot::channel();

        client
            .pending
            .lock()
            .unwrap()
            .insert("test-pending".into(), sender);

        // 模拟 Node.js Runtime 意外终止
        supervisor.child.kill().await.unwrap();

        // Reader 必须发现 stdout 关闭并通知等待者
        let response = timeout(Duration::from_secs(5), receiver)
            .await
            .expect("Reader did not notify pending request")
            .expect("Pending response channel dropped");

        assert!(response.is_err());

        // 不应再接受新请求
        assert!(client.closed.load(Ordering::Acquire));

        assert!(
            client
                .request("runtime.ping", json!({}), Duration::from_secs(1),)
                .await
                .is_err()
        );

        supervisor.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // 4. Event 应该通过广播通道到达订阅者
    #[tokio::test]
    async fn should_broadcast_runtime_events() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));

        let (events, _) = broadcast::channel(8);
        let mut subscriber = events.subscribe();

        let line = json!({
            "version": 1,
            "kind": "event",
            "event": "task.progress",
            "sequence": 1,
            "data": {
                "taskId": "test-task",
                "progress": 50
            }
        })
        .to_string();

        route_message(&line, &pending, &events).unwrap();

        let received = timeout(Duration::from_secs(1), subscriber.recv())
            .await
            .expect("Event delivery timed out")
            .expect("Event channel closed");

        assert_eq!(received.event, "task.progress");
        assert_eq!(received.sequence, 1);
        assert_eq!(received.data["progress"], 50);
    }
}
