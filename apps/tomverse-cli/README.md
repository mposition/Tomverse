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

**Windows, with winget** (the same installer as below, no download page):

```powershell
winget install Tomverse.CLI
# open a new terminal, then:
tomverse doctor
```

Update with `winget upgrade Tomverse.CLI`, remove with `winget uninstall Tomverse.CLI`.

**Without Node.js:** download the installer for your system from the
[Tomverse CLI releases](https://github.com/mposition/Tomverse/releases?q=cli-v),
run it, then open a new terminal and run `tomverse doctor`. Each file has a
`.sha256` to check it against.

| System | Installer | Installs to | Remove with |
|---|---|---|---|
| Windows 10/11, x64 | `tomverse-<version>-windows-x64.msi` | `%LOCALAPPDATA%\Programs\Tomverse CLI` (on your PATH; no administrator needed) | Settings > Apps |
| Windows 11 on Arm | `tomverse-<version>-windows-arm64.msi` | same | Settings > Apps |
| macOS, Apple silicon | `tomverse-<version>-macos-arm64.pkg` | `/usr/local/bin/tomverse` | `sudo rm /usr/local/bin/tomverse && sudo pkgutil --forget app.tomverse.cli` |
| macOS, Intel | `tomverse-<version>-macos-x64.pkg` | same | same |
| Ubuntu, Debian (x64, Arm64) | `tomverse-<version>-linux-<x64\|arm64>.deb` | `/usr/bin/tomverse` | `sudo apt remove tomverse-cli` |
| Fedora, RHEL (x64, Arm64) | `tomverse-<version>-linux-<x64\|arm64>.rpm` | `/usr/bin/tomverse` | `sudo dnf remove tomverse-cli` |

```bash
# Ubuntu / Debian
sudo apt install ./tomverse-<version>-linux-x64.deb
# Fedora / RHEL
sudo dnf install ./tomverse-<version>-linux-x64.rpm
```

Each installer also exists as a plain archive (`.zip` for Windows, `.tar.gz`
for macOS and Linux) holding the same `tomverse` executable, for a folder of
your choice.

The executables carry their own Node.js runtime, so they are large (about
100 MB). The Windows installer is not yet signed with a publisher certificate:
Windows may show "Windows protected your PC" (More info > Run anyway). Until
the macOS package is signed and notarized, macOS refuses to open it from a
browser download: open it with Control-click > Open, or allow it in System
Settings > Privacy & Security. Linux
packages need glibc 2.28 or later; Alpine and other musl-based systems should
use the npm package.

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

The CLI talks to Tomverse's coding API, `https://tomverse.app/api/code/v1`,
unless you set another endpoint with `tomverse config set endpoint <url>` (or
`TOMVERSE_ENDPOINT`). An endpoint saved before the CLI moved to the coding API
ends in `/api/v1`; it is read as `/api/code/v1` on the same server.
It must be https; plain http is accepted only for a loopback development
server after `tomverse config set allow-insecure-localhost true`. Redirects
are never followed, so the key cannot be carried to another address. Nothing
in a repository (AGENTS.md, scripts, model output) can change the endpoint, the
key or any permission. The only other host the CLI itself ever contacts is a
public web page you approved, through `web_fetch` (below); the key is never
sent there.

## Use

```bash
cd my-project
tomverse "fix the failing date test"     # interactive
tomverse exec --json "explain src/index.ts" --read-only
```

| Command | What it does |
|---|---|
| `tomverse [task]` | Interactive session. `/help`, `/diff`, `/usage`, `/compact`, `/rewind`, `/fork [turn]`, `/model`, `/effort [level]`, `/approvals [clear]`, `/exit` inside. |
| `tomverse exec <task> [--json]` | One task, no prompts. Stops with exit code 3 at the first action that needs approval. |
| `tomverse resume <session> [task]` | Continue a saved session (and answer pending approvals in a terminal). |
| `tomverse models` | Models this key can use. |
| `tomverse usage [--session <id>]` | Key cap, committed and held credits; or one session's own receipts. |
| `tomverse sessions list` / `sessions delete <id>` | Local sessions. Delete asks first (or `--yes`). |
| `tomverse sessions fork <id> [--turn <n>]` | Copy a session's conversation (through turn n) into a new session; no file is touched. |
| `tomverse diff [--session <id>]` | Changes this CLI made, and only those. |
| `tomverse undo <change-id>` | Undo one of them (see below). |
| `tomverse doctor` | Node, folder, key, API and recovery lookup checks. Makes no model request. |
| `tomverse trust [folder]` | Allow the CLI to work in a folder (asked once in interactive mode). |
| `tomverse config show/set/unset` | `endpoint`, `model`, `allow-insecure-localhost`, `command-env`. |

Options: `--cwd`, `--model`, `--effort default|<level>`, `--read-only`, `--limits <profile>`, `--goal`,
`--max-requests <n>`, `--timeout <minutes>`, `--command-timeout <seconds>`, `--no-persist`, `--json`.

### Limits

| Limit | Default | Meaning |
|---|---|---|
| Model requests per task | 20 (`--max-requests`) | Every model request counts, including a compaction. Approvals, compaction and resume never reset it. At the limit the session is saved; interactively you can allow one more round of the same size. |
| Active time per task | 15 min (`--timeout`) | Time spent waiting for your approval does not count. |
| Per command | 120 s (`--command-timeout`) | The model can ask for another value; the approval shows it. Maximum 30 min. |

`--limits <profile>` picks the request and time limits of a task as a set; it is saved with the
session and kept when you resume it. `--max-requests` and `--timeout` are more specific and win
over the profile.

| Profile | Requests per task | Active time per task |
|---|---|---|
| `standard` (default) | 20 | 15 min |
| `extended` | 200 | 120 min |
| `unlimited` | none | none |

`unlimited` has no limit of its own: the task ends when you stop it, when the API refuses a request
(a key credit limit or quota), or when the model is done. Approvals, the per-command time limit and
the key's credit limit work as before.

`--goal` turns on goal mode for the session. When the model says it is done, one more request of
the same model answers whether the goal is verified (for code: a relevant check was run and its
result shown). If not, its next action is sent to the model as your instruction and the task
continues, at most 10 automatic continuations in a row; it then stops as "limit reached" and says
the goal is not verified. Goal mode needs a session that can change files, counts every check as a
request, and never answers an approval for you.

Use `--effort high` for one task or `/effort low` to set the next interactive task.
`default` uses the model's existing setting. The coding API advertises the
available levels for each model; `--effort` takes `default` or any level `tomverse models` lists. A task keeps its requested level across steps
and resume. Each response records the applied level. A model that does not
support the request uses its own default.

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
- **Images (`view_image`):** for a model whose catalogue entry says it takes
  images, the model can look at a PNG, JPEG, WebP or GIF file of the folder (up
  to 3 MB; the type is checked on the file's first bytes). It needs no approval
  and follows the same rules as `read_file`: only inside the folder, never a
  credential file. The image reaches the model as image data in the next request,
  so it is part of what the transmission record counts; the newest three
  images stay attached and older ones are replaced by a note. A model that does
  not take images is not offered the tool, and an image you select as a
  reference in Desktop is looked at the same way.
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
- **Permission rules and modes:** `tomverse permissions` keeps allow, ask and
  deny rules for file edits (a path glob), commands (a command prefix) and web
  hosts, in `<home>/permissions.json` (all projects) and
  `<project>/.tomverse/permissions.json` (this project). Deny beats ask beats
  allow, and the two files are merged. **A repository cannot widen what the
  agent may do:** the project's deny and ask rules apply at once, but its allow
  rules apply only after you run `tomverse permissions trust` (which shows them);
  if the file changes, you are asked again. The file tools cannot touch either
  file. Desktop has modes on top of the same rules: read only, ask (default),
  auto review (a separate, charged model request judges each approval; three
  denials in a row hand it back to you; anything it cannot parse is yours to
  decide) and allow all (never saved; asks you to confirm). **Whatever the mode,
  rule or model answer, these stay a person's call or are refused:** files
  outside the work folder and credential files (refused); a command that sends
  something out of the computer (git push, gh, curl, npm publish, a network
  address in the command), names a credential file or the app's own data folder;
  a web host nobody approved. This is a check of the command's text, not a
  sandbox: a script that does these things on its own is not seen.
- **Web pages (`web_fetch`):** the model can read a public web page, for
  documentation. **Every site (host) is asked about first**, with the host and the
  full address shown; `a` allows that host for the rest of this run, and a
  redirect to another host is never followed without its own question. The
  address is judged by fixed rules that no answer or model text changes: https
  only, port 443, no user name or password, no IP address in any notation, no
  `localhost`, single-label or internal name (`.local`, `.internal`, …); the
  name is resolved by the CLI, every address it resolves to must be public (a
  private, loopback, link-local or reserved one, also inside an IPv6 form, refuses
  it), and the connection goes to the address that was checked. Every redirect
  is judged again. The request is a plain GET with no cookies, no login and
  nothing from your folder; the answer is limited to 2 MB and 20 seconds, only
  text, HTML, JSON and XML are read, and the text given to the model is marked
  as untrusted reference material, never instructions. The page text is part of
  the next model request, and the transmission record lists the address. A
  `--read-only` session has no `web_fetch` (it has no approvals at all, and the
  address of a request can itself carry information out), and neither do
  `exec` runs without a terminal. There is no web search tool.
- **Background commands:** a command can be approved to keep running after the call
  returns (a dev server, a watcher). The approval says "background" and "no
  time limit", and is bound to that: approving a foreground command never
  approves the same one in the background (an `a` answer does not carry over
  either). The model gets a handle and can read what it printed since its last
  read (bounded, stdout and stderr together), check its state and stop it,
  without a further approval, because only handles the task itself started
  exist. At most four run at once. They belong to the task: when it ends, is
  stopped or cancelled, or the CLI exits, every process tree still running is
  ended the way a timed-out command is (a hard kill of the CLI itself cannot
  run that cleanup). The session records them; a resumed session tells the
  model that its earlier background commands are no longer running.
- **Subagents (`delegate`):** the model can hand self-contained work to subagents that
  each start with a fresh context of their own and give back only a written report,
  so a wide search does not fill the main conversation. `explore` subagents can only
  list, search and read (the same path rules as the model's own reads, `view_image`
  when the model takes images); up to three run in parallel and need no approval.
  A `worker` subagent can also change files and run commands, one at a time, and
  every change and command is asked the same way, through the same prompt and the same
  "always" answers, as the main agent's own; a worker is not offered in
  `--read-only`, plan mode or `exec`. A subagent uses the model and reasoning effort of
  the task (the CLI never picks a cheaper model on its own), cannot start subagents of
  its own, and is stopped when the task is. Its requests are recorded in the session and
  in `tomverse usage` like any other and count against the task's request limit: a
  call that cannot fit what is left starts nothing, and a task starts at most 12. The
  report is handed to the main agent as unverified information. The session keeps a
  short record of each run (the task, kind, requests and how it ended, not its
  conversation); a resumed session tells the model about a run that never reported back.
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
- **Project instructions:** the folder's `AGENTS.md`, its `CLAUDE.md` (a whole-line
  `@file` in it pulls that file in, inside the folder only, and each file is
  given once) and the unconditional rules of `.claude/rules/*.md` (a rule whose
  front matter names `paths` is left out) are given to the model as project
  information, at most 32,000 characters in all; a cut is marked. When the
  model first reads or changes a file in a subfolder, that subfolder's own
  `AGENTS.md` / `CLAUDE.md` come with the result of that read or change, once
  per folder (again after a compaction), at most 48,000 characters in a task. Files go through the same path check as
  every read, so a link out of the folder or a credential file is never sent.
  Instructions cannot grant permissions, and the CLI never runs commands or
  install hooks because a file says so.
- **Project memory:** the model can keep a short note about the project
  (`remember_fact`: how the tests run, a decision, a trap) without asking you.
  Notes are stored in `~/.tomverse/memory/` (or `$TOMVERSE_HOME`), next to the
  sessions and outside the project, one file per folder, and the file tools
  never touch that folder. A note is one line of at most 300 characters; at
  most 40 notes and 8,000 characters are kept, the oldest dropped first; and
  anything that looks like a key, token or password is refused, not stored. At
  the start of each task the notes are given to the model after the
  instructions, marked as unchecked notes that cannot grant anything. A
  `--read-only` session reads them but cannot add one. `tomverse memory show`
  lists this folder's notes and `tomverse memory clear` deletes them;
  `tomverse config set memory off` stops all reading and writing.

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

### Rewind and fork

Every user message of a session is a turn: a task's prompt, or a message you sent while it ran.
The session records where the conversation and its list of file changes stood just before each one.

- `/rewind` (interactive) lists the turns and asks which one to go back to. It then shows what
  would be put back, newest change first, which files would conflict, and which commands ran in
  that part (their effects cannot be undone), and asks what to rewind: `b` files and conversation,
  `f` files only, `c` conversation only. A file is put back only if it is still exactly what the
  session wrote, the same check as `tomverse undo`; a file you edited since is left alone and
  reported as a conflict, and so is an earlier change to the same file that waits behind it. The
  message that was taken out is shown so you can edit it and send it again. The model is told
  what was and was not put back, so its next request does not rest on history that no longer
  matches the folder. A rewind is recorded in the session. It is refused while a task runs,
  waits for an approval, or has an unknown outcome, and the conversation cannot be cut at a turn
  that a compaction folded into a summary (the files still can).
- `/fork [n]` and `tomverse sessions fork <session> [--turn <n>]` copy the conversation through
  turn `n` (all of it by default) into a new session and touch no file. The original stays as it
  was; the copy starts with no changes of the original to undo, no requests and no approvals, and
  continues with `tomverse resume <new id>`. Sessions saved by an older CLI have no turns and
  cannot be rewound or forked.

## Support

- Windows (PowerShell), macOS (zsh) and Linux (bash), with Node.js 22 or
  later or as a standalone executable (see Install). Each release is built and
  tested on every one of these systems before it is published.
- Terminal text is English; Korean and other Unicode input, file names and
  output work.
- Not in this version: MCP, plugins or skills, a code index or
  LSP, worktrees, IDE or desktop apps, background agents.

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
