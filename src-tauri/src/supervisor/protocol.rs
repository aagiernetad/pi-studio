use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use std::fmt;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_IDENTIFIER_LENGTH: usize = 128;

// ==========================================
// 1. 协议错误
// ==========================================

#[derive(Debug)]
pub enum ProtocolError {
    InvalidJson(String),
    InvalidMessage(String),
    UnsupportedVersion(u32),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(message) => {
                write!(f, "Invalid JSON: {message}")
            }
            Self::InvalidMessage(message) => {
                write!(f, "Invalid IPC message: {message}")
            }
            Self::UnsupportedVersion(version) => {
                write!(f, "Unsupported protocol version: {version}")
            }
        }
    }
}

impl std::error::Error for ProtocolError {}

// ==========================================
// 2. Response 数据结构
// ==========================================

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeError {
    pub code: String,
    pub message: String,
    pub retryable: bool,

    #[serde(default)]
    pub details: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeResponse {
    pub version: u32,
    pub kind: String,
    pub id: String,
    pub success: bool,

    #[serde(default)]
    pub result: Option<Value>,

    #[serde(default)]
    pub error: Option<RuntimeError>,
}

// ==========================================
// 3. Event 数据结构
// ==========================================

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeEvent {
    pub version: u32,
    pub kind: String,
    pub event: String,
    pub sequence: u64,
    pub data: Value,
}

// ==========================================
// 4. 统一消息类型
// ==========================================

#[derive(Debug)]
pub enum RuntimeOutboundMessage {
    Response(RuntimeResponse),
    Event(RuntimeEvent),
}

// ==========================================
// 5. 基础字段校验
// ==========================================

fn valid_identifier(value: &str) -> bool {
    let length = value.encode_utf16().count();

    (1..=MAX_IDENTIFIER_LENGTH).contains(&length)
}

/**
 * 与 Node.js Handler Registry 的方法命名规则保持一致：
 *
 * ^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$
 */
fn valid_method(value: &str) -> bool {
    let mut parts = value.split(['.', '-']);

    let Some(first) = parts.next() else {
        return false;
    };

    let first_valid = first.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && first
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());

    first_valid
        && parts.all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn validate_version(version: u32) -> Result<(), ProtocolError> {
    if version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(version));
    }

    Ok(())
}

// ==========================================
// 6. Rust -> Node.js Request 编码
// ==========================================

pub fn encode_request(id: &str, method: &str, params: Value) -> Result<String, ProtocolError> {
    if !valid_identifier(id) {
        return Err(ProtocolError::InvalidMessage("Invalid request ID".into()));
    }

    if !valid_method(method) {
        return Err(ProtocolError::InvalidMessage(
            "Invalid request method".into(),
        ));
    }

    if !params.is_object() {
        return Err(ProtocolError::InvalidMessage(
            "Request params must be a JSON object".into(),
        ));
    }

    let request = json!({
        "version": PROTOCOL_VERSION,
        "kind": "request",
        "id": id,
        "method": method,
        "params": params,
    });

    let encoded = serde_json::to_string(&request)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;

    Ok(format!("{encoded}\n"))
}

// ==========================================
// 7. Node.js -> Rust 消息解析
// ==========================================

pub fn parse_outbound_line(line: &str) -> Result<RuntimeOutboundMessage, ProtocolError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;

    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| ProtocolError::InvalidMessage("Missing message kind".into()))?;

    match kind {
        "response" => parse_response(value),
        "event" => parse_event(value),
        _ => Err(ProtocolError::InvalidMessage(format!(
            "Unknown message kind: {kind}"
        ))),
    }
}

// ==========================================
// 8. Response 校验
// ==========================================

fn parse_response(value: Value) -> Result<RuntimeOutboundMessage, ProtocolError> {
    let has_result = value.get("result").is_some();
    let has_error = value.get("error").is_some();

    let response: RuntimeResponse = serde_json::from_value(value)
        .map_err(|error| ProtocolError::InvalidMessage(error.to_string()))?;

    validate_version(response.version)?;

    if response.kind != "response" {
        return Err(ProtocolError::InvalidMessage(
            "Invalid response kind".into(),
        ));
    }

    if !valid_identifier(&response.id) {
        return Err(ProtocolError::InvalidMessage("Invalid response ID".into()));
    }

    if response.success {
        let valid_result = response.result.as_ref().is_some_and(Value::is_object);

        if !has_result || has_error || !valid_result {
            return Err(ProtocolError::InvalidMessage(
                "Invalid successful response".into(),
            ));
        }
    } else {
        if has_result || !has_error {
            return Err(ProtocolError::InvalidMessage(
                "Invalid failed response".into(),
            ));
        }

        let error = response
            .error
            .as_ref()
            .ok_or_else(|| ProtocolError::InvalidMessage("Missing error payload".into()))?;

        if error.code.is_empty() || error.message.is_empty() {
            return Err(ProtocolError::InvalidMessage(
                "Invalid error payload".into(),
            ));
        }

        if error
            .details
            .as_ref()
            .is_some_and(|details| !details.is_object())
        {
            return Err(ProtocolError::InvalidMessage(
                "Error details must be an object".into(),
            ));
        }
    }

    Ok(RuntimeOutboundMessage::Response(response))
}

// ==========================================
// 9. Event 校验
// ==========================================

fn parse_event(value: Value) -> Result<RuntimeOutboundMessage, ProtocolError> {
    let event: RuntimeEvent = serde_json::from_value(value)
        .map_err(|error| ProtocolError::InvalidMessage(error.to_string()))?;

    validate_version(event.version)?;

    if event.kind != "event" {
        return Err(ProtocolError::InvalidMessage("Invalid event kind".into()));
    }

    if !valid_method(&event.event) {
        return Err(ProtocolError::InvalidMessage("Invalid event name".into()));
    }

    if !event.data.is_object() {
        return Err(ProtocolError::InvalidMessage(
            "Event data must be an object".into(),
        ));
    }

    Ok(RuntimeOutboundMessage::Event(event))
}

// ==========================================
// 10. 单元测试
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_encode_request() {
        let line = encode_request(
            "req-001",
            "runtime.ping",
            json!({"message": "Hello Pi Studio"}),
        )
        .unwrap();

        assert!(line.ends_with('\n'));

        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["version"], 1);
        assert_eq!(value["kind"], "request");
        assert_eq!(value["id"], "req-001");
        assert_eq!(value["method"], "runtime.ping");
    }

    #[test]
    fn should_reject_invalid_request_fields() {
        assert!(encode_request("req-001", "Runtime.Ping", json!({})).is_err());

        assert!(encode_request("req-001", "runtime..ping", json!({})).is_err());

        assert!(encode_request("req-001", "runtime.ping", json!("invalid")).is_err());
    }

    #[test]
    fn should_parse_success_and_failure_responses() {
        let success = json!({
            "version": 1,
            "kind": "response",
            "id": "req-001",
            "success": true,
            "result": {"message": "pong"}
        })
        .to_string();

        let failure = json!({
            "version": 1,
            "kind": "response",
            "id": "req-002",
            "success": false,
            "error": {
                "code": "UNKNOWN_METHOD",
                "message": "Unknown method",
                "retryable": false
            }
        })
        .to_string();

        assert!(matches!(
            parse_outbound_line(&success),
            Ok(RuntimeOutboundMessage::Response(_))
        ));

        assert!(matches!(
            parse_outbound_line(&failure),
            Ok(RuntimeOutboundMessage::Response(_))
        ));
    }

    #[test]
    fn should_parse_event() {
        let line = json!({
            "version": 1,
            "kind": "event",
            "event": "task.progress",
            "sequence": 1,
            "data": {
                "taskId": "task-001",
                "progress": 30
            }
        })
        .to_string();

        assert!(matches!(
            parse_outbound_line(&line),
            Ok(RuntimeOutboundMessage::Event(_))
        ));
    }

    #[test]
    fn should_reject_invalid_messages() {
        let invalid_messages = [
            "not-json",
            r#"{"version":2,"kind":"response","id":"req-001","success":true,"result":{}}"#,
            r#"{"version":1,"kind":"unknown"}"#,
            r#"{"version":1,"kind":"response","id":"req-001","success":true,"error":{"code":"ERR","message":"Error","retryable":false}}"#,
            r#"{"version":1,"kind":"event","event":"task.progress","sequence":-1,"data":{}}"#,
            r#"{"version":1,"kind":"event","event":"task.progress","sequence":1,"data":"invalid"}"#,
        ];

        for line in invalid_messages {
            assert!(parse_outbound_line(line).is_err(), "Should reject: {line}");
        }
    }
}
