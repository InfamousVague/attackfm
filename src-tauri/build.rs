fn main() {
    // carplay.rs imports afm_carplay_set_library / afm_carplay_set_now_playing,
    // which live in gen/apple/Sources/app/carplay.m and only exist once Xcode
    // links the final app binary against the staticlib. Cargo also builds the
    // cdylib crate-type for iOS, and a cdylib must resolve every symbol at
    // cargo-link time - so let that one artifact (which nothing ships; iOS
    // uses the staticlib, Android builds its own cdylib without the iOS-only
    // extern block) leave symbols for the host binary to provide. The shipped
    // app still gets full resolution at the Xcode link.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-undefined,dynamic_lookup");
    }
    tauri_build::build()
}
