//! Tauri Plugin: Apple Intelligence
//!
//! Bridges Apple's Foundation Models framework (iOS 26+ / macOS 26+) into the
//! Tauri app so the Orbit docent can run inference on-device without a server.
//!
//! Architecture:
//!   JS calls `invoke('plugin:apple-intelligence|is_available')` or
//!   `invoke('plugin:apple-intelligence|chat', { sessionId, messages, tools })`
//!   → Rust commands below → on iOS, delegates to Swift via the mobile plugin
//!   bridge → Swift calls `SystemLanguageModel` and streams events back via
//!   `app.emit("ai-delta", ...)` etc.
//!
//! On non-iOS platforms (desktop Linux/Windows, Android), both commands return
//! graceful "not available" responses so the frontend falls back to the HTTP
//! provider automatically.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Emitter, Runtime,
};

// --- Types shared between Rust and JS ---

#[derive(Debug, Serialize)]
pub struct AvailabilityResult {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

// --- Event payloads emitted during streaming ---

#[derive(Clone, Serialize)]
pub struct DeltaPayload {
    pub session_id: String,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct ToolCallPayload {
    pub session_id: String,
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Clone, Serialize)]
pub struct DonePayload {
    pub session_id: String,
}

#[derive(Clone, Serialize)]
pub struct ErrorPayload {
    pub session_id: String,
    pub message: String,
}

// --- Commands ---

/// Check whether the on-device Foundation Models are available.
///
/// Currently iOS-only. On iOS, this delegates to the Swift plugin which
/// checks `SystemLanguageModel.default.availability`. macOS support
/// (via a similar Swift plugin) is a future extension. On all other
/// platforms, returns `{ available: false, reason: "..." }`.
#[tauri::command]
async fn is_available() -> AvailabilityResult {
    // Currently only iOS has the Swift plugin bridge. macOS desktop
    // could use Foundation Models too but needs its own plugin path.
    #[cfg(not(target_os = "ios"))]
    {
        AvailabilityResult {
            available: false,
            reason: Some("Apple Intelligence is currently only supported on iOS".to_string()),
        }
    }

    #[cfg(target_os = "ios")]
    {
        // TODO: delegate to Swift plugin via mobile bridge
        // For now, return unavailable until the Swift implementation lands.
        AvailabilityResult {
            available: false,
            reason: Some("Apple Intelligence Swift plugin not yet implemented".to_string()),
        }
    }
}

/// Start a streaming chat session with the on-device model.
///
/// The Swift plugin creates a `LanguageModelSession`, feeds it the messages
/// and tool definitions, and streams the response back via Tauri events:
///   - `ai-delta` with `{ session_id, text }`
///   - `ai-tool-call` with `{ session_id, id, name, arguments }`
///   - `ai-done` with `{ session_id }`
///   - `ai-error` with `{ session_id, message }`
///
/// The JS provider (`appleIntelligenceProvider.ts`) listens for these events
/// and yields `StreamChunk`s to `docentService.processMessage`.
#[tauri::command]
async fn chat<R: Runtime>(
    app: tauri::AppHandle<R>,
    session_id: String,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolDef>,
) -> Result<(), String> {
    // On non-iOS platforms, immediately emit an error event.
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app.emit("ai-error", ErrorPayload {
            session_id,
            message: "Apple Intelligence is only available on iOS".to_string(),
        });
        return Ok(());
    }

    #[cfg(target_os = "ios")]
    {
        // On iOS, Tauri's mobile plugin bridge routes the invoke directly
        // to AppleIntelligencePlugin.swift's chat() method, which handles
        // LanguageModelSession creation and event streaming. This Rust
        // block is a defensive fallback that should not normally execute —
        // if it does, the Swift plugin failed to register or intercept
        // the command.
        let _ = app.emit("ai-error", ErrorPayload {
            session_id,
            message: "Apple Intelligence: Swift plugin did not handle this command (bridge error)".to_string(),
        });
        Ok(())
    }
}

// --- Plugin registration ---

/// Build the `apple-intelligence` Tauri plugin.
///
/// Register this in `src-tauri/src/lib.rs`:
/// ```rust
/// .plugin(tauri_plugin_apple_intelligence::init())
/// ```
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apple-intelligence")
        .invoke_handler(tauri::generate_handler![is_available, chat])
        .build()
}
