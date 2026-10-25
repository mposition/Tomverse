# Agent office CLI monitor pilot

Owner request, 2026-10-25: implement the approved Figma monitor and connect one
AMUX worker for read-only observation. The pilot is fixed to `codex-impl`.

The collector reuses the existing loopback AMUX `GET /api/sessions/codex-impl/transcript`
and `GET /api/sessions/codex-impl/peek?lines=80&live=1`. It does not start a CLI,
send a prompt, register a worker, alter dispatch or make a model call. The
structured conversation and tool output come from the existing Codex rollout;
the Raw output tab shows the current terminal viewport. Source events have no
timestamps: the UI labels the snapshot capture time, not invented event times.
Reasoning and unknown event kinds are omitted.

## Data and access

- Only an authenticated owner with recent admin authentication can read
  `GET /api/admin/office/cli-monitor?worker=codex-impl`. Reads are rate limited
  and private/no-store. No browser mutation or stdin endpoint exists.
- A dedicated ingest-only secret protects `POST /api/internal/amux/cli-monitor`.
  It is separate from the bridge and worker credentials and never reaches a CLI
  process or the browser. The collector service has no product DB credential.
- The existing secret scanner hides entire matching events before truncation.
  The app repeats masking before buffering. Masking is best effort: arbitrary
  confidential prose is not guaranteed detectable. Treat this as owner-only
  operational content, never a public/shareable transcript.
- At most 80 events, 4,000 characters per event, an 8,000-character terminal
  excerpt and 65,536 UTF-8 bytes total. The collector caps source responses at
  1 MiB. Request deadlines bound reads and ingestion. No output enters logs.
- Only the latest snapshot is held in volatile application memory, expiring
  after 15 minutes. No transcript DB table, file, audit payload or permanent
  history is created. A 20-second reporting gap displays Reconnecting.
- This first pilot requires **one long-running app replica**. Restarts clear
  the buffer; the next collector report restores it. Multi-replica operation
  and historical execution retention require a separate shared buffer before
  expanding scope. The selector currently names only the current session.
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
counts/kinds, never transcript content. No product credentials or paid calls:

```bash
node --import tsx scripts/amux-cli-monitor.mjs --check-source
```

The default switch is off. Production merge/deployment remains a separate
operator action; review must cover the finished security boundary before
activation. For the single-worker pilot, configure the app and collector with
`TOMVERSE_AMUX_CLI_MONITOR=1` and the same dedicated random secret (at least 32
characters) in `TOMVERSE_AMUX_CLI_MONITOR_SECRET`. On the collector only, set
`TOMVERSE_INTERNAL_URL` to the app's HTTPS origin. Never paste secrets into chat.

The provided systemd unit expects an operator-installed checkout at
`/opt/tomverse-cli-monitor` and a root-owned mode-600 environment file at
`/etc/tomverse-cli-monitor.env`. It runs under a dynamic account, accepts no
stdin and does not read worker homes. Only the existing loopback AMUX
self-signed certificate is accepted; ingestion to Tomverse verifies TLS and
rejects redirects. Stop the collector or turn the app switch off to disable
the view. Disabling and credential rotation make the old buffer unreadable.

### Execution host without sudo

The existing Ubuntu operator account can instead install the user unit from
`scripts/systemd/user/`. It requires lingering and unprivileged user namespaces.
Bundle the exact release's `scripts/amux-cli-monitor.mjs` with esbuild for Node
ESM, and install it as `~/.local/share/tomverse-cli-monitor/collector.mjs`.
Keep that directory and `~/.config/tomverse-cli-monitor/` mode 700, the bundle
and `collector.env` mode 600, and copy the unit to `~/.config/systemd/user/`.
The environment file contains only the three collector settings above.

This variant mounts only the bundle directory into an otherwise hidden home,
makes the filesystem read-only, hides `/proc` (including other processes'
credentials), and prohibits mount changes. It does not inherit a worker's
environment or read worker homes. Before enabling it, run `--check-source` with
the same sandbox and verify a `--once` ingest under the actual unit settings.
Use `systemctl --user enable --now tomverse-amux-cli-monitor.service` only after
the app release and dedicated credential are ready. This starts the one fixed
collector; it does not activate any other worker.
