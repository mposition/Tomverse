# Tomverse Desktop: cloud execution and managed credits

Status (2026-11-26): **cloud execution does not exist.** Nothing in this repository runs a person's project on a Tomverse server. What exists is a credit-reservation path for model calls that the server makes (`POST /api/code/managed`). Desktop can show and use the reservation half of it, behind a default-off switch. This page separates what was checked in the repository from what was not, and lists what a real cloud execution needs.

## What the repository has (checked)

`POST /api/code/managed` (`app/api/code/managed/route.ts`, `lib/codeManagedCore.ts`, `lib/codeManagedService.ts`, `lib/codeManagedProvider.ts`; policy in `docs/policy/code-task-cost-guardrails.md` section 10):

| Action | What it does |
| --- | --- |
| `reserve` | Holds the credits the person approved (`approvedCredits`) against two pinned models from the published coding catalogue (`catalogVersion`, `contentHash`). The executor and the reviewer must come from different providers. Idempotent on `taskId` plus the same body. |
| `complete` | One server-made model call with a JSON schema. The server calls the provider, checks the output against the schema, settles the call from the provider's verified usage, and returns the value. No tools, no streaming, no files, no commands. |
| `heartbeat` | Extends the reservation's lease (120 seconds; 30 seconds recommended). |
| `release` | Closes the reservation and returns what was not used. The `terminalReason` the client sends is accepted and not stored. |
| `status` | The receipt, and the state of one call when `callId` is given. |

It is authenticated as a web page is: a session cookie, a same-origin `Origin`, and `X-Tomverse-Code: 1`. It is off unless `CODE_MANAGED_EXECUTION_ENABLED=true`. Unknown outcomes (a call that may have reached the provider) keep their hold until an owner reconciles them through `POST /api/admin/code/managed-reconciliation` (off unless `CODE_MANAGED_RECONCILIATION_ENABLED=true`).

So it is a **metered, server-made structured completion**, not a sandbox: it never sees a repository, never runs a command, and holds no workspace. Reading the code, the question "where is the project?" has no answer on the server side.

What the repository does not have, checked by searching `apps/`, `docker/`, `crates/`, `lib/`, `app/` and `.railway/`:

- No client of `/api/code/managed` anywhere. `apps/tomverse-cli` does not call it (its gateway uses the coding API, `/api/code/v1`, with an API key and the key's credit cap). The policy documents name the intended client, the separate Tomverse Code product, which is not in this repository.
- No container, VM, job queue or worker that runs a customer's code. The Dockerfiles in `docker/` and `apps/tomverse-orchestrator` run Tomverse's own agents (engineering, operations, research, trust and safety); they hold no customer repository and are not reachable by customers.
- No server-side checkout or storage of a customer repository, and no way to bring a result back to a PC.
- `docs/ops/desktop-sandbox.md` and the Windows/macOS/Linux sandbox are local operating-system sandboxes for commands on the person's own computer. They are unrelated to a server environment.

## What Desktop does today

Desktop > Settings > Execution and limits > **Cloud and managed credits** (visible only when the server reports `desktopManagedCode`):

- **Where Code can run.** A read-only list: this computer and a separate worktree (available), another computer over SSH (not set up; the remote lane fills this in), and Tomverse cloud (not available: needs server infrastructure that does not exist yet). `apps/desktop/src/execution-location.ts` is the one place that describes the locations. Choosing a location is not wired to starting a task.
- **Managed credits.** The person picks an executor and a reviewer from the server's catalogue, types the credits to hold, reads "Hold up to N credits for A and B?" and confirms. Desktop sends `reserve`, then keeps the reservation alive from the main process (`heartbeat`, every `heartbeatIntervalMs` the server gave, between 1 and 60 seconds), and shows the server's receipt: reserved, held now, still available, settled, returned, and held with unknown outcome. Release returns only what was not used. When the server closes a reservation itself (lease expired, interrupted), the window shows the server's record and says so.
- Desktop does not compute a price, an estimate, a settlement or a charge. It sends model ids, the approved amount and a reservation id; every number on screen is a receipt value. There is no estimate step because the server has no estimate route: the approved amount is the person's own cap, and the server settles each call within it.
- The client also contains `complete` (one call, sent once; a lost answer is asked about with `status` and the call id, never sent again). **Nothing in Desktop calls it.** No managed runner is connected in this build, so a reservation today only holds credits until it is released or the app stops. The screen says so.
- The reservation travels over the **account settings session** (`POST /api/auth/desktop/settings-session`, a five-minute web-equivalent session the main process mints from the Desktop bearer), exactly as billing and connectors do. No bearer route was added (`lib/nativeBearerGate.ts` is unchanged) and `tests/desktopManagedCodeSwitch.test.mjs` pins that.

If the app quits or the person signs out with a reservation active, the keep-alive stops, the lease runs out after 120 seconds, and the server returns the unused credits on its next maintenance pass (`reconcileExpiredCodeTasks`, the existing 15-minute cadence) or the next time the reservation is read. Nothing is lost; the return is not instant.

### Switches

| Where | Variable | Default | Effect |
| --- | --- | --- | --- |
| Server | `CODE_MANAGED_EXECUTION_ENABLED` | off | The existing switch for `/api/code/managed`. |
| Server | `TOMVERSE_DESKTOP_MANAGED_CODE_ENABLED` | off | New. Lets `/api/products/chat/capabilities` report `desktopManagedCode`. Needs `TOMVERSE_DESKTOP_AUTH_ENABLED`, `TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED` and `CODE_MANAGED_EXECUTION_ENABLED` as well (`lib/desktopManagedCodeSwitch.ts`). |
| Desktop | none | | The section is shown only when the server reports `desktopManagedCode`; the main process refuses the IPC action otherwise. |

Turning these on makes a reservation hold the person's real credits (refundable on release). It does not call a model. It needs the migration `20261022000000_code_managed_execution` applied and a published coding catalogue snapshot, both already part of the managed path's own rollout.

## What cloud execution would need (not built; none of this is confirmed to exist)

1. **A server-side execution environment.** A per-task isolated environment (container or microVM) that can run commands and a coding agent loop, with no access to Tomverse's own databases, secrets or internal network. Sizing, region, cold start, and idle teardown are open. Nothing of this kind is in the repository; the closest, the AMUX orchestrator and agent images, are internal and must not be reused for customer code.
2. **A job queue and lifecycle.** Create, start, stream progress, cancel, time out, and clean up; at most N per account; survives a server restart; never leaves an environment running after the task ends. The reservation path's lease and heartbeat are a ready pattern for "the owner went away" but there is no worker to attach them to.
3. **Getting the repository in.** The options and their costs: (a) Desktop uploads a snapshot (a bundle of the working tree, or a git bundle plus a diff) over the account session, so no credential is stored on the server; (b) the server clones from the host over a credential the person grants (a GitHub App installation or a short-lived token). Option (b) adds a stored credential, which is a security boundary decision and is not made here. Option (a) is the smaller one; its size limit, secret filtering (the agent's own refusal list for credential files must apply to the upload) and retention are open.
4. **Getting results back.** The Desktop review panel already works on a patch against a local worktree. The natural return is a patch (or a git bundle) the person reviews in that panel and applies locally; the cloud environment never pushes. Anything that leaves Tomverse (push, pull request) stays behind the existing Desktop approval card on the person's PC.
5. **Model access from the environment.** Either the existing coding API with a key capped for that task (the Desktop path today), or the managed reservation path above. The managed path only returns structured completions, so it cannot drive a tool-using agent without a server contract change; that change is in billing and credit code and needs the contract review. The coding API path already supports tool use and a key cap, and is the smaller step.
6. **Billing.** Two separate meters: model calls (already metered by key cap or by reservation) and compute time. There is no compute-time meter, price or credit weight. Adding one touches `lib/modelPricing.ts` and the credit ledger, an irreversible area that needs an independent review and an owner decision.
7. **Security boundary.** Egress rules for the environment, secret handling (the person's repository can contain secrets the model must not read), abuse and cryptomining controls, data retention and deletion, and the privacy and terms text for code leaving the person's computer. The Australian company's privacy obligations (APP) apply to repository contents held on a server; mainland China is out of scope.
8. **Desktop changes once 1 to 6 exist.** The `cloud` row in `describeExecutionLocations` becomes available, task start gets a location choice, and a cloud task is shown in the existing task list with the same approval cards. These are small compared with the server work.

## Decisions the operator needs to make

1. Whether to build cloud execution at all, and with which isolation technology and provider. This is paid infrastructure; nothing here authorizes it.
2. How the repository gets in: Desktop-uploaded snapshot (no stored credential) or a granted credential (security decision).
3. Which model meter drives a cloud task: the coding API with a task-capped key, or a new tool-capable managed contract. The second changes the managed server contract.
4. The compute price and its credit weight (touches pricing and credits).
5. Whether to turn on `TOMVERSE_DESKTOP_MANAGED_CODE_ENABLED` for a test account to try the reservation screen. It holds real credits (released on demand) and calls no model.
6. Whether the account settings session may keep carrying paid-adjacent routes. This change reuses it for `/api/code/managed`, as billing does; the alternative is a Desktop bearer route for it, which is a change to the authentication boundary.

## Operator test procedure (test account on the dev or Test environment)

1. Server: set `TOMVERSE_DESKTOP_AUTH_ENABLED`, `TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED`, `CODE_MANAGED_EXECUTION_ENABLED` and `TOMVERSE_DESKTOP_MANAGED_CODE_ENABLED` to `true` in the test environment only; confirm the coding catalogue has a published snapshot.
2. PC, Tomverse Desktop: sign in with the test account. Open Settings > Execution and limits. A section "Cloud and managed credits" appears under the command sandbox.
3. It lists This computer and a separate worktree as Available, and SSH and Tomverse cloud as Not available; cloud says it needs server infrastructure that does not exist yet.
4. Choose an executor and a reviewer from different companies, type a small amount such as 20, press Review reservation, read "Hold up to 20 credits for ...", press Hold 20 credits. The reservation shows Active with 20 reserved, 20 held, 20 still available.
5. Check the plan balance in Settings > Plan: the hold should show as credits no longer available (this was not checked against a real environment). In Desktop wait a minute: the reservation stays Active (the keep-alive is running).
6. Press Release unused credits. It shows Closed, 20 returned, and "Released as cancelled. The unused credits were returned." The plan balance is back.
7. Hold another reservation, then quit Desktop. After about two minutes plus the next maintenance pass, the balance returns by itself.
8. Turn `TOMVERSE_DESKTOP_MANAGED_CODE_ENABLED` off and restart Desktop: the section is gone.

## Verification that ran locally

`apps/desktop`: `tests/managedCodeClient.test.ts`, `managedCodeSession.test.ts`, `managedCodeContract.test.ts` (fake server that checks requests against the server's own `codeManagedRequestSchema`) and `tests/managedCode.e2e.ts`. Root: `tests/desktopManagedCodeSwitch.test.mjs`. No paid call was made; nothing here contacted a real server.
