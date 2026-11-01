fn main() {
    trm_app_protocol::codegen::generate(
        std::path::Path::new("src"),
        &std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()),
    );
    tauri_build::build()
}
