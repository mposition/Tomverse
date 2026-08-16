# Raising `IMAGE_GROUP_MAX_MODELS` to 3 — operator runbook

The code change that produced this document does **not** change any
environment variable, any Railway setting or any feature flag. It makes the
composer ask the server what the limit is instead of assuming one. With the
variable unset the limit stays **2**, and the composer now offers two models
rather than offering three and having the third refused on submit.

Raising the limit to 3 is a separate, operator-performed change. This is the
order it happens in.

## Why it is not simply set

Three providers are active (`gpt-image-2`, `grok-imagine-image-quality-20260403`,
`fal-ai/nano-banana-2`), and a three-model comparison has never run anywhere.
The two-model fan-out is the one with evidence behind it. What a third target
changes is not the UI — that is covered by tests — but the shape of one
request: three provider jobs started from one workflow slot, three reservations
in one transaction, three budgets touched at once.

None of that is expected to fail. It has simply not been measured, and the
first measurement should not be a customer's.

## Prerequisite

`IMAGE_GROUP_MAX_MODELS` is read by `imageGroupMaxModels()` at call time, so it
takes effect on the next boot of the process. A Railway variable change causes
a redeploy; **budget-style variables are safe to change this way** — unlike
`CLOUDFLARE_ORIGIN_SECRET`, this value is used only inside the application, so
the old container keeps working correctly with the old value until the new one
replaces it. There is no window in which two systems disagree.

## Staging

1. Set `IMAGE_GROUP_MAX_MODELS=3` in the **staging** environment only.
2. Wait for the deployment to reach terminal `SUCCESS`. Do not read the next
   step's result from a container still serving the previous build.
3. Confirm the composer now offers three: the selection count reads `3/3` once
   all three are chosen, and the quoted total is the sum of the three per-model
   prices.
4. Submit **one** three-model comparison.
5. Confirm all three targets exist and reach a terminal state — one card per
   target, `openai`, `xai` and `fal` each represented.
6. Confirm per-model reservation and settlement: `settledCredits` equals
   `reservedCredits` for each, and each settled cost sits under the
   900 µUSD-per-credit ceiling.
7. Confirm each generated asset's signed URL resolves.
8. Confirm provider budget usage moved on **each** provider's own bucket —
   `GET /api/admin/image-generation`, `providerBudgets[]`, not the legacy
   top-level `budget`, which is OpenAI-only.

Record the result where the other image verification runs live:
`docs/ops/image-generation-staging-verification-records/`.

## Production

Only after staging passes, and as its own approved change:

1. Set `IMAGE_GROUP_MAX_MODELS=3` in the production environment.
2. Wait for terminal `SUCCESS`.
3. Read `providerBudgets[]` back and confirm nothing else moved.
4. Run one three-model comparison as the operator, before anyone else does.

## What this does not authorise

- **Turning the limit to 4.** Four is the parser's ceiling, not a product
  decision; a fourth active model does not exist.
- **Changing the compiled default.** The default stays 2. A deployment opts in
  by setting the variable; a deployment that sets nothing keeps the behaviour
  it has today, and the composer agrees with it either way.
- **Any change to `IMAGE_INLINE_MODEL_DISCOVERY_LIMIT`.** It is 3 for its own
  reasons and the two numbers matching is a coincidence.

## If the limit is ever lowered again

Nothing needs undoing in the tree. A composer that loads after the change
offers the lower number; a tab already open keeps the older one and its request
is refused by admission with `IMAGE_MODEL_SELECTION_INVALID`, which the client
now renders as the server's own limit rather than a generic retry. A selection
restored from a comparison made at the higher limit is cut down
deterministically and says which models did not fit — and the stored group is
left exactly as it is.
