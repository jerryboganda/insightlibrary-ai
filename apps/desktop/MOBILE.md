# Mobile (iOS + Android)

The app is **mobile-ready**: one Svelte SPA renders in the mobile WebView, and the
Rust shell already carries everything the mobile targets need:

- `src-tauri/Cargo.toml` → `crate-type = ["staticlib", "cdylib", "rlib"]` (mobile FFI)
- `src-tauri/src/lib.rs` → `#[cfg_attr(mobile, tauri::mobile_entry_point)] pub fn run()`
- desktop-only plugins gated behind `#[cfg(desktop)]` (window-state)
- `tauri.conf.json` → `bundle.targets: "all"`, and app/android + ios icon sets are
  already generated under `src-tauri/gen/` icon folders

The mobile toolchains can't be provisioned in every environment (iOS **requires macOS +
Xcode**; Android requires the SDK/NDK), so initialization is a one-time local step.

## Prerequisites

- **Android**: Android Studio, SDK Platform + NDK, `JAVA_HOME`, `ANDROID_HOME`/`NDK_HOME`.
  Rust targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- **iOS** (macOS only): Xcode + command-line tools.
  Rust targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`

See https://v2.tauri.app/start/prerequisites/#mobile-targets.

## Initialize (once)

```bash
cd apps/desktop
pnpm tauri android init      # scaffolds src-tauri/gen/android
pnpm tauri ios init          # macOS only → src-tauri/gen/apple
```

## Develop / run on device or emulator

```bash
pnpm tauri android dev       # builds + deploys to a running emulator/device
pnpm tauri ios dev           # macOS only
```

## Build release artifacts

```bash
pnpm tauri android build     # → .apk / .aab
pnpm tauri ios build         # macOS only → .ipa
```

## Mobile UI scope

Ship the focused subset first — **reader, search, study, notifications** — which are
usable at phone widths. The dense admin suite (users, ontology editor, settings,
FinOps tables) stays desktop/web. Gate admin routes by viewport/platform when the
mobile subset ships; the shared `$lib/platform` adapter (`isTauri()` + capability
interface) is the seam for any native-vs-web behavior differences.
