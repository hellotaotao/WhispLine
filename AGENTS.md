# Repository Guidelines

`CLAUDE.md` is the maintained guide to this repository: architecture, the invariants to respect, and
where each topic is documented. Read it before changing code. This file is a short summary for agents
that don't load `CLAUDE.md`.

## Project structure
SayType is a **Tauri 2 + Rust** app (Electron was removed; don't reintroduce it). The Rust backend lives in `src-tauri/src/`; the frontend is plain HTML/CSS/JS with no bundler, in `src/views/`. App config: `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`; macOS entitlements in `build/`; icons in `src-tauri/icons/` and `assets/`.

## Build, test, and development commands
- `npm install` installs JS tooling (only `@tauri-apps/cli`). Building also needs a Rust toolchain (`rustup`).
- `npm run dev` (or `npm start`) launches `tauri dev`.
- `npm test` runs every `src/views/*.test.mjs` and `scripts/*.test.mjs`, the same entry point CI uses.
- `cargo test --manifest-path src-tauri/Cargo.toml` runs the Rust unit tests.
- `npm run build` builds for the host; `npm run build:mac`, `build:win` and `build:linux` target a platform.

## Coding style
Match the surrounding code: 2-space indentation in Rust and JS, semicolons in JS, descriptive names. Keep UI strings in `src/views/i18n.js`. Renderer↔backend communication goes through `src/views/ipc-bridge.js` (`window.__SAYTYPE_IPC__`); don't call Tauri APIs directly from window scripts. A new IPC command is wired in three places (`commands.rs`, the `invoke_handler!` list in `lib.rs`, the `ipc-bridge.js` maps), and `scripts/ipc-contract.test.mjs` enforces it.

## Platforms
Platform-specific code lives behind `src-tauri/src/platform/` with `#[cfg(target_os)]` gates. Text insertion and the global hotkey are implemented for macOS, Windows and Linux, but only macOS is verified on real machines. Note platform-specific behavior in commits and PRs.

## Commits and pull requests
Use short imperative messages with conventional prefixes (`feat:`, `fix(settings):`, `docs:`). Include testing notes, and screenshots for UI changes. Call out macOS Accessibility/Microphone permission changes explicitly.

## Security and configuration
API keys are entered in the app and stored in its JSON config via `settings.rs`; never commit secrets. `TODO.md` is a local, gitignored planning file; don't commit it. If you change permissions or entitlements, update `build/entitlements.mac.plist` and document new OS prompts in `README.md`.
