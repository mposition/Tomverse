# Agent office CLI monitor

Owner request, 2026-10-25: implement the approved Figma monitor and connect one
AMUX worker for read-only observation. Owner follow-up, 2026-10-26: extend the
same owner-only, read-only view to the remaining 12 resident AMUX workers.
The scope is the existing 13-name office roster (Codex, Claude, Cursor and
Copilot), without changing worker registration, dispatch, stdin or execution.

The collector reuses the existing loopback AMUX `GET /api/sessions/<worker>/transcript`
and `GET /api/sessions/<worker>/peek?lines=80&live=1`, accepting only the approved
resident names. It does not start a CLI,
send a prompt, register a worker, alter dispatch or make a model call. The
structured Codex conversation and tool output come from the existing rollout.
Claude supplies its existing AMUX text transcript. Cursor and Copilot currently
supply no transcript, so their view shows the actual terminal viewport. The
panel identifies the supplied format; text without role metadata is displayed
as output, without inferring prompts or responses. The Raw output tab always
shows the current terminal viewport. Source events have no
timestamps: the UI labels the snapshot capture time, not invented event times.
Reasoning and unknown event kinds are omitted.

## Data and access

- Only an authenticated owner with recent admin authentication can read
  `GET /api/admin/office/cli-monitor?worker=<worker>`. Reads are rate limited
  and private/no-store. No browser mutation or stdin endpoint exists.
- A dedicated ingest-only secret protects `POST /api/internal/amux/cli-monitor`.
  It is separate from the bridge and worker credentials and never reaches a CLI
  process or the browser. The collector service has no product DB credential.
- The existing secret scanner hides entire matching events before truncation.
  The app repeats masking before buffering. Masking is best effort: arbitrary
  confidential prose is not guaranteed detectable. Treat this as owner-only
  operational content, never a public/shareable transcript.
- Per worker: at most 80 events, 4,000 characters per event, an 8,000-character terminal
  excerpt and 65,536 UTF-8 bytes total. The collector caps source responses at
  1 MiB. Request deadlines bound reads and ingestion. No output enters logs.
- Only the latest snapshot for each of the 13 names is held in volatile application memory, expiring
  independently after 15 minutes (at most 832 KiB of serialized snapshots total).
  The read route selects exactly the requested worker; switching workers unmounts
  the old browser poll and clears its content. No transcript DB table, file, audit payload or permanent
  history is created. A 20-second reporting gap displays Reconnecting.
- This monitor requires **one long-running app replica**. Restarts clear
  the buffer; the next collector report restores it. Multi-replica operation
  and historical execution retention require a separate shared buffer.
  The selector currently names only the current session.
- Pause updates freezes browser polling, not the agent. Scrolling up suspends
  auto-follow; Jump to latest resumes it. Closing unmounts and aborts polling.

## Local verification and activation

Local PC, PowerShell, repository root, Node 22 and installed dependencies;
no production credentials and no external writes:

```powershell
node --conditions=react-server --import tsx --test tests/agentOfficeCliMonitor.test.mjs
node scripts/verify-agent-office-cli-monitor.mjs
```

The browser check uses installed Playwright Chromium, compiles the actual office
and monitor components, and serves synthetic telemetry on loopback. It verifies
entry, read-only controls, literal text rendering, search/raw tabs, pause/resume,
expansion/Escape, stale output, mobile width and reauthentication content clearing.
It prints the temporary screenshot/report directory on success.

Ubuntu execution host, bash, a checkout containing this patch with Node 22 and
`tsx` installed. This reads the real `codex-impl` source and prints only
counts/kinds, never transcript content. First provision the public AMUX trust
certificate as described below. No product credentials or paid calls:

```bash
node --import tsx scripts/amux-cli-monitor.mjs --check-source
```

The default switch is off. Production merge/deployment remains a separate
operator action; review must cover the finished security boundary before
activation. For the single-worker pilot, configure the app and collector with
`TOMVERSE_AMUX_CLI_MONITOR=1` and the same dedicated random secret (at least 32
characters) in `TOMVERSE_AMUX_CLI_MONITOR_SECRET`. On the collector only, set
`TOMVERSE_INTERNAL_URL` to the app's HTTPS origin. Never paste secrets into chat.

On the collector only, set `TOMVERSE_AMUX_CLI_MONITOR_SOURCE_CA_B64` to the
base64-encoded public AMUX certificate obtained through trusted host
administration. Verify its SHA-256 fingerprint before provisioning it. This
trust anchor is used only by the fixed loopback HTTPS reads. Certificate chain
and hostname verification remain enabled; a missing or untrusted certificate
stops capture. No global TLS trust setting is changed, and ingestion to Tomverse
continues to use normal public CA verification. Never supply the AMUX private key.
Certificate rotation requires the operator to verify and update this trust
anchor, then restart the collector. `--check-source` also requires this setting.

The provided systemd unit expects an operator-installed checkout at
`/opt/tomverse-cli-monitor` and a root-owned mode-600 environment file at
`/etc/tomverse-cli-monitor.env`. It runs under a dynamic account, accepts no
stdin and does not read worker homes. The explicitly trusted loopback AMUX
certificate is verified; ingestion to Tomverse verifies TLS and
rejects redirects. Stop the collector or turn the app switch off to disable
the view. Disabling and credential rotation make every old worker buffer unreadable.

### Execution host without sudo

The separate Ubuntu operator account `tomverse-admin` can instead install the
user unit from `scripts/systemd/user/`. **Never install it as the AMUX worker
account `tommy`, or any account running monitored workers.** The distinct UID
keeps workers from reading the ingest credential, modifying the collector or
signalling it. File modes and a sandbox alone do not protect against the same
UID. It requires lingering and the host's existing Bubblewrap installation.
Bundle the exact release's `scripts/amux-cli-monitor.mjs` with esbuild for Node
ESM, and install it as `~/.local/share/tomverse-cli-monitor/collector.mjs`.
Bundling avoids installing a checkout and npm dependencies on this account;
the system unit above uses an operator-managed checkout with `tsx` instead.
Keep that directory and `~/.config/tomverse-cli-monitor/` mode 700, the bundle
and `collector.env` mode 600, and copy the unit to `~/.config/systemd/user/`.
The environment file contains only the collector settings above, the public
AMUX trust certificate setting and the optional worker selection below.

The user unit runs Bubblewrap directly: only `/usr`, DNS/hosts/TLS files and
the collector directory are mounted read-only. Home directories and the host's
runtime sockets are absent. A private PID namespace and `/proc` expose only
the sandbox's own processes; `/tmp` is private. It removes inherited SSH/GPG
agent and user-bus variables. This explicit sandbox is required: the execution
host's per-user systemd accepted filesystem-hardening properties without
actually applying them during verification. Do not substitute those properties
for Bubblewrap or fall back to an unsandboxed command.

It does not inherit a worker's environment or read worker homes. Before
enabling it, run `--check-source` with the same sandbox and verify a `--once`
ingest under the actual unit settings.
Use `systemctl --user enable --now tomverse-amux-cli-monitor.service` only after
the app release and dedicated credential are ready. This starts the collector;
it does not launch or change any monitored worker.

### Expanding the existing collector

The collector defaults to `codex-impl` when
`TOMVERSE_AMUX_CLI_MONITOR_WORKERS` is absent. The app accepts only the current
13-name resident roster. Unknown names, duplicates, generic URLs and arbitrary
API paths are refused. Each selected worker polls independently, so an
unavailable source does not stall the other workers.

After the finished boundary review and app release, update only the existing
operator collector bundle and add this non-secret selection to its mode-600
environment file, keeping the existing ingest credential and public CA:

```text
TOMVERSE_AMUX_CLI_MONITOR_WORKERS=claude-chore,claude-contract,claude-impl,claude-review,codex-chore,codex-contract,codex-impl,cursor-chore,cursor-impl,cursor-worker,copilot-chore,copilot-impl,copilot-worker
```

Run the same sandboxed `--check-source` with this selection and the public CA,
without loading the ingest credential. It reports counts and kinds for each
worker, never conversation content. Then restart only
`tomverse-amux-cli-monitor.service` and verify each worker in the production
owner office. To roll back the collection scope, set the selection to
`codex-impl` and restart that same unit. No worker restart, registration or paid
call is involved.

From the Ubuntu operator account's bash, verify the installed bundle without
credentials or external writes (this reads only the existing worker output).
Store the verified public certificate at
`~/.config/tomverse-cli-monitor/amux-source.pem`. The check clears its environment
and receives only this public certificate; do not load `collector.env` for it:

```bash
systemd-run --user --wait --pipe -p NoNewPrivileges=yes \
  -p 'RestrictAddressFamilies=AF_INET AF_INET6' \
  /usr/bin/bwrap --die-with-parent --new-session \
  --unshare-pid --unshare-ipc --unshare-uts \
  --ro-bind /usr /usr --symlink usr/bin /bin \
  --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --ro-bind /etc/hosts /etc/hosts \
  --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /etc/ssl /etc/ssl \
  --ro-bind "$HOME/.local/share/tomverse-cli-monitor" /app \
  --proc /proc --dev /dev --tmpfs /tmp --chdir /app \
  --clearenv --setenv HOME /tmp --setenv PATH /usr/bin \
  --setenv TOMVERSE_AMUX_CLI_MONITOR_SOURCE_CA_B64 \
    "$(base64 -w0 "$HOME/.config/tomverse-cli-monitor/amux-source.pem")" \
  /usr/bin/node /app/collector.mjs --check-source
```
