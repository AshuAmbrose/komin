---
name: release
description: Ship work on the Min fork. Covers the checks, a commit that leaves out the maintainer's local version line, the push, the pull request's title and body, and a Windows installer. Use it when the maintainer asks to commit, push, give PR content or build an installer, in whatever words. Do only the parts they asked for.
argument-hint: "[version for the installer, e.g. 1.35.10]"
---

# Shipping the Min fork

The maintainer asks for this in their own words ("commit push give PR content and give installer"). Do the parts they asked for, in this order. AGENTS.md (sections 0 and 13) has the background; this is the checklist. If a step here disagrees with the repository, the repository wins: fix this file.

## 1. Before committing

- **What "this" is.** If you didn't make the changes yourself in this session, list them (`git status --short`, `git diff --stat`, `git log --oneline origin/<branch>..HEAD`) and confirm with the maintainer which ones to ship.
- **Branch.** Never commit to `master` (protected). `git branch --show-current`; on `master`, make a branch named `feat/…`, `fix/…`, `perf/…` or `chore/…`.
- **What changed.** `git status --short` and `git diff --stat`. Commit only this work's files. Ask about anything else: the maintainer may have edits of their own.
- **Nothing left outside the repository.** Move test, measurement or diagnostic scripts from your scratch or temporary folders into `test/e2e` first (AGENTS.md section 0).
- **Checks.** Run `npm test` (lint: "X is not defined" for globals shared between `main/` files is noise, `docs/agents/build-system.md`) and `npm run test:unit`. Run the end-to-end suites the change touches (`npm run test:e2e -- <suite> …`, after `npm run build`), or all of them (`npm run test:e2e`, about 25 minutes, run in the background). Report the exact pass counts. Report a failure that came from a locked screen as that (AGENTS.md section 13). Say what wasn't run.
- **Docs.**
  - AGENTS.md: section 0 "Where things stand", and section 15 for what's left.
  - The subsystem's file in `docs/agents/`.
  - `test/e2e/README.md` for new or changed suites.
  - `docs/inside-min.html` if the architecture changed. The guide is published at https://claude.ai/artifact/GKB471fRDS4Sd378KSeN2y on the maintainer's account. Republish it if your tools can publish to that link; otherwise tell them to.

## 2. Commit, leaving out the version line

`package.json` in the working copy has an uncommitted `"version"` line that must stay out of commits. Interactive staging (`git add -p`) doesn't work here.

- Stage the other files **by name**. `git add -A`, `git add .` and `git add -u` would stage the version line too.
- Stage `package.json` last, with the committed version line put back. Run this in Git Bash from the repository root:

  ```bash
  tmp=$(mktemp)
  node -e '
  const fs = require("fs"), { execSync } = require("child_process")
  const head = execSync("git show HEAD:package.json", { encoding: "utf8" })
  const work = fs.readFileSync("package.json", "utf8").replace(/\r\n/g, "\n")
  const line = s => s.match(/^  "version": ".*",$/m)[0]
  process.stdout.write(work.replace(line(work), line(head)))
  ' > "$tmp"
  blob=$(git hash-object -w --path=package.json "$tmp") && rm "$tmp"
  git update-index --cacheinfo 100644,"$blob",package.json
  git diff --cached package.json   # this work's changes, without the version line
  git diff package.json            # only the version line is left
  ```

  If `package.json` has no other changes, the blob equals `HEAD:package.json`'s and nothing is staged for it.
- **Message.** Use a conventional prefix (`feat:`, `fix:`, `perf:`, `chore:`, `feat(filtering):`), a short subject, and a body listing the changes as bullets. End it with the attribution lines your harness specifies. Pass it with a heredoc or `-F file`.
- **Afterwards.** Check `git show --stat HEAD`, and that `git diff package.json` still shows the version line.

## 3. Push and the pull request's text

- Run `git push -u origin <branch>`. Never push `master`.
- The GitHub CLI isn't installed, so the maintainer opens the PR at `https://github.com/AshuAmbrose/komin/pull/new/<branch>` (base `master`). You can't see whether the branch already has an open PR: ask, or say that if one is open, the push has already updated it and the text below replaces its description.
- Give a title (conventional prefix) and a body in a fenced block, ready to copy. The body uses these sections, as they apply: Why, What's in it, one section per fix (what users saw, the cause, the fix, the test that shows it), and Tested (exact counts, what ran on a locked screen, what wasn't checked). Write in plain language: the maintainer is new to browser development. End with the PR attribution line your harness specifies.

## 4. Installer

- **Version.** Use the working copy's `package.json` version, or a version the maintainer gave (also as `/release 1.35.10`), set in the working copy's version line and still uncommitted. Squirrel may not replace an installed copy of the same version (AGENTS.md pitfall 10), so compare with the installed one:

  ```powershell
  (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\min').DisplayVersion
  ```

  If the new version isn't higher, ask whether to raise it.
- **An installer may already exist.** Look in `dist/app` for `min-<version>-setup.exe` and its date. If nothing that goes into the app has changed since it was built, offer that one instead of rebuilding: changes only to `test/`, `scripts/` (other than packaging), `docs/` (the guide ships, but the app never uses it), `*.md` files or `.claude/` make no difference to it. A rebuild would replace the maintainer's running browser for nothing.
- **The maintainer's everyday Min is the build folder.** Their Start-menu shortcut "Min" opens `dist/app/win-unpacked/Min.exe` (AGENTS.md section 0), so packaging replaces the browser they're using. Check first:

  ```powershell
  Get-Process Min -ErrorAction SilentlyContinue | Select-Object Id, Path
  ```

  If a path is under `dist\app\win-unpacked` or `%LOCALAPPDATA%\min`, ask them to quit it. Never end it yourself: it holds their open tabs.
- **Build.** Run `npm run build`, then `node scripts/buildWindows.js --arch=x64` (several minutes; run it in the background). It makes `dist/app/min-<version>-setup.exe`, `dist/app/Min-v<version>-windows.zip` and a new `dist/app/win-unpacked`.
- **Packaged checks.** These use throwaway profiles and never touch `%APPDATA%\Min`. Use PowerShell, since the variable syntax differs from Bash:

  ```powershell
  $env:MIN_TEST_PACKAGED = '1'; node test/e2e/run.js adblock-first-start extensions-real-popups whole-app-trim; Remove-Item Env:MIN_TEST_PACKAGED
  ```

  Add the packaged suites the change concerns. `whole-app-trim` runs only packaged.
- **Never run the installer yourself.** It would change the maintainer's own install.

## 5. Report

Tell the maintainer:

- the commit hash, the branch, and that it's pushed;
- the PR link, title and body;
- the installer's path and size, and which packaged checks passed, with counts;
- that their Start-menu "Min" already runs the new build, and that running the setup updates the installed copy (the "PalmerAL\Min" shortcut);
- what wasn't checked;
- that the version line is still uncommitted.
