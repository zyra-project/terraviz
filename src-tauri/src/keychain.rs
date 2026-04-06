use keyring::Entry;

const SERVICE: &str = "org.zyra-project.interactive-sphere";
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
