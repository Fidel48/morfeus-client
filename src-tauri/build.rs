fn main() {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        println!("cargo:rerun-if-changed=src/mac_speech.swift");
        println!("cargo:rerun-if-changed=src/mac_audio.m");
        println!("cargo:rerun-if-changed=Info.plist");

        let out_dir = std::env::var("OUT_DIR").unwrap();

        // 1. Compile mac_speech swift binary with embedded Info.plist for TCC Speech Recognition permission
        let speech_target = format!("{}/mac_speech", out_dir);
        let status = Command::new("swiftc")
            .args([
                "src/mac_speech.swift",
                "-O",
                "-Xlinker",
                "-sectcreate",
                "-Xlinker",
                "__TEXT",
                "-Xlinker",
                "__info_plist",
                "-Xlinker",
                "Info.plist",
                "-o",
                &speech_target,
            ])
            .status();

        if let Ok(s) = status {
            if s.success() {
                println!("cargo:rustc-env=MAC_SPEECH_BIN={}", speech_target);
            }
        }

        // 2. Compile mac_audio.m for AVFoundation TCC microphone permission
        cc::Build::new()
            .file("src/mac_audio.m")
            .flag("-fobjc-arc")
            .compile("mac_audio");

        println!("cargo:rustc-link-lib=framework=AVFoundation");
    }
    tauri_build::build();
}
