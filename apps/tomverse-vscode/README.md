# Tomverse for VS Code

Ask about a local project, or select **Agent** to propose edits and commands. Review full native diffs and approve each action in the Tomverse sidebar. No Copilot, Claude Code, Codex, global Tomverse CLI or separately installed Node.js is required.

## Install and connect

Get `tomverse-vscode-1.0.0.vsix` from the [public preview release](https://github.com/mposition/Tomverse/releases/tag/tomverse-vscode-v1.0.0). In local VS Code Desktop, run **Extensions: Install from VSIX** and select the downloaded file. Open **Tomverse** in the Activity Bar, choose **Connect API key**, and enter your Tomverse API key in the native password input. The key stays in VS Code SecretStorage. Connection refresh only fetches metadata; it does not generate a paid answer. Disconnect removes the local key; revoke it in Tomverse account settings if needed.

The default API base is `https://tomverse.app/api/code/v1`. Only the user's application settings can change it. Workspace settings, environment variables and project instructions cannot select the key or endpoint. The extension never falls back to the general API. A 404/503 can indicate that the selected server's coding API is not deployed/enabled. API eligibility, shared credits and the key's cap are enforced by Tomverse. Use the server-provided catalog; models cannot be added by typing arbitrary IDs.

## Working with a project

Open a trusted local file workspace and explicitly select one root when it has multiple roots. Attach a file, selection or diagnostics using the sidebar, editor context menu or explorer context menu. Attachments show the path, version, range, unsaved state, size and any truncation. Eight attachments and 64 KiB total are the current context limits. Changed attachments must be attached again. Untitled selections are for Ask only.

**Ask** has only read tools. **Agent** can propose guarded patches and commands. Choose **Allow once**, **Allow for this run**, or **Deny**. Current-run permission covers creates/updates or the exact command; deletes always ask. Clear permissions at any time. They expire on a new task, resume or reload. Project/model instructions cannot approve actions.

Diff buttons open full read-only before/after documents. Character details show EOL, BOM and escaped control characters. Unsafe controls in new patch text are rejected by the shared writer. Unsaved files offer Save/Cancel. Saving can trigger formatting; the model must read the new content and propose a new patch. Typing, saving, moving or deleting after review invalidates approval. Multi-file edits are applied separately and report partial results. Only the shared CLI disk writer writes patches; no simultaneous WorkspaceEdit writer is used.

Commands show their executable, arguments, working folder, environment names and timeout. They run with your OS permissions, **not in a sandbox**. A command can access resources beyond the workspace. Output and exit codes are shown in Output. Nonzero exit codes remain failures. Stop cancels the model request and the command process tree. When process-tree verification is unavailable or survivors exist, the result reports that uncertainty.

## Sessions, costs and recovery

**Effort** opens a native picker beside the model selector. Low and High appear only when the server catalog offers them; Default preserves the model's existing settings and sends no override. An explicit choice is fixed for the task, including tools, compaction and resume. Smart Adaptive pins its chosen model as usual. Effort does not filter or rank routing candidates. When the selected model cannot apply the requested level, the server uses Default and the sidebar shows that actual applied level. The original request and per-generation applied levels remain in the journal. A completed task can use a different level for its next prompt. Effort can change latency and credit usage; existing request limits and server caps still apply.

Sessions live outside the project in this extension's local storage, separately for the root, complete API base and credential identity. They include prompts, context, model output and Undo backups. They do not sync to other devices. Turn off the user setting `tomverse.persistSessions` for memory-only sessions; reopening and Undo after exit are then unavailable. **Delete local session** confirms deletion of that conversation and its backups, leaving workspace files and server receipts intact.

One active run is allowed per window. A lock prevents opening the same session in another window. Hiding/recreating the sidebar does not restart a request. Reload/crash recovery never replays a started command or patch automatically. **Sessions** loads history without inference. **Review recovery / resume** looks up unfinished intents and asks explicitly before a new paid request. A missing receipt is unknown, not free. Never automatically retry an unknown request.

Costs come only from this session's request receipts, including compaction, with settled credits, held credits and unknown requests distinguished. Other apps' spending on the same key is excluded. The defaults are 20 requests, 15 active minutes per task and 120 seconds per command; these are operational limits, not a guaranteed credit cap. Smart Adaptive pins the first routed model before tools run. A missing pinned model requires a new session.

Use per-change **Undo** to restore only the extension's change after confirmation. Dirty files, later user edits and subsequent changes cause it to stop. It does not roll back arbitrary command effects or promise normal editor Ctrl+Z integration. Diagnostics export contains redacted metadata, not source, prompts or raw logs. Output can contain project content; review it before sharing.

## Preview compatibility

The preview requires local VS Code Desktop 1.146.0 or later. A single VSIX serves all desktop targets. This package was verified on Windows x64. An earlier build passed local workspace workflows on Linux x64 VS Code Desktop in Ubuntu WSL2. Verification for this package on Linux and macOS arm64 is pending, along with some native Windows accessibility checks. Remote SSH, Remote WSL, containers, Codespaces, web and virtual workspaces are unsupported. Restricted Mode provides setup/help only.

The UI follows the editor theme and provides English, Korean, German, Spanish, French, Portuguese, Simplified Chinese and Traditional Chinese labels. Ctrl/Cmd+Enter sends; IME composition does not submit. Use Tab to navigate. No prompt/source/key telemetry is collected by this extension.

An earlier build also exercised Ask and Agent against a development Tomverse API with real models and settled credit receipts. The release notes describe the verification and distribution status for this preview.
