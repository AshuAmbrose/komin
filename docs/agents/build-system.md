# 6. Build system

Section 6 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

| Script | Output | Notes |
|---|---|---|
| `scripts/buildLocalization.js` | `dist/localization.build.js` | merges `localization/languages/*.json` (comments stripped) plus `localization/localizationHelpers.js` (defines `l()`). Called by `buildMain`. |
| `scripts/buildMain.js` | `main.build.js` | concatenates in **this order**: `dist/localization.build.js`, `main/windowManagement.js`, `js/util/keyMap.js`, `main/menu.js`, `main/touchbar.js`, `main/registryConfig.js`, `js/util/settings/settingsMain.js`, `main/main.js`, `main/minInternalProtocol.js`, `main/filtering.js`, `main/viewManager.js`, `main/download.js`, `main/UASwitcher.js`, `main/permissionManager.js`, `main/prompt.js`, `main/remoteMenu.js`, `main/remoteActions.js`, `main/keychainService.js`, `js/util/proxy.js`, `main/themeMain.js`, `js/util/userscriptMatching.js`, `main/userscripts.js`, `main/userscriptAPI.js`, `main/userscriptInstall.js`, `js/util/extensionPackages.js`, `main/extensions.js`, `main/extensionAPIs.js`, `main/extensionTabs.js`, `main/extensionPermissions.js` |
| `scripts/buildBrowser.js` | `dist/build.js` then `dist/bundle.js` | browserify of `dist/localization.build.js` + `js/default.js`, with `paths: [root, js/]` and `node: true`; `chokidar` and `write-file-atomic` excluded |
| `scripts/buildBrowserStyles.js` | `dist/bundle.css` | concatenates `css/*.css` (fixed list) + dragula css |
| `scripts/buildPreload.js` | `dist/preload.js` | starts with Ghostery's page watcher (`@ghostery/adblocker-content`'s standalone build `dist/adblocker.umd.min.js`, unchanged, wrapped so its functions land in `ghosteryContent`: the preload is sandboxed and can't `require` packages; section 10.2), then concatenates `js/preload/default.js`, `textExtractor.js`, `readerDetector.js`, `siteUnbreak.js`, `mediaTracker.js`, `userscripts.js`, `webStore.js`, `js/util/settings/settingsPreload.js`, `js/preload/passwordFill.js`, `js/preload/translate.js` |

Consequences of the concatenation:

- **Lint noise:** `npm test` reports many "X is not defined" errors for cross-file globals. These are noise, not bugs. The fork's main-process code often guards with `typeof fn === 'function'`; those guards are harmless.
- **Load order:** top-level code runs in the order above. A function defined in a later file can only be *called* after load (inside handlers), not at load time.
- **One script scope:** all main-process files share one scope, so two files must not declare the same top-level name.

## Packaging

- **`scripts/createPackage.js`** runs electron-builder with a `dir` target into `dist/app/win-unpacked`.
  - `asar: false`, `npmRebuild: false`.
  - `files` excludes `main/` (it's bundled), `scripts/`, `localization/`, `*.md`, maps, `icons/source` and `dist/app`. `js/preload/extensionSupport.js` is loaded from its own file (it isn't in `dist/preload.js`), so `js/` must stay packaged.
  - An `afterPack` hook flips the `GrantFileProtocolExtraPrivileges=false` fuse on the packaged exe.
- **`scripts/buildWindows.js`** produces:
  - `dist/app/Min-v<version>-windows<suffix>.zip`
  - `dist/app/min-<version><suffix>-setup.exe` (Squirrel, `noMsi`)
- **The version comes from `package.json`**: 1.35.7 in commits, while the maintainer's working copy has an uncommitted 1.35.9 (section 0). Squirrel may skip installing a version that's already installed, so raise the version before shipping to existing installs (the `/release` skill checks).
- **`dist/app/win-unpacked/Min.exe` is the maintainer's everyday browser** (section 0), on their real profile: never start it yourself, and packaging replaces it. The packaged suites (`MIN_TEST_PACKAGED=1`) and `test/e2e/open.js` run it with a throwaway profile.
- `docs/inside-min.html` ships inside the app too (the `files` list leaves out `*.md` files, not `docs/`). Harmless, 150 KB.
- **CI:** `.github/workflows/build-packages.yml` is manual only (`workflow_dispatch`). It builds deb, rpm, Windows and both macOS targets. There is no lint or test CI.
