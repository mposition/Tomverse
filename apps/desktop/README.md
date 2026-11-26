# Tomverse Desktop

This workspace contains the Electron main process, a sandboxed preload and local Vite renderer, and a separate Code runtime process that bundles the existing Tomverse CLI headless entry. The approval window is owned by the main process. The renderer receives app capabilities through named IPC methods.

Desktop starts signed out. Once you connect your Tomverse account, Chat and Review can show your existing conversations. Availability of native actions depends on the account and server capabilities. The local integration fixture uses a temporary loopback server and profile and exercises the shared Code runtime. Standard packages exclude the fixture.

A connected Desktop Chat account reads its web history through the same conversation API. The server-side `TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED` switch defaults off and requires Desktop authentication. Once enabled, Desktop uses the existing Chat model and credit checks for text questions. Deleting a conversation requires confirmation in the app.

`TOMVERSE_DESKTOP_REVIEW_ENABLED` also defaults off. It controls Desktop Review execution and authenticated image workspace requests. Review uses the existing routing, admission, and model entitlements. Image generation uses the server's catalogue and quoted price for each model and starts when the user confirms Generate.

## Run on your development machine

From the repository root, with the workspace dependencies and Electron binary installed:

```sh
npm run desktop:build
npm run desktop:start
npm run desktop:typecheck
npm run desktop:test:e2e
```

On Windows, the end-to-end test command runs Electron and native dialogs on a separate Windows desktop. The same launcher supports individual test files.

```powershell
cd apps/desktop
node scripts/run-on-test-desktop.mjs --import tsx --test tests/desktop.e2e.ts
```

For the Desktop and mobile device-auth database regression suite, set `TEST_DATABASE_URL` to a dedicated, disposable loopback PostgreSQL database with a test marker in its name. Run `npm run desktop:test:db` to apply migrations, check for schema drift, and run the integration tests. The tests reset fixture tables in that database.

The package verifier checks the app archive, fixture exclusion, license notices, and runtime payload. For macOS it checks the architecture of the bundled executables and the app's files and framework links. On Windows it starts the packaged executable on a separate Windows desktop with a temporary profile to check the native window, taskbar icon, and Code worker.

```sh
npm run desktop:package -- --platform=win32 --arch=x64
npm run desktop:pack:verify
```

The packager targets Windows x64, macOS x64/arm64, and Linux x64. Local bundles go to `dist/package` under this workspace. macOS builds produced on a Mac are signed ad hoc for local use. After building the matching portable bundle, run `npm run desktop:package:native` on macOS to verify the app signature and create a local `.pkg`, or on Debian x64 with `dpkg-deb` to create a local `.deb`. Debian desktop testing requires a graphical session and Chromium user namespaces. Release signing and notarization require an Apple signing environment.

The packaged resources include `THIRD_PARTY_NOTICES.txt` with the bundled JavaScript dependency notices. Electron and Chromium include their runtime license files in the bundle.

After building the Windows x64 bundle, use a Windows SDK Developer PowerShell to make an unsigned MSIX. The build checks the executable against its ASAR, verifies the files in the generated package, and prints its SHA-256 hash. Set the publisher to the exact subject of the certificate used to sign the package. Pass `--makeappx` with the SDK executable path if it is unavailable on PATH. The MSIX must be signed with a trusted certificate before installation.

```powershell
npm run desktop:package:msix -- --publisher "CN=Your signing certificate subject"
```

To smoke-test profile compatibility on Windows, build a second version into a separate output directory with `desktop:package -- --out=dist/package/qa --version=0.1.1`. Run `npm --workspace @tomverse/desktop run pack:verify -- --out=dist/package/qa --previous "dist/package/Tomverse Desktop-win32-x64"` to launch both executables against a temporary profile and confirm that the older build can still open it. This exercises portable binaries. Test installer updates with signed packages.

Run the installed lifecycle test from the repository root in a disposable Windows user session. Provide two ascending MSIX versions signed with the same trusted test certificate. The test installs and launches the first version, checks that a real profile file survives the Windows package update, and checks uninstall and reinstall through the Windows package manager.

```powershell
powershell.exe -NoProfile -File apps/desktop/scripts/verify-msix-lifecycle.ps1 -Previous "<signed older MSIX>" -Update "<signed newer MSIX>"
```

On each supported Mac architecture, build two ascending local `.pkg` versions in separate output directories. Run the lifecycle verifier from the repository root in a graphical login on a disposable Mac with an empty Tomverse Desktop profile and a current sudo session. It validates both packages, installs them through macOS Installer, and checks that the installed window and its profile survive update and reinstallation. It keeps the test bundles and its JSON report in the printed temporary directory.

```sh
sudo -v
node apps/desktop/scripts/verify-mac-pkg-lifecycle.mjs --disposable --previous "<older pkg>" --update "<newer pkg>"
```

## Code workspaces

New Tomverse API Agent tasks in a Git project start in their own worktree when Git is on PATH. Open **Code workspace** to choose a starting branch and see the worktree path and working branch before sending the task. The checkout starts at the displayed commit. Choose **Current folder** to edit the existing checkout, including local changes. Ask and Plan use the open folder for read-only work.

A worktree keeps the path relative to the repository of the folder you opened. Attachments for an isolated task must exist in the selected commit. After restarting Desktop, open the source folder and select the saved task from history to resume in its worktree. If the worktree is missing or on a different branch, Desktop blocks resumption and undo until the original checkout is available. Saved diffs and command details can still be inspected. Worktree files stay on disk when you delete Desktop task history.

## MCP servers and hooks on this computer

The Tomverse API agent uses MCP servers and hooks defined in files (formats, trust and limits: `apps/tomverse-cli/README.md`, "MCP servers and hooks"). **Connectors** (and **Settings > Execution and limits**) has a section "MCP servers and hooks on this computer", apart from the account's connectors: yours (`mcp.json` and `hooks.json` in `~/.tomverse` or `TOMVERSE_HOME`, Claude Code's user `settings.json`) and the open project's (`.mcp.json`, `.claude/settings.json`, `.codex/hooks.json`). A project's server or hook waits for **Approve**; the approval names the definition's hash, so one that changed since the list was shown is not approved, and a changed one asks again. Each can be switched off, and **Check connection** starts an approved server to count its tools (an unapproved one is never started to be looked at). The window sends typed commands only (`local-extensions-contract.ts`), never a path or a command line. Each MCP tool call opens the usual approval window with the server, the tool and the arguments. Read-only and Plan tasks start no servers.

## Release checks

See the [Desktop release draft](RELEASE.md) for the download listing, supported workflows, account and privacy details, and the operator's release checks.

Record the OS, architecture, app version, artifact SHA-256, and the results of install, launch, update, removal, and reinstall. Check that settings and local Code history survive the applicable operations. For Windows, use the signed MSIX lifecycle check above. For Intel and Apple Silicon Macs, use the native PKG check. For Debian x64, use the package manager in a disposable graphical session.

Run browser sign-in, same-account Code key binding, Chat and Review, image generation, approved Code edits and commands, cancellation, and recovery on the relevant packaged app. Record whether the run used a local fixture or an approved account and live service. Live verification requires an authorized account and spending scope. Check each live charge against its service receipt.

Record distribution signing, the public update feed, and any unverified platform features in the release results.

## Update channel

### Windows Local Dev

**Tomverse Desktop Local Dev** is a Windows x64 test package that connects to `dev.tomverse.app`. It has its own Windows package identity and app profile. Windows App Installer checks its local `.appinstaller` file at launch. Keep the channel directory at the path registered during installation.

From the repository root on the Windows packaging PC, use PowerShell 7 with Node.js and the Windows SDK x64 MakeAppx and SignTool installed:

```powershell
$channel = 'H:/Project/tv-desktop-agent-worktrees/local-dev-updates'
./apps/desktop/scripts/package-local-dev-update.ps1 -Version 0.1.130 -ChannelDirectory $channel
```

The script signs the new MSIX with the Local Dev key in the Windows current-user certificate store and updates the local channel only after checking the signature, package identity, and version. The private key stays non-exportable in the certificate store. Use `-BuildOnly` to prepare a package before updating the channel.

When creating a channel, the first run exports the public `Tomverse-Desktop-Local-Dev.cer` and stops if it is untrusted. Import that certificate into **Local Computer → Trusted People** with an administrator account, then rerun the build. Open `Tomverse-Desktop-Local-Dev.appinstaller` once on the test PC to enroll the app. After publishing a higher version, close and reopen **Tomverse Desktop Local Dev** to pick up the update.

The Dev server advertises two additional capabilities after their server switches are enabled. `TOMVERSE_DESKTOP_COMPOSER_TOOLS_ENABLED` enables Chat's conversation-scoped web search, assistant and memory controls alongside Desktop Chat writes. `TOMVERSE_DESKTOP_REVIEW_ANALYSIS_ENABLED` adds the answer-analysis dialog for two or more saved text answers alongside Desktop Review writes. The analysis uses the existing `GET` and `POST /api/conversations/{conversationId}/comparison-reviews` and keeps its server-side ownership and credit checks.

### Release builds

Release builds can embed a deployment-controlled HTTPS origin through `TOMVERSE_DESKTOP_UPDATE_ORIGIN` at build time. The feed endpoint is `/desktop/updates/{platform}/{arch}/{currentVersion}`. The packaged Windows path requires a signed, directly installed MSIX. Windows App Installer manages updates for packages installed through an App Installer manifest. The macOS path uses Electron’s native updater with a signed app and JSON feed. Linux updates follow the supported distribution package path.

For Windows x64, the stable feed returns HTTP 204 when no update is available. Return an update for a newer numeric `x.y.z` app version with the fields below. Use the exact byte count and lowercase SHA-256 of the final signed MSIX at a direct HTTPS URL on the feed origin. The MSIX uses the corresponding `x.y.z.0` package version. Windows verifies the downloaded signature, and the app checks the signer and package identity against the installed package before staging it with Electron.

```json
{
  "channel": "stable",
  "platform": "win32",
  "arch": "x64",
  "version": "0.1.1",
  "url": "https://updates.example.com/releases/Tomverse-Desktop-0.1.1.0-x64.msix",
  "size": 180000000,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The app checks periodically when an update channel is configured. Settings shows download readiness and prompts for a restart. Active Code tasks and Chat writes prevent installing the update. Signed updates, feed responses and cross-version installation require release artifacts and separate verification.

For macOS, the endpoint returns the stable Squirrel JSON manifest for the requesting architecture. The top-level manifest includes `channel: "stable"`, `platform: "darwin"`, `arch`, `currentRelease`, and `releases`. The selected `updateTo` entry includes a matching version, a same-origin HTTPS ZIP URL, the ZIP byte count and its lowercase SHA-256. The app passes the validated entry to Squirrel as a local file and keeps it until the native check finishes. Native signature and downgrade checks apply when Squirrel opens the ZIP.

On a Mac with a matching Developer ID signed and stapled app, create the update ZIP and `releases.json` from the repository root. The script validates the bundle, package architecture, signature, and notarization ticket before writing a versioned output directory. Serve the generated JSON at the version-specific feed path and the ZIP at the URL declared in the feed.

```sh
npm run desktop:package:native -- --out=dist/package --update-origin=https://updates.example.com
```
