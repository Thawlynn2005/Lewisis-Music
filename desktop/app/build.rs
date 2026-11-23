// Declares the app's own commands, so each one needs an explicit
// permission in capabilities/ (nothing is allowed by default).
const COMMANDS: &[&str] = &[
    "api",
    "api_upload",
    "pick_songs",
    "pick_folder",
    "import_files",
    "separation_model",
    "install_model",
    "app_info",
    "player_load",
    "player_unload",
    "player_play",
    "player_pause",
    "player_seek",
    "player_volume",
    "player_layers",
    "player_speed",
    "player_reverb",
    "player_loop",
    "player_status",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run the Tauri build script");
}
