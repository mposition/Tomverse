# v22 Task worker metadata

The resident AMUX roster, the assignment catalog and v22 Task profiles are
different inventories. A running session is not execution permission; neither
its name nor its CLI model alias proves a served model.

The assignment catalog is derived from the worker registry (orchestration
policy version 35, section 3; every assignment path reads it since stage R2c).
A worker is an entry when its desired state is `active`, no automatic stop
latch is open and a capability is recorded; `engineering-runner` is a code
constant. Stage R2e removed `TOMVERSE_AMUX_WORKER_CATALOG_JSON` and
`TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON` from the app: neither is read, so
setting either changes nothing, and Admin no longer imports from them.

A worker's v22 one-shot profile is part of its recorded capability: model,
Task roles and tools. Only the owner records a capability, one worker at a
time, through `POST /api/admin/amux/workers/capabilities` (owner role, R2a's
code latch, a recent step-up, and the human audit `amux.worker.capability` in
the same transaction). AMUX › Operations settings › Workers shows what is recorded.

Only the existing Anthropic one-shot path is supported: `design`, `implement`,
`review` and `investigate`, on a Claude worker and a supported model.
Read-only roles require `repo_read`; `implement` requires `repo_write`. A role
the worker's role ceiling does not allow is refused when written and dropped
when the catalog is derived, so a narrowed ceiling takes effect without a new
capability. An unprofiled worker stays in the assignment catalog but is not a
v22 candidate.

Task readiness, automatic admission capacity and worker claim all use this
same profile subset. Holding a worker back is the registry's desired state and
stop latch; a profile cannot set runtime liveness or dispatch readiness.
Existing approval, approved cost receipt, runtime lease, role/tool match,
quota, dependency, reserved-capacity and review-independence checks still
apply.

A worker leaves the v22 candidates when the derived catalog stops listing its
profile: its desired state is no longer `active`, a stop latch opens, or its
newest capability has no v22 profile. Each of those is an operational change
requiring the usual approval; this document opens no switch. Do not replay an
in-flight or unknown-outcome request during such a change. Reconcile its app
receipt first through the existing owner path.

## Task-profile quota reporting

Implementation repair approved by mposition on 2026-10-12 for end-to-end
verification. This completes the existing quota comparison, not a new
worker permission, role, graduation exception or cost allowance.

The fixed sidecar reads subscription quota from the same `CLAUDE_CONFIG_DIR`
used for its Task process. The native roster's account reading is not a
substitute. API-key helpers, alternate-backend/auth settings, unsafe or
expired credentials, unsupported/malformed windows and failed provider
reads produce no observation. No model call, login or token refresh occurs.
Both the fixed CLI profile's global settings and its fixed HOME global
settings are checked; project and managed settings cannot select another
authentication path either. Settings reads are bounded at 256 KiB and the
credential file at 64 KiB. An explicitly reported zero/no-reset optional
model window is inactive, not a fabricated availability measurement; the
required account/session windows still need valid future resets.
The OAuth token is used only for one bounded HTTPS GET to Anthropic's usage
endpoint; it never enters the bridge, app, audit, error output or journal.

The bridge asks its fixed worker socket at most every five minutes, after
renewing active execution leases. It forwards only the worker, provider,
remaining/confidence basis points, exhaustion, source, observed/reset times
and a new observation UUID. The app validates the v22 catalog, time window
and strict schema, serializes that UUID, and commits the observation and
existing canonical system audit together. A duplicate with identical facts
returns the original row; a different payload cannot replace it. Late
transaction commits remain subject to the existing DB deadline fence.
The canonical audit-chain lock precedes observation locks/inserts. The
bridge uses the existing fifteen-second lifecycle transport limit, covering
the normal app connection/transaction budget without an artificial five-
second cutoff; this is not a guarantee of the durable COMMIT phase.

A lost POST reply permits exact authenticated GET lookup only, never another
POST. A matching row resolves the outcome; absent/conflicting/unreadable
evidence stops new bridge assignments. An unavailable read is unknown, not
zero quota or invented availability. The existing fifteen-minute freshness
rule remains unchanged. Restarting a bridge makes a new provider observation,
not a replay of an old write or execution.

Boundary checklist: no Chat, Memory, finance or user-credit access; existing
AMUX sync identity/system actor only; no human approval is minted; fixed
numeric external data only, never model instructions; no product credential
in the sidecar/CLI; existing observation schema/single writer/90-day retention;
no LLM spend; existing stop/claim switches and worker exclusions remain;
UUID-bound exact lookup for uncertain writes; same vendor account usage
channel, no idea or repository transmission; canonical audit has identifiers
only; no geographic or data-processing expansion; synthetic checks then
review/CI before installation; existing Ubuntu sidecar/bridge split; app DB
and Admin remain authoritative. Publishing and deployment of Task results
are outside this repair.
