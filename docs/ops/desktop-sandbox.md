# Command sandbox for the Tomverse agent (Desktop and CLI)

Status: implemented behind a default-off setting (`sandbox: off`). Desktop phase 4, item P4-3 (G13, G15).
Code: `apps/tomverse-cli/src/sandbox.ts`, `sandbox-windows.ts`, `net-proxy.ts`. Desktop settings screen:
Settings > Execution and limits > Command sandbox.

## What it is

An operating-system sandbox around the commands the agent runs (`run_command`, foreground and background).
It does not touch the file tools: `apply_patch` and the read tools are already confined to the working folder
by the app itself and by the approval step. In Desktop the working folder is the folder the agent works in, which for a
task in a managed worktree is that worktree. The Desktop terminal panel, MCP servers and hooks run outside the sandbox
with the person's own access (the settings screen says so).

| Setting | Meaning |
|---|---|
| `off` (default) | Nothing is added. |
| `workspace-write` | The command can write the working folder and a temporary folder, and nowhere else. |
| `read-only` | The command can write nowhere. |

Network: a filtering proxy that lives in the app process is given to the command as `HTTP_PROXY` / `HTTPS_PROXY`.
It checks only the host name (HTTPS is tunnelled with CONNECT and never opened), allows only ports 80 and 443,
resolves the name itself and connects to that address, and refuses loopback, private and link-local addresses
unless that exact IP address is on the list. The default list is package registries only: `registry.npmjs.org`,
`registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`, `crates.io`, `index.crates.io`, `static.crates.io`,
`proxy.golang.org`, `sum.golang.org`. The person edits it in the settings screen (one host per line, `*.example.com`
for subdomains) or with `tomverse config set sandbox-domains a.test,b.test`. An empty list means no network.

Fail closed: when the sandbox is on and cannot be built on this computer, the launcher throws and the command is not
started. The tool result says why ("The sandbox is turned on but cannot be created here, so the command was not run:
...") and the settings screen shows the reason. A command is never run without the sandbox because the sandbox failed.
A working folder that is a drive or filesystem root, the home folder, or a folder that contains it is refused the same way.

## What is enforced, per platform

"Checked" means a test in this repository ran it. macOS and Linux could not be run: the development PC is Windows 10.

| | macOS (Seatbelt) | Linux (bubblewrap) | Windows (low integrity) |
|---|---|---|---|
| Writes limited to the working folder + temp | enforced (profile; **not run**) | enforced (arguments; **not run**) | **enforced, checked** |
| `read-only` writes nowhere | enforced (**not run**) | enforced (**not run**) | **enforced, checked** |
| Credential folders cannot be read (`~/.ssh`, `~/.aws`, gcloud, kube, `.npmrc`, `.netrc`, `.git-credentials`, keychains, `~/.tomverse`, the app's own data folder) | enforced (**not run**) | enforced (**not run**) | **not enforced** |
| `.git/hooks`, `.git/config`, `.gitmodules`, `.tomverse`, `.mcp.json` stay read-only inside the working folder | enforced (**not run**) | enforced if the path exists (**not run**) | enforced if the path exists, **checked** for `.git/hooks` and `.git/config` |
| Network: only the proxy | enforced by the profile (**not run**) | enforced: the command has its own network namespace and the proxy's Unix socket is relayed in by `socat` (**not run**); without `socat` there is **no network at all** | **not enforced**: the proxy address is only an environment variable |
| Localhost | blocked unless "Allow connections to localhost" | the sandbox has its own localhost; the setting has no effect | not restricted |
| Processes and children | ended with the command (process group, then SIGKILL) | `--die-with-parent`, own PID namespace | job object `KILL_ON_JOB_CLOSE`: the whole tree ends with the launcher |

Not enforced anywhere, and not claimed: reading ordinary files; asking a process outside the sandbox to act on the
command's behalf (an IDE, a running daemon); on Linux, connecting to a Unix socket that exists in the file system (the
Docker socket is the usual one), because the network namespace does not cover file-system sockets; what an allowed site
is told (only the host name is judged); programs that ignore proxy variables on Windows; writes to places that are
already low integrity on Windows (`%USERPROFILE%AppDataLocalLow`, `TempLow` folders).

## Windows: the method, why, and what it changes on disk

Researched first. Codex's Windows sandbox has an elevated mode (separate sandbox users, firewall rules, needs
administrator approval) and an unelevated fallback (a restricted token derived from the current user with filesystem
boundaries set by ACLs; weaker network isolation, no deny-read). Claude Code does not sandbox natively on Windows
(WSL2 only). Neither elevated mode is possible here (no administrator rights, no firewall rules, no new accounts).

Chosen: **the command runs with a copy of the person's own token lowered to the Low mandatory integrity level**
(`CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE`, then `TokenIntegrityLevel = S-1-16-4096`), started with
`CreateProcessAsUser` suspended, put in a job object (`KILL_ON_JOB_CLOSE`, no clipboard, desktop switching, global
atoms, display settings or USER handles outside the job), then resumed. A Low-integrity process cannot write an object
whose label is higher, and ordinary files, folders, registry keys and other processes are Medium. The helper is
PowerShell plus .NET P/Invoke (`Add-Type`); no administrator rights, no driver, no firewall rule, no native module.

Measured alternative, rejected: the same token as a *restricted token with restricting SIDs* and an ACE for a
capability SID on the working folder (Codex's unelevated approach). It does confine writes, but a restricted token
fails the access check on any named pipe the process creates itself (the default pipe DACL names no restricting SID).
Node.js creates one for every child it spawns with piped output, so `npm test` and every test runner fail with `EPERM`
(`libuv` also needs `WRITE_DAC` on the pipe). Low integrity has no such problem; the Windows tests run a Node child with
piped output inside the sandbox.

Things found while building it, so the next person does not repeat them:

- The command's `TEMP` must be writable, or Windows PowerShell silently starts in ConstrainedLanguage (it writes a
  probe file there). The sandbox gives each run its own temp folder under `%USERPROFILE%\AppData\LocalLow\Tomverse`,
  which Windows already labels Low, and also points `APPDATA` / `LOCALAPPDATA` into it so package-manager caches work.
  In `read-only` mode the temp variables are left alone, so a tool that needs a temp file fails.
- The launcher names `winsta0\default` as the desktop. Without it, a parent on another desktop (the Electron utility
  process the Code runtime runs in) hands that desktop down and a Node child fails to start with `0xC0000142`.
- `CREATE_NO_WINDOW` on the sandboxed child makes it fail the same way; the child inherits the launcher's hidden
  console instead.
- Programs installed under `%LOCALAPPDATA%` or `%APPDATA%` (a per-user Python, `nvm` in AppData, `volta`) cannot be run:
  on the machine this was built on a Low-integrity process could not read those two folders at all. The launcher says
  so when it hits an access-denied start. This is Windows' behaviour on that machine and is **not relied on** as a
  protection; a different Windows may differ.

### The folder marker (the one permanent change)

A Low-integrity process can write only objects labeled Low. `workspace-write` therefore **labels the working folder
Low once** (`icacls <folder> /setintegritylevel (OI)(CI)L`): an inheritable mandatory label that Windows copies to the
files and folders already inside, and that new files inherit. This changes the security label of the files, not their
contents or timestamps. Junctions inside the folder are not followed (the label lands on the junction, not on its
target). 30,000 files took about 5 seconds.

Labeling needs the WRITE_OWNER right. On a drive where the account only has Modify (a data drive whose root gives
"Authenticated Users" Modify), the sandbox first adds **one inheritable permission entry granting the current account
WRITE_OWNER** on the working folder, then labels. `.git\hooks`, `.git\config`, `.gitmodules`, `.tomverse` and
`.mcp.json` are set back to Medium after labeling so a command cannot plant something that runs later outside the
sandbox. The folders touched are recorded in `sandbox-marks.json` in the sandbox's state folder.

Undo: "Remove markers" in the settings screen (or `clearWindowsMarks`) sets each recorded folder back to the Medium
label (the level every ordinary file has) and removes exactly the permission entry it added. Both are tested, including
the added-entry case on a folder where the account lacked WRITE_OWNER. Files that were Medium inside a labeled folder
(copied in later from another place with their own label) stay Medium, and a command cannot write them; nothing
re-scans.

## Where it applies

Desktop Code tasks on the Tomverse API path (the provider CLIs run their own sandboxes). The setting is read when each
task starts. The CLI reads `sandbox`, `sandbox-domains`, `sandbox-localhost` from `config.json`.
Background commands go through the same launcher.

## Unverified

macOS (Seatbelt profile) and Linux (bubblewrap arguments, `socat` relay) were never run. They are covered by
property tests on what the profile allows, denies and hides, not by a real sandbox. Run the Linux and macOS suites on
those systems before enabling the setting by default. The Seatbelt rules assume that later rules override earlier ones
and that `(deny network*)` followed by `(allow network-outbound (remote ip "localhost:PORT"))` works as written in
the Claude Code and Codex documentation; neither was confirmed on a Mac.
