use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tauri::{Emitter, Manager, State};
use tokio::sync::oneshot;

pub mod supervisor;

use supervisor::{
    protocol::RuntimeResponse,
    transport::{RuntimeClient, RuntimeSupervisor},
};

// ==========================================
// 1. 应用级 Runtime 状态
// ==========================================

struct RuntimeState {
    client: RuntimeClient,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    closing: AtomicBool,
}

// ==========================================
// 2. 统一处理 Runtime 响应
// ==========================================

fn response_result(response: RuntimeResponse) -> Result<Value, String> {
    if response.success {
        response
            .result
            .ok_or_else(|| "Runtime result is missing".into())
    } else {
        let error = response.error.ok_or("Runtime error payload is missing")?;

        Err(format!("{}: {}", error.code, error.message))
    }
}

/// 所有 Tauri Commands 复用同一个 RuntimeClient。
/// 不创建新的 Node.js 进程，也不直接访问 SQLite。
async fn call_runtime(client: RuntimeClient, method: &str, params: Value) -> Result<Value, String> {
    let response = client
        .request(method, params, Duration::from_secs(15))
        .await?;

    response_result(response)
}

// ==========================================
// 3. 基础 Runtime Commands
// ==========================================

#[tauri::command]
async fn runtime_ping(state: State<'_, RuntimeState>, message: String) -> Result<Value, String> {
    call_runtime(
        state.client.clone(),
        "runtime.ping",
        json!({ "message": message }),
    )
    .await
}

#[tauri::command]
async fn runtime_info(state: State<'_, RuntimeState>) -> Result<Value, String> {
    call_runtime(state.client.clone(), "runtime.info", json!({})).await
}

// ==========================================
// 4. Conversation Commands
// ==========================================

/// 创建用户会话。
///
/// request_id 是业务幂等键，不等于 JSONL IPC 请求 ID。
#[tauri::command]
async fn conversation_create(
    state: State<'_, RuntimeState>,
    request_id: String,
    title: Option<String>,
) -> Result<Value, String> {
    let mut params = json!({
        "requestId": request_id
    });

    if let Some(title) = title {
        params["title"] = json!(title);
    }

    call_runtime(state.client.clone(), "conversation.create", params).await
}

/// 列出用户可见的会话。
#[tauri::command]
async fn conversation_list(
    state: State<'_, RuntimeState>,
    limit: Option<u32>,
    before_id: Option<i64>,
) -> Result<Value, String> {
    let mut params = json!({
        "limit": limit.unwrap_or(20)
    });

    if let Some(before_id) = before_id {
        params["beforeId"] = json!(before_id);
    }

    call_runtime(state.client.clone(), "conversation.list", params).await
}

/// 根据 ID 查询用户可见的会话。
#[tauri::command]
async fn conversation_get(
    state: State<'_, RuntimeState>,
    conversation_id: i64,
) -> Result<Value, String> {
    call_runtime(
        state.client.clone(),
        "conversation.get",
        json!({
            "conversationId": conversation_id
        }),
    )
    .await
}

/// 分页读取用户会话的 Transcript。
///
/// cursor 是 Durable 生成的不透明分页游标。
/// Rust 不修改游标结构。
#[tauri::command]
async fn conversation_entries(
    state: State<'_, RuntimeState>,
    conversation_id: i64,
    limit: Option<u32>,
    cursor: Option<Value>,
) -> Result<Value, String> {
    let mut params = json!({
        "conversationId": conversation_id,
        "limit": limit.unwrap_or(10)
    });

    if let Some(cursor) = cursor {
        params["cursor"] = cursor;
    }

    call_runtime(state.client.clone(), "conversation.entries", params).await
}

// ==========================================
// 5. Tauri 应用入口
// ==========================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 获取 Tauri 应用数据目录
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;

            std::fs::create_dir_all(&app_data_dir)?;

            // 启动 Node.js Runtime
            let supervisor = tauri::async_runtime::block_on(async {
                RuntimeSupervisor::start_dev(&app_data_dir)
            })
            .map_err(std::io::Error::other)?;

            let client = supervisor.client();

            // ==================================
            // Node.js -> React 事件桥接
            // ==================================

            let mut events = client.subscribe();
            let event_app = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            if let Err(error) = event_app.emit("runtime-event", event.as_ref()) {
                                eprintln!("[supervisor] Event emit failed: {error}");
                            }
                        }

                        Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                            eprintln!("[supervisor] Missed {count} runtime events");
                        }

                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // ==================================
            // 退出时优雅关闭 Node.js
            // ==================================

            let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

            let shutdown_app = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                if shutdown_rx.await.is_ok() {
                    if let Err(error) = supervisor.shutdown().await {
                        eprintln!("[supervisor] Shutdown failed: {error}");
                    }

                    shutdown_app.exit(0);
                }
            });

            // 注册全局 Runtime 状态
            app.manage(RuntimeState {
                client,
                shutdown: Mutex::new(Some(shutdown_tx)),
                closing: AtomicBool::new(false),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_ping,
            runtime_info,
            conversation_create,
            conversation_list,
            conversation_get,
            conversation_entries,
        ])
        .build(tauri::generate_context!())
        .expect("Failed to build Pi Studio");

    // ======================================
    // 6. 拦截退出，等待 Runtime 清理
    // ======================================

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if let Some(state) = app_handle.try_state::<RuntimeState>() {
                if !state.closing.swap(true, Ordering::AcqRel) {
                    api.prevent_exit();

                    if let Ok(mut shutdown) = state.shutdown.lock() {
                        if let Some(sender) = shutdown.take() {
                            if sender.send(()).is_err() {
                                app_handle.exit(0);
                            }
                        } else {
                            app_handle.exit(0);
                        }
                    } else {
                        app_handle.exit(0);
                    }
                }
            }
        }
    });
}
