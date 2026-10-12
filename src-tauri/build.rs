fn main() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let package_json = manifest_dir.join("../package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());

    let text = std::fs::read_to_string(&package_json).expect("read package.json");
    let version = app_version(&text);
    let cargo = std::env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION");
    if version != cargo {
        panic!(
            "package.json version is {version}, but Cargo.toml is {cargo}. Edit package.json, then run npm run tauri so the Cargo version follows it."
        );
    }

    tauri_build::build()
}

fn app_version(package_json: &str) -> String {
    for line in package_json.lines() {
        let trimmed = line.trim().trim_end_matches(',');
        let Some(rest) = trimmed.strip_prefix("\"version\"") else {
            continue;
        };
        let Some(rest) = rest.trim().strip_prefix(':') else {
            continue;
        };
        let value = rest.trim().trim_matches('"');
        if !value.is_empty() {
            return value.to_string();
        }
    }
    panic!("package.json is missing a version");
}
