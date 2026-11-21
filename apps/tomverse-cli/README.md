# Tomverse CLI

A coding agent for your own folder, on your Tomverse API key. It reads your
code, proposes changes as diffs you approve, runs the commands you approve
(tests, builds), and tells you what it did and what it cost. No Claude Code,
Codex or repository checkout is needed.

Needs a Tomverse Pro plan or above: API keys and the CLI are not available on
the Free plan.

## Install

Works on Windows, macOS and Linux. Pick one:

**With Node.js 22 or later** (any platform Node.js runs on):

```bash
npm install -g @tomverse/cli
tomverse doctor
```

**Without Node.js:** download the archive for your system from the
[Tomverse CLI releases](https://github.com/mposition/Tomverse/releases?q=cli-v)
and put `tomverse` (Windows: `tomverse.exe`) in a folder on your `PATH`. Each
archive has a `.sha256` file to check it against.

| System | Archive |
|---|---|
| Windows 10/11, x64 | `tomverse-<version>-windows-x64.zip` |
| Windows 11 on Arm | `tomverse-<version>-windows-arm64.zip` |
| macOS, Apple silicon | `tomverse-<version>-macos-arm64.tar.gz` |
| macOS, Intel | `tomverse-<version>-macos-x64.tar.gz` |
| Linux x64 (glibc 2.28+) | `tomverse-<version>-linux-x64.tar.gz` |
| Linux Arm64 (glibc 2.28+) | `tomverse-<version>-linux-arm64.tar.gz` |

```bash
# macOS / Linux
tar -xzf tomverse-<version>-<os>-<arch>.tar.gz
sudo mv tomverse /usr/local/bin/          # or any folder on your PATH
tomverse doctor
```

```powershell
# Windows PowerShell
Expand-Archive tomverse-<version>-windows-x64.zip -DestinationPath "$env:LOCALAPPDATA\Programs\tomverse"
[Environment]::SetEnvironmentVariable("Path", "$([Environment]::GetEnvironmentVariable('Path','User'));$env:LOCALAPPDATA\Programs\tomverse", "User")
# open a new terminal, then:
tomverse doctor
```

The executables carry their own Node.js runtime, so they are large (about
100 MB) and are not yet signed with a publisher certificate. Windows may show
"Windows protected your PC" on first run (More info > Run anyway). macOS may
block a file downloaded in a browser; allow it in System Settings > Privacy &
Security, or run `xattr -d com.apple.quarantine tomverse`. Alpine and other
musl-based Linux systems should use the npm package.

## Connect

1. Create a key in **Tomverse > Settings > API keys** (set a credit limit on
   it if you want a hard cap).
2. Give it to the CLI: set `TOMVERSE_API_KEY`, or just run `tomverse` and type
   it when asked. A typed key is kept in memory for that run only. The CLI never
   writes the key to its config, sessions or logs, never passes it to a command
   it runs, and has no `--api-key` flag (it would end up in shell history).
3. `tomverse models` lists the models your key can use, with credits per
   request. Pick one with `--model <id>` or `tomverse config set model <id>`.

Revoke or limit a key in Settings > API keys; the CLI has no key management.

The CLI talks only to Tomverse's coding API, `https://tomverse.app/api/code/v1`,
unless you set another endpoint with `tomverse config set endpoint <url>` (or
`TOMVERSE_ENDPOINT`). An endpoint saved before the CLI moved to the coding API
ends in `/api/v1`; it is read as `/api/code/v1` on the same server.
It must be https; plain http is accepted only for a loopback development
server after `tomverse config set allow-insecure-localhost true`. Redirects
are never followed, so the key cannot be carried to another address. Nothing
in a repository (AGENTS.md, scripts, model output) can change the endpoint, the
key or any permission.

## Use

```bash
cd my-project
tomverse "fix the failing date test"     # interactive
tomverse exec --json "explain src/index.ts" --read-only
```

| Command | What it does |
|---|---|
| `tomverse [task]` | Interactive session. `/help`, `/diff`, `/usage`, `/compact`, `/model`, `/approvals [clear]`, `/exit` inside. |
| `tomverse exec <task> [--json]` | One task, no prompts. Stops with exit code 3 at the first action that needs approval. |
| `tomverse resume <session> [task]` | Continue a saved session (and answer pending approvals in a terminal). |
| `tomverse models` | Models this key can use. |
| `tomverse usage [--session <id>]` | Key cap, committed and held credits; or one session's own receipts. |
| `tomverse sessions list` / `sessions delete <id>` | Local sessions. Delete asks first (or `--yes`). |
| `tomverse diff [--session <id>]` | Changes this CLI made, and only those. |
| `tomverse undo <change-id>` | Undo one of them (see below). |
| `tomverse doctor` | Node, folder, key, API and recovery lookup checks. Makes no model request. |
| `tomverse trust [folder]` | Allow the CLI to work in a folder (asked once in interactive mode). |
| `tomverse config show/set/unset` | `endpoint`, `model`, `allow-insecure-localhost`, `command-env`. |

Options: `--cwd`, `--model`, `--read-only`, `--max-requests <n>`,
`--timeout <minutes>`, `--command-timeout <seconds>`, `--no-persist`, `--json`.

### Limits

| Limit | Default | Meaning |
|---|---|---|
| Model requests per task | 20 (`--max-requests`) | Every model request counts, including a compaction. Approvals, compaction and resume never reset it. At the limit the session is saved; interactively you can allow one more round of the same size. |
| Active time per task | 15 min (`--timeout`) | Time spent waiting for your approval does not count. |
| Per command | 120 s (`--command-timeout`) | The model can ask for another value; the approval shows it. Maximum 30 min. |

These are CLI limits, not a credit budget. The only hard credit limit is the
cap you set on the key in Settings; the CLI does not promise "at most N credits
per task".

## What can happen without asking, and what cannot

- **Without asking:** listing, searching and reading files inside the folder.
  Listings skip generated folders (`node_modules`, `dist`, …) and, in a Git
  repository, ignored files. Files that can hold credentials are never read or
  written by the CLI: `.env*`, `.envrc`, `.npmrc`, `.netrc`, private keys
  (`*.pem`, `*.key`, `id_rsa`, …), any file whose name starts with `credential` or
  `secret` (source files with such names too — open them yourself), cloud
  service-account JSON, `.git/` internals and `.ssh`/`.aws`/`.gnupg` folders.
  Paths are checked on their real location: links and junctions that lead out
  of the folder, `..`, Windows UNC/device paths and alternate data streams are
  refused. Nothing is uploaded in bulk; only what the model asks to read, in
  bounded pieces.
- **Every change asks:** `apply_patch` shows the full diff of every file in the
  batch. Edits are exact text replacements; an edit whose text is not found
  exactly once is refused, not guessed. BOM and CRLF line endings are kept.
  The approval is bound to the exact input and to each file's content at that
  moment: if a file changes before the write, nothing is written. Files are
  written one at a time (each atomically); if one fails, the result says which
  were written.
- **Every command asks:** the approval shows the program and arguments (or the
  shell line and the shell), the folder, the time limit and the environment
  variable names. **A command runs with your own operating-system permissions.
  The folder is where it starts, not a sandbox: it can change files elsewhere
  and use the network.** A test script is a command like any other; the CLI
  does not judge commands as safe. Commands get a small environment (PATH,
  HOME, temp folders, locale, …) plus names you add with
  `tomverse config set command-env NAME1,NAME2`; Tomverse variables are never
  passed. That keeps your API key out of commands; it does not hide files your
  account can read. stdin is closed; output is kept to the first and last 32 KB.
  On timeout or cancel the whole process tree is ended — on macOS and Linux
  including descendants that moved to their own session — and anything that
  survived is reported. A program that detaches itself after the command has
  already finished is outside what the CLI can see.
- `argv` (a program and its arguments) runs without a shell, so what you
  approve is exactly what runs. On Windows, batch programs such as `npm`/`npx`
  cannot run that way (cmd.exe would re-read the arguments); they run as a
  shell line in Windows PowerShell, and the approval says so. Elsewhere shell
  lines run in your `bash`/`zsh` (or `/bin/sh`).
- **Answers:** `y` allows once, `n` (or Enter) declines. `a` allows it and
  stops asking for the same kind of action for the rest of this run of the CLI:
  for a change, every later create or update of files in this folder; for a
  command, exactly the same program, arguments, folder and environment names
  (only the time limit may differ — any other command is asked). Deleting a
  file is always asked, and its question offers only `y`/`N` (`a` there
  declines). What runs without asking is still shown, and every
  check above (paths, credential files, file content at that moment, the
  resolved program) still applies. An `a` answer is not saved: a resumed
  session asks again. `/approvals` lists what is allowed, `/approvals clear`
  makes everything ask again. The session records which approvals came from
  an earlier `a`.
- `--read-only` gives the model no patch or command tool at all.
- Without a terminal (`exec`, pipes, CI) nothing can be approved: the run stops
  with exit code 3 and the pending actions in the output. Review them with
  `tomverse resume <session>` in a terminal. There is no flag that approves
  everything.
- `AGENTS.md` at the folder root is given to the model as project
  information. It cannot grant permissions, and the CLI never runs commands or
  install hooks because a file says so.

## Sessions, interruption and recovery

Sessions are saved in `~/.tomverse/sessions/<id>/` (or `$TOMVERSE_HOME`),
readable only by you (on Windows, by your user profile's permissions). A
session holds the conversation — including file contents and command output
the model saw — request ids, approvals, tool states and the earlier content of
files the CLI changed (for undo). It never holds the API key and nothing is
uploaded or synced. `--no-persist` keeps a session in memory only: it cannot
be resumed and its changes cannot be undone after the process exits.
`tomverse sessions delete <id>` removes a session and its backups.

The session is saved before and after every model request, file write and
command. If it cannot be saved (disk full, permissions), the CLI stops before
anything else is sent, written or run. One process at a time can open a
session.

- **Ctrl+C** stops the model's answer and any running command (and its child
  processes) and saves the session. Press it twice to quit at once.
- **A lost answer:** each model request gets its own Idempotency-Key, recorded
  before it is sent. If the connection breaks, the CLI asks Tomverse about that
  request (`GET /api/code/v1/requests/status`, read only). Tomverse does not store
  answers, so a lost answer cannot be shown again; you choose whether to send
  the step again as a new request (it can be charged again). "Not found" does
  not mean "not charged": the request may still arrive.
- **A crash during a command or write:** the command is never run again on
  resume; the CLI reports that its outcome is unknown. A file write is checked
  against the file.
- **resume** re-checks the folder, the endpoint, the model (a model that is no
  longer offered is never silently replaced), the request limit already used
  and any pending approvals.
- **compaction:** before the conversation outgrows the model's context, one
  request to the same model summarises the older part. Tool calls are never
  separated from their results, and what the CLI itself recorded (changed
  files, commands) is added by the CLI, not by the model. If it fails, the full
  history is kept and it is not retried automatically.

### diff and undo

`tomverse diff` lists only changes this CLI made; changes that were already
in the folder, or that you made later, are yours and are not shown or touched.
`tomverse undo <change-id>` restores one change only if the file is still
exactly what the CLI wrote; otherwise it stops and changes nothing. A newer
change to the same file must be undone first. There is no reset, clean or
folder-wide restore.

## Costs

Each model request is one Tomverse API request with its own receipt, charged
from your shared credits like any other API request. Reading files, applying
patches and running commands cost nothing by themselves. `tomverse usage
--session <id>` adds up that session's own receipts (not the key's total, which
other tools may share). Held credits are not final; an unknown request is shown
as unknown, never as zero.

## Machine-readable output

`exec --json` writes JSON lines to stdout and human text to stderr. Event types:
`session`, `request` (seq, purpose `agent`/`compact`, idempotency_key),
`response` (status, request_id, routed_model), `assistant` (text),
`tool_result`, `approval_required`, `compaction`, `compaction_failed`,
`error`, and a last `final` (status, exit_code, session_id, cost).

| Exit code | Meaning |
|---|---|
| 0 | success |
| 1 | error (configuration, key, API refusal, journal) |
| 2 | usage error |
| 3 | needs approval (or the folder is not trusted yet) |
| 4 | cancelled |
| 5 | limit reached |
| 6 | unknown outcome (a request whose result could not be confirmed) |

## Models

The catalogue comes from `GET /api/code/v1/models`; the CLI uses only models with
tool calls over Chat Completions and keeps no model or price list of its own.
A session stays on one model. With `smart-adaptive`, the model that answers the
first request is pinned for the rest of the session (including compaction and
resume). Native protocol features (signed thinking, encrypted reasoning state)
are not used by this CLI.

## Support

- Windows (PowerShell), macOS (zsh) and Linux (bash), with Node.js 22 or
  later or as a standalone executable (see Install). Each release is built and
  tested on every one of these systems before it is published.
- Terminal text is English; Korean and other Unicode input, file names and
  output work.
- Not in this version: MCP, plugins or skills, image input, a code index or
  LSP, parallel agents or worktrees, IDE or desktop apps, background agents.

## Update and roll back

- npm: `npm install -g @tomverse/cli@latest` updates; to go back, install a
  given version with `npm install -g @tomverse/cli@<version>`. Uninstall with
  `npm uninstall -g @tomverse/cli`.
- Standalone: replace the `tomverse` executable with the one from a newer (or
  older) release archive. Uninstall by deleting it.

Sessions are versioned: a CLI refuses a session written with a different
schema instead of misreading it. Delete `~/.tomverse` to remove all local
data.

## License

The Tomverse CLI is proprietary software: you may install and use it with your
Tomverse account; see [LICENSE](LICENSE). Its open-source components keep
their own licenses (the standalone archives list them in
`THIRD_PARTY_NOTICES.txt`).
