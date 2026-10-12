# v22 Task worker metadata

The resident AMUX roster, legacy product admission catalog and v22 Task
profiles are different inventories. A running session is not execution
permission; neither its name nor its CLI model alias proves a served model.

`TOMVERSE_AMUX_WORKER_CATALOG_JSON` remains the legacy product admission
catalog. Its CLI providers, legacy roles and lifecycle exclusions are not
rewritten by the v22 loader.

`TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON` is a separate server-only JSON array.
Each profile must name an already-admitted worker and explicitly declare its
one-shot provider, model, Task roles and tools. For example (not an activation
or price approval):

```json
[
  {
    "worker_name": "claude-chore",
    "provider": "anthropic",
    "model": "claude-opus-5-5",
    "routing_roles": ["investigate"],
    "tool_capabilities": ["repo_read"]
  }
]
```

Only the existing Anthropic one-shot path is supported: `design`, `implement`,
`review` and `investigate`. Read-only roles require `repo_read`; `implement`
requires `repo_write`. Unsupported roles/providers, aliases, unknown fields,
duplicates or names absent from product admission hold the whole v22 catalog.
Missing configuration also holds it; there is no inferred legacy fallback.
An unprofiled resident is not removed from the legacy inventory, but is not a
v22 candidate. Catalog capacity is bounded at 128, not seven.

Task readiness, automatic admission capacity and worker claim all use this
same profile subset. Static `archived`, `paused`, `isolated` and `blocked`
exclusions remain inherited. Profiles cannot set runtime liveness or
dispatch readiness. Existing approval, approved cost receipt, runtime lease,
role/tool match, quota, dependency, reserved-capacity and review-independence
checks still apply.

Setting this variable is an operational change requiring the usual approval;
this document and its example do not set it or open any switch. To withdraw
new v22 candidates, remove this variable; legacy routing remains intact. Do
not replay an in-flight or unknown-outcome request during a configuration
change. Reconcile its app receipt first through the existing owner path.

## Task-profile quota reporting

Implementation repair approved by mposition on 2026-10-12 for end-to-end
verification. This completes the existing quota comparison, not a new
worker permission, role, graduation exception or cost allowance.

The fixed sidecar reads subscription quota from the same `CLAUDE_CONFIG_DIR`
used for its Task process. The native roster's account reading is not a
substitute. API-key helpers, alternate-backend/auth settings, unsafe or
expired credentials, unsupported/malformed windows and failed provider
reads produce no observation. No model call, login or token refresh occurs.
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
