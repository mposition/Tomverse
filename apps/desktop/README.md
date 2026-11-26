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

On Windows, the end-to-end test command runs Electron and native dialogs on a separate Windows desktop. The same launcher supports individual test files. It also gives the tests an empty home of their own (`HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`, `TOMVERSE_HOME` and `CODEX_HOME` point to a temporary folder, `scripts/test-home.mjs`), so the skills, hooks and MCP servers in the real home of the computer that runs them cannot change the tool lists the tests assert. The real home is passed as `TOMVERSE_TEST_REAL_HOME` for the one thing that needs it, the Windows sandbox, which keeps its files under the real profile. `TOMVERSE_TEST_USE_REAL_HOME=1` turns the isolation off.

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

## Permissions

**Settings > Task permissions** has the permission mode for Tomverse API Agent tasks and the allow, ask and deny rules. The modes are read only, ask each time (default), auto review (a separate model request judges each approval and is charged like any request; off by default) and allow all (asks for a confirmation, stays on show on the Code screen, and is not remembered after the app closes). Rules are saved by the CLI's rule store: user rules in the CLI configuration folder (`~/.tomverse/permissions.json`, or `TOMVERSE_HOME`) and project rules in `.tomverse/permissions.json` of the project; a project's own allow rules wait for your confirmation, and the confirmation is kept for the rules you were shown (a changed file asks again). A task in a managed worktree takes the confirmation of the project it was made from, but only when the allow rules in the worktree are exactly the ones you confirmed. **Allow for this run** on an approval card is remembered for that run only; a rule that lasts is one you add on this screen. Credential files, files outside the project and actions that leave the app (git push, pull requests, uploads) are never decided by a mode or a rule. The table below says what each mode decides; the CLI README has the same table with the details. The main process owns the mode; the Code runtime receives it as a message and nothing the model writes can change it.

| Request | read only | ask each time | auto review | allow all |
|---|---|---|---|---|
| File change, command | refused | approval window | a model request judges it | runs |
| Web page | approval window | approval window | approval window | approval window (a rule naming the site skips it) |
| Browser click or typing | refused | approval window | a model request judges it | runs |
| MCP tool | refused | approval window | approval window | approval window (a rule naming the tool or server skips it) |
| Agent commit | refused before the card opens | commit card | commit card | commit card |
| Agent push and pull request | refused before the card opens | push card | push card | push card |
| A subagent worker's change or command | refused | approval window | a model request judges it | runs |

A rule that denies always wins, an ask rule always asks, and a command that leaves the app, a credential file or a path outside the project is never run without you. The agent's commit and push are off until you switch them on, and each call opens its own card in the main process, which the agent and every mode, rule and reviewer cannot answer: a push and a pull request need your approval every time, whatever the mode. A hook's "allow" is ignored in every mode, and a PreToolUse hook that blocks stops the call in every mode. Typing into a password, one-time-code or card field is refused by the browser tab itself in every mode.

## Browser panel: agent tools and element comments

The Code browser panel (loopback pages only: `http` on `localhost`, `127.0.0.1` or `[::1]` with a port, in an isolated session of its own) is there in every build, for looking at a local development server and commenting on its elements. The agent's tools are the person's choice: **Settings > Execution and limits > Let Code use the browser panel** (off by default; it applies to the next request of a running task as well, and the main process checks it again on every request). The element picker follows the panel itself.

- The Tomverse API agent gets `browser_navigate`, `browser_read`, `browser_screenshot`, `browser_console`, `browser_click` and `browser_type`. It drives one tab that its own task opened, shown in the panel with a **Take over** button that ends its control at once. Addresses are limited to `http` on `localhost`, `127.0.0.1` or `[::1]` with a port, the same rule as the panel. Reading, screenshots and console reads need no approval; each click or typing is approved, and "Allow for this run" is remembered per site. Passwords, one-time codes and card fields are never typed. Page text is returned as untrusted data. The main process does the work: scripts run in an isolated world one call at a time, and input, pictures, the accessibility tree and the element picker use the tab's own DevTools session. Nothing is injected ahead of time.
- **Select element** lets the person click an element of the page, write a comment, and add several comments to the next message together. The message carries the selector, a short text, the position and, when the agent's browser tools are on, a `pick-xxxxxxxx` id; the cropped picture stays in memory in the main process and reaches the model only when it calls `browser_screenshot` with that id. The instruction box takes text only, so there is no attachment slot to put the picture in; with the tools off the message says nothing about a picture.

## Code terminal

The terminal button in the Code header opens a terminal panel for the open task. It is off until you press **Turn on terminal**. Each task keeps up to four terminals, and their shells and scrollback stay alive while another task is on screen. They end when the task is deleted, when the project or account changes, and when Desktop quits, together with everything they started.

The app host owns the shells (the renderer only sends typed actions) and starts each in the task's folder, which is its worktree for an isolated task. A shell gets the basic command environment from `apps/tomverse-cli/src/env.ts` plus terminal settings, never a Tomverse session, an API key or a token. Terminals use the `node-pty` native module; the Windows and macOS packages unpack it next to `app.asar`. Without it (Linux, or a module that cannot load) the terminal falls back to a limited pipe shell and says so.

Code's own agent gets a read-only `read_terminal` tool for the terminals you leave shared with it (the **Code can read** toggle, on by default). It cannot type into a terminal, the output is returned as untrusted data, and commands still go through `run_command` and its approval. Select text in a terminal and press **Add to prompt** to attach it to your next request.

## Reviewing changes

A saved Tomverse API task has a **Review changes** panel under its conversation, also opened by typing `/review` (optionally `/review turn` or `/review branch`) in the instruction box. Choose the scope: uncommitted changes (the working tree against HEAD, with new files), the agent's last turn (from the task's own record), or the branch against its base. The main process computes each diff; the renderer only names a scope and, for a revert, the id of a hunk.

Click a line number to comment on it (Shift-click extends the range). **Add comments to the instruction** writes each comment into the instruction box with its file, lines and the code it is about. **Revert hunk** asks first, then writes through the same recorded edit as an agent patch, so the change appears in the task's list and the usual undo puts it back. It is refused when the file no longer has the hunk where the diff said, and credential files are never shown or sent to a reviewer.

**Run review** sends the diff to one or more models chosen from the Code catalogue. Each reviewer is a read-only Ask run (read tools only) through the same gateway, receipts and request limit as any Code turn; the dialog before it runs states how many models and requests may be used. Findings from all models are merged into one list that names the model behind each, and shown under the line they are about. A finding can be handed back to the agent from the panel.

Git runs with the same restrictions as the worktree code, with external diff and text conversion programs turned off. Desktop ignores global and system Git configuration, so a repository whose files are checked out with CRLF endings by a global `core.autocrlf` setting can show every line as changed.

## Drafting commit messages and pull requests

In the Git panel, **Draft with model** writes a commit message from the files you selected, or a pull request title and description from the branch, into the boxes you edit before committing or pushing. It is a read-only Ask run of a model you choose from the Code catalogue, through the same runtime, gateway, receipts and request limit as a Code task (`host/review-run.ts`): one model request, charged in credits like a Code task. The main process reads the diff itself (credential files are not shown), asks you in a native dialog first, and sends only the diff. A draft commits and pushes nothing; the push and the pull request keep their own approval card.

## Skills, commands and agents

Code reads the skills, commands and agent definitions written for Claude Code and Codex where they are: `.claude/`, `.agents/` and `.codex/` in the open project and in your home folder (the CLI README lists the exact locations and rules). Typing `/` at the start of a Code request lists the skills and commands (and `/review`, the one command the app handles itself, where a task can be reviewed); the task shows what you typed and the model receives the skill or command text, with its arguments filled in by the rules of the tool the file is written for. This holds for the first request of a task and for a follow-up, a queued message and the answer to a question the task asked. The text is guidance only: permissions, hooks and tool lists in the files are not applied, and every change and command is still approved in the approval window. Settings, under **Execution and limits**, lists what was read with its source path and what was not applied.

**Import from Claude Code / Codex** previews what those tools already hold for this project. Instruction files, skills, commands and agents are read in place, so only MCP servers from your own configuration (`~/.claude.json`, `~/.codex/config.toml`) can be copied, into `mcp.json` in the Tomverse CLI folder (`$TOMVERSE_HOME`, default `~/.tomverse`), in the same shape as a project `.mcp.json`. Nothing is selected by default, `env` and header values are hidden in the preview, and the values are read again in the main process when you confirm. Desktop does not start MCP servers from this screen.

## MCP servers and hooks on this computer

The Tomverse API agent uses MCP servers and hooks defined in files (formats, trust and limits: `apps/tomverse-cli/README.md`, "MCP servers and hooks"). **Connectors** (and **Settings > Execution and limits**) has a section "MCP servers and hooks on this computer", apart from the account's connectors: yours (`mcp.json` and `hooks.json` in `~/.tomverse` or `TOMVERSE_HOME`, Claude Code's user `settings.json`) and the open project's (`.mcp.json`, `.claude/settings.json`, `.codex/hooks.json`). A project's server or hook waits for **Approve**; the approval names the definition's hash, so one that changed since the list was shown is not approved, and a changed one asks again. Each can be switched off, and **Check connection** starts an approved server to count its tools (an unapproved one is never started to be looked at). The window sends typed commands only (`local-extensions-contract.ts`), never a path or a command line. Each MCP tool call opens the usual approval window with the server, the tool and the arguments. Read-only and Plan tasks start no servers.

## Command sandbox

Settings > Execution and limits > Command sandbox limits what the commands Code runs can change: `workspace-write` (the project folder and a temporary folder), `read-only`, or `off` (the default), with an editable list of sites a command may reach through a filtering proxy. The screen shows what the current operating system really enforces. Windows limits writes only; its network list is advisory. The method, its limits and what it changes on disk are in `docs/ops/desktop-sandbox.md`. The sandbox applies to the Tomverse API path and is read again when each task starts. It applies to the commands the agent runs, in the folder the agent works in (the task's own worktree for an isolated task); the terminal panel, MCP servers and hooks run outside it, with your own access. The settings screen says so.

## Plugins

**Settings > Execution and limits > Plugins** installs, updates and removes plugins and adds marketplaces (formats, trust and limits: `apps/tomverse-cli/README.md`, "Plugins and marketplaces"). The window sends typed commands only (`plugins-contract.ts`); the folder to install from is chosen in a dialog the main process opens, and only the id of a preview the main process made can be confirmed. An install or update shows a **preview first**: counts, names, and every hook and MCP server command in full (an update also what is added, removed or changed); nothing is installed until **Install**/**Update**. A download from a git address asks in a native dialog first, naming the address. A plugin's hooks and servers appear in "MCP servers and hooks on this computer" with the plugin as their origin and wait for **Approve** (bound to the digest of the plugin's files). Each plugin can be switched off for everything or for the open project.

## Subagent orchestration

**Settings > Execution and limits > Subagent orchestration** (off by default; a per-task switch like goal mode, kept in this window and applied to new tasks) lets the Tomverse API agent split a large job into subtasks that run in parallel. The setting shows what it may use, "up to 3 subagents at once, 90 requests in all", and each run says it again in the task. It is the CLI's `delegate` extended (`apps/tomverse-cli/README.md`, "Orchestration"): the same gateway, requests and credits as any request, nothing priced separately, and the task's own request limit still applies (the Standard profile's 20 requests fit only small subtasks; choose Extended for a large job).

The Code screen gets a **Subagent activity** list: each subtask with its state, its newest step, the files it declared it may change, the files it changed, how many requests it used and how its result was verified (a read-only verifier against the completion criteria, plus a declared check command when there is one). **Stop** ends one subtask, **Stop all subagents** ends them all; the main task goes on and is told. Stopping the task stops everything. A worker's change or command is asked in the usual approval window, one at a time, saying which subtask asks. The window sends typed actions only (`orchestrate-contract.ts`): the switch, and a subtask id or "all" to stop. Read-only and Plan tasks get no worker subtasks.

## Parallel tasks and scheduled runs

**Parallel tasks.** The task the window has open runs in the main Code runtime. Every other task (started from the activity button in the Code header, or by a schedule) runs in a runtime process of its own, one process per task, so a task that fails, hangs or crashes cannot touch another. The rules are in `src/host/task-lanes.ts` (no Electron, unit-tested): at most **3** tasks run at once (a setting in the activity list, 1 to 6, kept in `parallel-limit.txt`; the open task counts) and the rest wait in a queue; two tasks never write the same folder (a task in its own new worktree has a folder of its own, and the existing workspace lock still refuses a second writer); each approval belongs to the task that asked, is labelled with that task's name and folder, is shown one at a time, and is answered only through the lane that asked (`answer()` in `main.ts` hands a lane's card to `lanes.decide`, which posts it under that lane's run id). An agent's commit or push from a lane uses the same ticket ledger on that lane's own folder, and its card goes to the same queue. A lane has no browser tab, terminal or plugin bridge. Limits per task (`limits` on the start input) and the account's credit limits are unchanged, so running tasks at once does not raise any of them. Quit stops every lane (and kills its process tree) before the app closes.

**Activity view.** The activity button lists the open task, the parallel tasks and the scheduled runs with a line each (waiting for a slot or its folder, running, waiting for approval, or how it ended), with Stop, Open, Side by side (two tasks next to each other), Own window and Remove. A task's own window (`/task`) has a preload of its own (`taskHost`: read and stop); the main process binds the window to one task by the window's id, so the page never names a task and no `desktop:` channel is reachable from it.

**Scheduled runs** (`src/host/schedule-engine.ts`, `schedule-launch.ts`; the arithmetic is `src/schedule-core.ts`, the safety rules `src/schedule-policy.ts`). **Off by default**; **Activity > Schedules** turns them on after the person reads that a run starts at its time with nobody confirming and uses credits. A schedule has an instruction, a repeat (once, every N minutes, daily, weekly) in a time zone, the project folder open when it was saved, where it runs (that folder or a new worktree), a permission mode and a request cap (standard 20 or extended 200, never unlimited). They run only while the app runs; there is no OS service or login item. A run that came due while the app was closed is recorded as **missed** and not made up; a run that is late by more than five minutes while the app runs is missed too. Each run is recorded (times, status, changed files, the task to open), and an OS notification is sent when it ends. Rules enforced in the main process: a request that needs a person is never answered for them and no card opens by itself, the run waits as "waiting for approval" in the activity list and fails after 30 minutes; a push or a pull request always needs the person's approval card (the agent's git tool, and a `git push` or `gh` command, which the permission boundary leaves to a person in every mode; on Windows the sandbox's network list is advisory, so a program the agent writes and runs itself is not stopped by it); **allow all** is accepted only for a new worktree run on a computer whose OS sandbox really refuses writes outside the project (checked again at every run); a schedule turns itself off after 3 failed runs in a row; schedules belong to the account that turned them on (another account sees none and starts from nothing); one schedule never runs twice at once. The agent has no tool that reads or changes schedules; they change only through typed commands from the window (`parallel-contract.ts`). Daylight saving: a wall time skipped by the clock change runs right after the gap, a repeated one runs once, at its first occurrence.

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
