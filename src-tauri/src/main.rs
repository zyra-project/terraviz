// Desktop binary entry point. Mobile (iOS / Android) does not use this file —
// it loads `interactive_sphere_lib::run` directly via `tauri::mobile_entry_point`.

// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    interactive_sphere_lib::run()
}
