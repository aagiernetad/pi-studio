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

// ==========================================
// 3. Tauri Commands
// ==========================================

#[tauri::command]
async fn runtime_ping(state: State<'_, RuntimeState>, message: String) -> Result<Value, String> {
    let client = state.client.clone();

    let response = client
        .request(
            "runtime.ping",
            json!({ "message": message }),
            Duration::from_secs(15),
        )
        .await?;

    response_result(response)
}

#[tauri::command]
async fn runtime_info(state: State<'_, RuntimeState>) -> Result<Value, String> {
    let client = state.client.clone();

    let response = client
        .request("runtime.info", json!({}), Duration::from_secs(15))
        .await?;

    response_result(response)
}

// ==========================================
// 4. Tauri 应用入口
// ==========================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 在 Tokio 上下文内启动 Node.js Runtime
            let supervisor =
                tauri::async_runtime::block_on(async { RuntimeSupervisor::start_dev() })
                    .map_err(std::io::Error::other)?;

            let client = supervisor.client();

            // ==================================
            // 事件桥接：Node.js -> React
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

                    // Runtime 回收后再退出桌面应用
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
        .invoke_handler(tauri::generate_handler![runtime_ping, runtime_info])
        .build(tauri::generate_context!())
        .expect("Failed to build Pi Studio");

    // ======================================
    // 5. 拦截退出，等待 Runtime 清理
    // ======================================

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if let Some(state) = app_handle.try_state::<RuntimeState>() {
                // 只有第一次退出请求需要等待清理
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
