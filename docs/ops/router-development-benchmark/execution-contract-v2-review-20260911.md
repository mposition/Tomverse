# Benchmark v2 execution-contract slice: review and bounded follow-up

## Historical result and subsequent authorization

The actual Claude round-2 verdict is **`approve` with one documentation nit**.
The controller's terminal result is separately **`on_hold`**, reason
`revisions_exhausted`, with that finding recorded as `unresolved_on_hold`.
Both records are preserved unchanged. This document neither reopens the
exchange nor converts its terminal result into an automated pass.

After that result was reported, the user replied **"네 그렇게 해주세요"** to
the proposal to correct the one documentation attribution, preserve the hold,
and proceed with a PR on a separately recorded acceptance basis without
another Claude call. That is the bounded human publication decision recorded
here, not a fabricated user timestamp, signature, release-gate approval, or
permission for another paid benchmark. It does not erase the historical
finding or authorize production activation.

The follow-up contains the attribution correction in
`docs/ops/router-development-benchmark/execution-contract-v2.md`, this new
record, and a separately user-authorized reporting instruction in `AGENTS.md`.
That instruction requires meaningful future development reports to state
overall Chat progress, the completed work, and ordered next recommendations
with reasons and approval/review needs; it is not part of the historical
reviewed scope. The attribution correction names the CLI test suite, not the
smoke command, as the source of the genuine A/B journal regression. No
additional Claude review was run for these documentation changes; the earlier
code verdict does not cover this later record, instruction, or corrected
document bytes. Runtime source, tests, package scripts, controller, guards and
original evidence are unchanged by this follow-up.

## Frozen review identity

- Task: `router-development-v2-contract`.
- Author: Codex; independent reviewer: actual Claude Code CLI, version
  `2.1.261`, not a Codex simulation or a human review panel.
- Base commit: `66932b07e44f565eb9e91bea5cd0daf8bc3e9eba`.
- Final reviewed source: `13bf802a066f77e962d29d3447e8b1371ce9c13a`.
- Final reviewed diff:
  `sha256:fd77d0a253b64d4a4c5f84896dfde91f3c53b07e701fc1a931334e2af037a140`.
- Original scope: seven files, no diff exclusions. The later evidence document
  is outside that frozen scope.
- Round-2 execution started at `2026-09-11T05:28:39.895Z`; the verdict wrapper
  records a duration of `282567` milliseconds. These are execution metadata,
  not a timestamp assigned to the user's approval.

The reviewer used the existing controller with `--safe-mode`, strict MCP
configuration, and only `Read,Grep,Glob`. The user's task-specific reply
**"이번 작업에 한해 허용"** authorized `--skip-preflight` for the initial
review and at most two fix reviews. Preflight was **skipped, not passed**;
no refused-write preflight was observed. Tests, guards, digest binding and
revision limits remained enforced. The authorization did not permit API-key
billing fallback, failed-execution retries, paid provider runs or a finding
waiver. CLI-reported cost fields are estimates, not invoices or proof of
incremental subscription charges.

## Review history and dispositions

| Round | Source prefix | Actual Claude verdict | Findings | Controller after review | Package tests |
| --- | --- | --- | --- | --- | --- |
| 0 | `914c84a8` | `request_changes` | 1 error, 1 warning, 2 nits | `awaiting_revision`; four `fix_requested` | 217/217 |
| 1 | `77674255` | `approve` | 3 nits | `awaiting_revision`; three `fix_requested` | 219/219 |
| 2 | `13bf802a` | `approve` | 1 documentation nit | `on_hold`; one `unresolved_on_hold` | 221/221 |

The full earlier source commits are
`914c84a80de54ce6108f23b08eb13254d2d26219` and
`776742559f77e85190c45f197be1155ec7522ac8`. Their diff digests are respectively
`sha256:1ebacf6a59567cd378456033388af4495372cb4aa963f4c7c94350f8dd858d37`
and `sha256:42e7bc3146abd432f42d90dbc6ce8e547cb08b0bd09f64eac5da7432a1a87e77`.

An internal P2 cross-manifest receipt-binding correction preceded round 0;
it is not attributed to Claude. Claude round 0 then requested four changes:
collect a genuine B journal for the A/B regression, validate raw journal bytes
inside the observation boundary, count terminals rather than intents, and
return explicit missing-observation holds. Those changes are in round 1,
whose actual verdict states the four findings were addressed.

Round 1 called its three remaining notes optional, but the controller retained
them as `fix_requested`. The final source reconstructs authoritative contracts
through the existing plan/manifest validators, records the measured resume
call increase as `recoveredRows`, and retains the manifest digest in synthetic
answer origin metadata. Claude round 2 states all three are closed in code.

The sole round-2 nit concerns attribution: genuine A/B journal collection and
cross-run rejection are tested by `tests/routerDevelopmentExecutionCli.test.mjs`
through `npm run test:router-development-execution`. The standalone smoke
command builds one manifest and does not report an A/B result. The later
one-clause correction names the test suite; its disposition is addressed in
documentation outside the terminated exchange, not retroactively resolved in
the archived controller record.

## Verification and archive preservation

The final package records **221 passed, 0 failed, 0 cancelled, 0 skipped and
0 todo**: execution contracts/CLI 26, existing benchmark 96, collector 80 and
Replay 19. All six guards passed: official typecheck, scoped lint, encoding,
document references, policy-section references and base-relative diff checks.
These are controller/author execution records. Claude had read-only tools and
read the evidence; this record does not claim Claude independently executed
the test commands. They are historical source checks, not newly rerun tests
of this documentation-only follow-up.

All archived files were read back against their recorded byte size and
SHA-256 before writing this record: round 0 has 16 entries, round 1 has 20,
and round 2 has 24, with zero mismatches. Archives are local under
`H:/Project/router-development-v2-contract-evidence-20260911/`; these paths
are not remote publication or a guarantee of permanent external availability.

| Archive directory | `ARCHIVE-MANIFEST.json` SHA-256 |
| --- | --- |
| `round0-preserved-914c84a8` | `a7e09ff60950a3ac8b7af8a0def0628730bb5ffa38f509006512b5206dabb24b` |
| `round1-preserved-77674255` | `a23d7f7edeaa5d47d5ac054e0b8f2f6eb4e870eea292b17023fcac258bd1e619` |
| `round2-preserved-13bf802a` | `3a85293e5833cd1e523e7e7e837b3d6fbdc13a97e9628e9a9c939785a36e3976` |

Key files within the final archive:

| File | SHA-256 |
| --- | --- |
| `exchange.json` | `6c7fbb68b7d012213cac01d2ab2aa2cf43ee0ab012c531d10e8885e4994e6832` |
| `verdict-round2.json` | `54355ec4c660baa50aedb9f8fbf3dab1f758905732076f464826ee486595a2dc` |
| `change-round2.diff` | `fd77d0a253b64d4a4c5f84896dfde91f3c53b07e701fc1a931334e2af037a140` |
| `package-round2.json` | `0071541ef8a891555b59b4a5fc1dd944933dbcfb515eeea18923c0a52ef02943` |
| `execution/frozen-round2.json` | `c9afa0c4a26ab4e5f04b6dd974d8930129284ee87c765fb82edd14f6b42f93c9` |
| `execution/review-round2.execution.json` | `e07b27012fd8a163ec579fe90736c8acbfd7fa777ef5b31d6fff02eeb2865cdb` |
| `execution/package-round2.tests.json` | `61038f0b8f3981db67b4e3d9cd87db794c821c1d51cba7acd5d8b8fd8419b82f` |
| `execution/REVIEW-AUTHORIZATION.json` | `68b7e77d2fdf9b3c82e46fb8e50a8dafe41d47b6c49763669e2f012456114820` |

The authorization receipt's recording time is not a claimed user-message
timestamp. The subsequent publication decision is recorded separately above;
the original review authorization and raw JSON records are not rewritten.

## What the evidence demonstrates, and what it does not

The final fixed smoke report is local at
`H:/Project/router-development-contract-smoke-13bf802a-20260911/report.json`,
SHA-256 `0b72a37896cbd779887c43636a291c213925f97b02b8f7314ba9caaf9fbbfeb3`.
It records the frozen source as clean, two terminals before interruption,
six recovered adapter calls, eight final terminals and zero completed-row
redispatches. The uncertain scenario records one intent, zero terminals and
an export refusal. These values were read from the saved report, not inferred
from a future provider run.

The eight predetermined mock rows contain four correct, one incorrect, one
blank, one invalid JSON and one acquisition failure. The full plan remains
1,008 rows: 8 mock observations, 648 refused and 352 eligible but unrun.
Unobserved rows are not losses, and the whole-population quality delta is not
manufactured from the observed subset.

Provider calls and incurred provider spend are zero. Unsupported TTFT,
end-to-end latency and provider-billed cost remain null, as does the product
performance delta; product execution remains unverified. Local journal/digest
consistency does not authenticate providers. There are no human labels, new
paid observations, demonstrated model-quality gains, whole-catalogue optimum,
or release approvals here. Production Router, catalogue, pricing, flags,
release gates, v1 corpus and the previous 60-call artifacts remain unchanged.
The 48-case corpus, real collection proposal and Chat integration remain later
work: this initial execution-contract slice is not all of Benchmark v2.
