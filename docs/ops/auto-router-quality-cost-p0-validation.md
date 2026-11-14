# Auto quality and cost P0 validation

Local implementation based on `origin/main` at
`5b5a83998adec8d555a3aab2d309608b3d05851c` (2026-11-14). A fresh fetch
found no later main commits. Work uses an isolated implementation worktree;
the existing working checkout was not edited.

Node 22.22.2, Next.js 16.4.5. Dependencies were installed with `npm ci` from
this checkout's lockfile, into its own directory without a dependency junction.
The lockfile was unchanged. The installed Next.js route and client guides were
read. npm reported an existing officeparser patch-version engine warning.

## Implemented behavior

- Questions and prior answers preserve both ends within the existing 4,000/600
  UTF-16 limits, with a missing-middle marker and safe surrogate boundaries.
  The final request, permitted sample, replay and hold share this representation.
- Actual soft-excluded candidates constrain normal selection and file-capable
  fallback. The minimum-two exception and requested-model recovery remain.
- Guidance freezes before holdout calls; no current holdout comparisons,
  failures or verdicts enter generation. Existing evaluation answer/judge
  caches, output caps, call slots and retry limits remain.
- Routing and rewrite retain known/no-dispatch/unknown cost observations,
  usage/rate coverage and failures in existing summary JSON. Unknown cost
  closes further scheduling and drains in-flight work.
- Manual/system promotion share evaluation/version/coverage and existing
  quality/credit gates. Legacy promotion is unverified; active guidance and
  rollback remain usable. Settings and recommendation gates remain separate.
- Admin separates known calculated cost, unconfirmed totals, catalog credit
  ratio, quality status, gate basis, own-answer counts and proxies.

## Local checks

Counts are per suite group and can overlap; they are not production samples.

| Group | Result |
| --- | --- |
| Router/optimizer/rewrite/quality/shadow/recommendation/office focused tests | 286 passed |
| `npm run test:auto-router-limited-release` | 142 passed |
| Client/render regressions | 35 passed |
| Final request/Chat route/recommendation server contracts | 138 passed; request suite rerun with extra edge case: 38 passed |
| Existing offline development corpus/benchmark/replay/quality gates | 220 passed |
| Isolated PostgreSQL 17 optimizer/rewrite/tunables/recommendations | 47 passed; optimizer/rewrite rerun 33 passed |

The bilingual fixtures cover 12 situations in Korean and English: short
messages, extraction, arithmetic, format, translation, long tails, follow-up
references, corrections, negations/exceptions, code, freshness and tools.
Eight regression groups cover holdout isolation, freeze/cache reuse,
own/proxy/order evidence, cost states, unknown closure/promotion, Admin
denominators, candidate/capability/attempt contracts and legacy/stale/
automation/settings/recommendation/rollback boundaries.

Static checks use `npm run lint -- <changed files>` and `npm run typecheck`
with `NODE_OPTIONS=--max-old-space-size=8192`. The default 4GB Node heap was
insufficient for this repository. Full typecheck, changed-file lint and
`git diff --check` passed.

The database was created on localhost specifically for this task, using the
existing migrations. No new migration was added. Negative adapter tests remove
provider keys and block fetch; no successful provider generation is performed.

Independent review job `r-20261114-133156-6d48a4` accepted the completed
permission/cost boundary at `111ee710942e8c10d13d71a95298db0ba669687e` with
two independent vendors. Minor follow-up clarifies the generator's pre-cycle
evidence rule, unverified running-state copy and timeout consequences, and
adds a no-file-capable-menu regression. The reviewed boundary is unchanged.
With no file-capable offered candidate, the actual parser returns invalid;
the existing requested-model recovery handles that failure. A new hard-menu
file fallback was not added. Running/legacy cycles correctly count as having
unconfirmed total cost. Guest Auto keeps its separate authority path.

## What remains unmeasured

No paid evaluation, live optimizer cycle, provider quality comparison or
production rollout was run. These tests establish code behavior only. The
tool-free optimizer does not validate attachment, search, file, Memory or
continuation Chat E2E success. Rewrite semantic quality and production cost
savings remain unmeasured. Family overlap, synthetic bias and use of the same
optimizer model for generation/judging remain experimental limits.

Known costs are reported usage multiplied by configured token prices, not
provider invoices or total Chat cost. Accepted in-flight overshoot and the
existing run/day/month ledger/admission contract remain. This P0 does not
guarantee a total-spend ceiling or reconcile unknown historical charges.

P1 remains lower-cost challenger measurement, signed-in affordability and
reservation/unknown-cost reconciliation. No PR, CI activation, live setting,
budget, AMUX send, merge or deployment is included in this local validation.
