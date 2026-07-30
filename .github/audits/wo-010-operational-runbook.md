# WO-010 — authenticated staging operational verification (runbook)

Verifies what no automated test can: that a real 3-model comparison and AI
Review actually complete against live providers, and that credits reserved,
consumed and refunded reconcile.

**Status: N/V — not executed.** See *Why this was not run* at the end.

Everything below is written to be executed by a person in a normal browser.
Do not automate it: guest automation is blocked by Turnstile before a provider
is reached, which is the protection working, not a defect.

## Before starting

```
Staging SHA:        ____________  (must match /api/build-info)
Deployment ID:      ____________
Account used:       ____________  (staging-only, never a production account)
Date / timezone:    ____________
Operator:           ____________
```

1. Open `https://staging.tomverse.app/api/build-info` and record `commitSha`.
2. Confirm it matches the branch you intend to verify. **If it does not, stop
   here** — results against another SHA are not evidence for that branch.
3. Record the credit balance **before** anything else (account → usage, and
   the ledger if you have access). This is the baseline the reconciliation
   depends on; it cannot be reconstructed afterwards.

## Budget and stop conditions

| | |
|---|---|
| Comparisons | 3 runs × 3 models |
| AI Review | 1 run |
| Expected spend | ~9 credits (comparisons) + ~4–8 (Review) = **≤ ~17** |
| Web search | **off** for every run |

**Stop immediately, record state, and do not retry if:**

- two or more panels fail on the first comparison, or
- actual credits consumed exceed the expected figure above, or
- the status page and the observed behaviour disagree.

A stop is a result, not a failure of the exercise. Record what happened.

## Runs

Use a short, harmless prompt with no personal or sensitive content, e.g.
*"In two sentences, what is the difference between a list and a tuple?"*

Do not paste customer data, credentials, or anything you would not want in a
provider's logs.

### Comparison ×3 (default 3-model, web search off)

For each of runs 1–3 record:

| Run | Models | All 3 panels completed? | Latency (approx) | Credits before | Credits after | Δ | Trace IDs |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |

### AI Review ×1

| | |
|---|---|
| Completed? | |
| Credits before / after / Δ | |
| Trace ID | |

## Reconciliation

The point of the exercise. Fill in all four:

| | Value |
|---|---|
| Expected credits (from the composer's own estimate) | |
| Reserved credits | |
| Actual credits consumed | |
| Unused reservation refunded | |

Expected, reserved and actual must agree, and any unused reservation must come
back. A mismatch is a P1 defect — raise it with its own ID rather than
adjusting the numbers here.

## Also record

- Keyboard-only: could the comparison, Review and retry each be completed
  without a pointer? (feeds the accessibility matrix)
- Any contradiction between `/status`, `/api/models/status` and what the
  picker/banner showed at the same moment.
- Desktop is required. A mobile smoke pass is welcome but optional.

## Redaction

Trace IDs and model IDs are fine to record — model IDs are not secrets. Never
record API keys, tokens, cookies, session identifiers, or prompt/response
bodies.

## Why this was not run

Two blockers, neither of which is about willingness to spend. Spending was
approved; these are separate.

1. **Staging carries a different SHA.** At the time of writing staging ran
   `3989f4a` (`origin/develop`), not the working branch. Deploying the branch
   was considered and explicitly declined, so a run would have verified
   develop rather than the work under review.
2. **No usable authenticated login.** Guests are gated by Turnstile before any
   provider is reached and AI Review sits behind a login wall, so the run
   needs a real account. Email login to `claude1@tomverse.app` was authorised,
   but `tomverse.app` has **receiving disabled** in Resend (sending only), so
   the login code cannot be collected. Enabling inbound mail is a change to
   the account's email infrastructure — including DNS — and was not in scope.

Clearing either one is enough to make this runbook executable: deploy the
branch to staging *and* supply a staging-only account, or run it by hand on
whatever SHA you intend to certify.
