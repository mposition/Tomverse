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
