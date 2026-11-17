use std::env;

const LIBNODE_DIR_VAR: &str = "TURBOLLM_LIBNODE_DIR";

fn main() {
    napi_build::setup();
    println!("cargo::rerun-if-env-changed={LIBNODE_DIR_VAR}");
    if building_nodejs_mobile_addon() {
        link_libnode();
    }
}

fn building_nodejs_mobile_addon() -> bool {
    env::var_os("CARGO_FEATURE_NODEJS_MOBILE").is_some()
        && env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android")
}

/// nodejs-mobile runs Node inside the app's `libnode.so`, so the addon names it in `DT_NEEDED` and imports
/// `napi_*` from it. `dyn-symbols` would look those up in the app process instead, where they are not visible,
/// and `--as-needed` would then drop the unused `libnode.so` entry.
fn link_libnode() {
    if env::var_os("CARGO_FEATURE_DYN_SYMBOLS").is_some() {
        panic!(
            "the nodejs-mobile feature needs --no-default-features (it must not use dyn-symbols)"
        );
    }
    let libnode_dir = env::var(LIBNODE_DIR_VAR).unwrap_or_else(|_| {
        panic!("the nodejs-mobile feature needs {LIBNODE_DIR_VAR}, a directory holding libnode.so")
    });
    println!("cargo::rustc-link-search=native={libnode_dir}");
    println!("cargo::rustc-link-lib=dylib=node");
}
