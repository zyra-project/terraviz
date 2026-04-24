// LLM API key storage. Desktop platforms (macOS, Windows, Linux) and iOS use
// the OS keychain via the `keyring` crate. Android has no `keyring` backend
// yet — see docs/MOBILE_APP_PLAN.md for the deferred secure-storage TODO. The
// Android stub is a no-op that succeeds silently so the frontend's
// `get_api_key` / `set_api_key` calls don't spam warnings.

#[cfg(not(target_os = "android"))]
pub use real::*;

#[cfg(target_os = "android")]
pub use stub::*;

#[cfg(not(target_os = "android"))]
mod real {
    use keyring::Entry;

    const SERVICE: &str = "org.zyra-project.terraviz";
    const ACCOUNT: &str = "llm-api-key";

    /// Read the LLM API key from the OS keychain.
    /// Returns an empty string if no key is stored.
    #[tauri::command]
    pub fn get_api_key() -> Result<String, String> {
        let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(key) => Ok(key),
            Err(keyring::Error::NoEntry) => Ok(String::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Store the LLM API key in the OS keychain.
    /// Passing an empty string deletes the entry.
    #[tauri::command]
    pub fn set_api_key(key: String) -> Result<(), String> {
        let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
        if key.is_empty() {
            match entry.delete_credential() {
                Ok(()) => Ok(()),
                Err(keyring::Error::NoEntry) => Ok(()), // already empty
                Err(e) => Err(e.to_string()),
            }
        } else {
            entry.set_password(&key).map_err(|e| e.to_string())
        }
    }
}

#[cfg(target_os = "android")]
mod stub {
    // Error message the frontend recognises (via try/catch) and falls back
    // to localStorage storage on. See saveConfig() in docentService.ts.
    const UNSUPPORTED: &str = "keychain unsupported on android";

    /// Android stub — no secure storage backend wired up yet. Returns an
    /// explicit error so the frontend's saveConfig() knows to fall back to
    /// plaintext localStorage instead of silently losing the API key.
    /// Tracked in MOBILE_APP_PLAN.md.
    #[tauri::command]
    pub fn get_api_key() -> Result<String, String> {
        Err(UNSUPPORTED.to_string())
    }

    /// Android stub — returns an explicit error so the frontend keeps the
    /// API key in localStorage as a fallback. Tracked in MOBILE_APP_PLAN.md.
    #[tauri::command]
    pub fn set_api_key(_key: String) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
}
