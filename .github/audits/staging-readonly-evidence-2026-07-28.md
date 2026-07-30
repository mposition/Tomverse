# Staging read-only evidence — 2026-07-28

Read-only observation of staging. **No provider call was made and no credit
was consumed to produce anything in this document.**

| | |
|---|---|
| Host | `https://staging.tomverse.app` |
| Staging SHA | `3989f4aa9e3b2bad8d162091d3f63881b24488ee` (`origin/develop` tip) |
| Staging deployment | `a14df4c4-eb76-4c6e-a181-e4b2caf5e570`, deployed 2026-07-28T06:47:42Z |
| Working branch | `claude/tomverse-insight-ux-audit-lubmn6` @ `14e89ae` |
| Queried at | 2026-07-28T06:52:10Z (both endpoints in parallel) |

**The SHAs differ.** Staging does not carry the WO-001–WO-004 changes, so
nothing here is evidence *for* those fixes. It is evidence about what
`origin/develop` currently ships — and it confirms that two P1 defects the
fixes target are live right now.

## UX-F002 — status page and model API contradict each other

Both endpoints were queried in parallel; `/api/models/status` reported
`generatedAt: 2026-07-28T06:52:11.427Z`.

`/status` provider states: 10 Operational, 3 Degraded, **2 Incident**, 1 Unknown.

| Provider | `/status` | `/api/models/status` |
|---|---|---|
| Perplexity | **Incident** (reason cites 202 consecutive failures) | 4 models, all `available` |
| Groq | **Degraded** | 3 models, all `available` |
| every other provider | Operational / Unknown | `available` |

All 33 models report `available`, and every one carries
`fallbackModelIds: []`. Not one model reflects its provider's state, and no
model offers a fallback — in the same second the public status page calls two
providers Incident and Degraded.

`providerStatus` is absent from every row, confirming the model API has no
notion of the public projection at all: it derives availability from the
internal health enum instead.

The Perplexity reason is the frozen-evidence case the audit described. It is
not a probe target, so a historical failure count keeps it pinned at Incident
regardless of current behaviour.

## UX-F003 — a retired model is still on offer

```json
{ "id": "llama-4-scout", "provider": "groq", "status": "available", "fallbackModelIds": [] }
```

`lib/models.ts` has this model delisted, disabled, status `disabled`, with
`replacementModelId: "llama-3-3"`. The public API serves it as available and
names no replacement. This is the runtime-registry divergence: the bootstrap
only ever inserted the static catalogue, so retiring the model never reached
the row that already existed.

## Not verified

WO-010 (real 3-model comparison, AI Review, credit/refund reconciliation) was
**not** performed. Two things block it, and neither is a spending question:

1. **Staging runs a different SHA.** Results against `3989f4a` cannot serve as
   evidence for work built on `e062da86`. Putting the working branch on
   staging is a deployment, which is a separate approval gate from spending.
2. **No authenticated staging account.** Guests are gated by Turnstile before
   a provider is reached, and AI Review is behind a login wall, so the run
   needs credentials that are not available here.

Spending approval alone does not clear either. Both remain **N/V**.
