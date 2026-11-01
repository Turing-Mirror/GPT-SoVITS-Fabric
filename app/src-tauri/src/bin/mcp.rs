fn main() {
    if let Err(error) = trm_app_protocol::mcp::run(
        "com.turingmirror.gpt-sovits-fabric",
        if cfg!(windows) {
            "gpt-sovits-fabric.exe"
        } else {
            "gpt-sovits-fabric"
        },
    ) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
