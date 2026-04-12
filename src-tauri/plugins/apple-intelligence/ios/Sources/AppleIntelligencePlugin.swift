// AppleIntelligencePlugin.swift
//
// Tauri mobile plugin bridging Apple's Foundation Models framework
// into the Interactive Sphere app for on-device LLM inference.
//
// The on-device model (~3B parameters) runs entirely on the device's
// Neural Engine — no network, no API key, no per-token cost. It has a
// 4096-token context window (input + output combined), which is why
// Phase 3's pre-search injects only the top 5 relevant datasets into
// the user message instead of the full 170-dataset catalog.
//
// References:
//   - https://developer.apple.com/documentation/FoundationModels
//   - https://developer.apple.com/videos/play/wwdc2025/286/
//   - TN3193: Managing the on-device foundation model's context window
//   - docs/MOBILE_APP_PLAN.md Phase 4

import Tauri
import WebKit

#if canImport(FoundationModels)
import FoundationModels
#endif

class AppleIntelligencePlugin: Plugin {

    // MARK: - is_available

    /// Check whether the on-device Foundation Model is available.
    ///
    /// Returns `{ "available": true }` when:
    /// - iOS 26+ or macOS 26+ is installed
    /// - The device supports Apple Intelligence (A17 Pro+, M-series)
    /// - Apple Intelligence is enabled in Settings
    ///
    /// Invoked via: `invoke('plugin:apple-intelligence|is_available')`
    @objc public func isAvailable(_ invoke: Invoke) {
        #if canImport(FoundationModels)
        if #available(iOS 26, macOS 26, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                invoke.resolve([
                    "available": true
                ])
            case .unavailable(let reason):
                invoke.resolve([
                    "available": false,
                    "reason": String(describing: reason)
                ])
            @unknown default:
                invoke.resolve([
                    "available": false,
                    "reason": "Unknown availability state"
                ])
            }
        } else {
            invoke.resolve([
                "available": false,
                "reason": "Requires iOS 26+ or macOS 26+"
            ])
        }
        #else
        invoke.resolve([
            "available": false,
            "reason": "FoundationModels framework not available (requires Xcode 26+ SDK)"
        ])
        #endif
    }

    // MARK: - chat

    /// Start a streaming chat session with the on-device model.
    ///
    /// Expected args (JSON):
    /// - `sessionId: String` — unique session identifier for event filtering
    /// - `messages: [{ role, content }]` — conversation history
    /// - `tools: [{ name, description, parameters }]` — available tools (unused in v1)
    ///
    /// Streams response tokens back to JS via Tauri events:
    /// - `ai-delta { session_id, text }` — text fragment
    /// - `ai-done { session_id }` — stream complete
    /// - `ai-error { session_id, message }` — error
    ///
    /// V1 note: tools are accepted in the interface for forward compatibility
    /// but not registered with the LanguageModelSession. Phase 3's pre-search
    /// injects [RELEVANT DATASETS] into the user message, which the on-device
    /// model reads to make dataset recommendations. Tool calling can be added
    /// in a future iteration using Swift Tool protocol + @Generable structs.
    @objc public func chat(_ invoke: Invoke) {
        #if canImport(FoundationModels)
        guard #available(iOS 26, macOS 26, *) else {
            emitError(invoke, sessionId: "unknown", message: "Requires iOS 26+ or macOS 26+")
            return
        }

        // Parse arguments from the invoke payload
        guard let args = invoke.data as? [String: Any],
              let sessionId = args["sessionId"] as? String,
              let messagesRaw = args["messages"] as? [[String: Any]] else {
            emitError(invoke, sessionId: "unknown", message: "Invalid arguments: expected sessionId and messages")
            return
        }

        // Extract system prompt and build the user prompt from conversation history
        let (systemPrompt, userPrompt) = buildPrompts(from: messagesRaw)

        // Run the Foundation Models session asynchronously
        Task {
            do {
                // Create a session with the system prompt (no tools in v1)
                let session = LanguageModelSession {
                    systemPrompt
                }

                // Stream the response token by token
                let stream = session.streamResponse(to: userPrompt)
                for try await partialResponse in stream {
                    // Emit each text fragment as an ai-delta event
                    self.trigger("ai-delta", data: [
                        "session_id": sessionId,
                        "text": String(describing: partialResponse)
                    ])
                }

                // Stream complete
                self.trigger("ai-done", data: [
                    "session_id": sessionId
                ])

            } catch {
                // Handle errors — including context window exceeded
                let message: String
                if let genError = error as? LanguageModelSession.GenerationError {
                    message = "Generation error: \(genError.localizedDescription)"
                } else {
                    message = error.localizedDescription
                }
                self.trigger("ai-error", data: [
                    "session_id": sessionId,
                    "message": message
                ])
            }

            invoke.resolve()
        }
        #else
        let sessionId = (invoke.data as? [String: Any])?["sessionId"] as? String ?? "unknown"
        emitError(invoke, sessionId: sessionId, message: "FoundationModels framework not available")
        #endif
    }

    // MARK: - Helpers

    /// Build system prompt and user prompt from the messages array.
    ///
    /// The messages array from the JS side has the shape:
    ///   [{ role: "system", content: "..." }, { role: "user", content: "..." }, ...]
    ///
    /// We extract the system prompt from the first system message and
    /// concatenate all subsequent messages into a formatted user prompt
    /// that preserves the conversation structure.
    private func buildPrompts(from messages: [[String: Any]]) -> (systemPrompt: String, userPrompt: String) {
        var systemPrompt = ""
        var conversationParts: [String] = []

        for msg in messages {
            let role = msg["role"] as? String ?? "user"
            let content = msg["content"] as? String ?? ""

            if role == "system" {
                systemPrompt = content
            } else if role == "user" {
                conversationParts.append(content)
            } else if role == "assistant" {
                conversationParts.append("[Previous response]: \(content)")
            } else if role == "tool" {
                // Tool results from the multi-turn loop (Phase 3).
                // Include as context for the model.
                conversationParts.append("[Tool result]: \(content)")
            }
        }

        let userPrompt = conversationParts.joined(separator: "\n\n")
        return (systemPrompt, userPrompt)
    }

    /// Emit an ai-error event and resolve the invoke.
    private func emitError(_ invoke: Invoke, sessionId: String, message: String) {
        trigger("ai-error", data: [
            "session_id": sessionId,
            "message": message
        ])
        invoke.resolve()
    }
}
