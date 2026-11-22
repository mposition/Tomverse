# Research Preview integration verification

Recorded on 2026-11-22 in Brisbane. The local branch is `codex/research-preview-integration-to-develop`.

| Source | Revision |
| --- | --- |
| November 18 analysis main | `8dbe1309af5dcc3c707667d29f9db8fb773b996a` |
| Fetched main | `debe34842e1ae11a2cc04ce8061fb93f7c19f144` |
| Implemented on fetched develop | `4196d8e6593647017116185792dc5e8d4e8b1a0d` |
| Verified implementation | `873010a8bf21f8f3f007cf9111e65eb3ec09ae2d` |
| `package-lock.json` SHA-256 | `40914fb71b6bdf40a34dc7d2f0ccdd658e9c4bcfaa156f5b95c789ee894810b2` |

## Deployment and configuration evidence

| Item | Local evidence | Current dev and production evidence |
| --- | --- | --- |
| Web | The isolated Next build returned the verified implementation SHA from `/api/build-info`. Its build time was `2026-11-22T01:52:18.824Z`, and deployment ID and timestamps were null. The loopback server ran in Next's production mode. | Read-only web deployment results are recorded below. |
| Worker | The integration harness advances claims with fake transport. It also runs stale recovery with no worker. The service command is `npm run worker:research-preview`. | Worker deployment ID, source pin and actual command are unverified. |
| Database | Dedicated PostgreSQL 17.10 test cluster. Prisma recorded `20261115120000_research_preview_durable_runs` as applied and found no schema drift. This integration adds no migration. | Applied migration and schema are unverified. |
| Flags | Isolated cases exercise preview and durable flags on, page reading on, Native's server gate off, and Native browser transport with a fake offer. | Actual master, page-reading, durable and Native flag values and `RESEARCH_PREVIEW_MODEL_IDS` are unverified. |
| Model snapshot | Admission pins Google `gemini-3.1-pro-preview` and Google `gemini-4-argon` to their exact product IDs and checks the runtime allowlist. Local DB cases use a controlled model and frozen reservation. | Verify the enabled model, exact provider/API model, profile, reasoning, app-managed search backend, pricing version and rates against the frozen run and reservation. Current values are unverified. |

Public build info reported these deployments on November 22. The dev SHA matched fetched develop, and the production SHA matched fetched main. The implementation commit is local.

| Web environment | Reported revision | Deployment ID | Deployed at (UTC) | Reported status |
| --- | --- | --- | --- | --- |
| [Dev](https://dev.tomverse.app/api/build-info) | `4196d8e6593647017116185792dc5e8d4e8b1a0d` | `cb9e5170-b318-4a4d-9b94-5b5ac6caa1d8` | `2026-11-22T01:06:11.182Z` | success |
| [Production](https://tomverse.app/api/build-info) | `debe34842e1ae11a2cc04ce8061fb93f7c19f144` | `4431d5b7-dbc1-4e62-a868-0d85c33357c7` | `2026-11-21T10:05:34.464Z` | success |

The shared develop ref advanced to `6d1e1367178a0827f1d3385223a507ae61a2597b` during validation with a Memory launch approval change. A local merge-tree check found no conflicts with the implementation. Tests used the recorded implementation base.

The [November 15 Argon case](research-preview-p1-local-verification.md#accepted-review-and-dev-deployment) used upload source `ba6dccec5467629ac99712dae303b3961a73bac9`. At that time web deployment `a7a79b88-13e8-4535-8e1d-727959cc4521` reported a null commit SHA, and the clean source upload established its revision. Worker deployment `4202ba0f-7b9f-4afd-b1a1-225df6608fab` used the default worker command. The dev Argon profile used low reasoning and app-managed search at US$4 input and US$20 output per million tokens. These values describe the prior deployment.

## Offline quality materials

The existing CLI produced two previews under the loopback-only network guard. The previews share source digest `65716d1e60cc13916b0369ee35834a25f29a1e1385a57b364ba16b3fcd0e35f4`, use no reranking, and have no execution approval. The UTC expiry field is `2026-11-23T00:00:00Z`. Reserved amounts are manifest ceilings.

| Preview | Exact evaluation profile | Briefs | Generation / search / read ceiling | Reserved USD |
| --- | --- | --- | --- | --- |
| `argon-original-runtime.json` | Google `gemini-4-argon`, low reasoning, development rate `development-gemini-4-argon-standard-4-20-2026-11-15`, US$4/20 per million input/output | `official-compact-original`, `official-runtime-support` | 6 / 10 / 4 | $8.880568 |
| `pro-accessibility.json` | Google `gemini-3.1-pro-preview`, provider-default reasoning, catalogue rate `google-gemini-3.1-pro-preview-2026-08-01`, reserved long-context US$4/18 per million input/output | `official-web-accessibility` | 3 / 5 / 2 | $4.432416 |

Both snapshots use app-managed Brave search. The model IDs and rates above describe the preview inputs. Regenerating both previews on the verified implementation reproduced their manifest digests.

| Brief or fixture | Manual quality checks | Status |
| --- | --- | --- |
| `official-compact-original` | Confirm the official original was read and supports the purpose and limitations. Record publication and evidence dates separately. | Awaiting a report and source read. |
| `official-runtime-support` | Check each release classification against dated official evidence. Record missing, stale and conflicting evidence. | Awaiting a report and source read. |
| `official-web-accessibility` | Compare Korean claims with W3C wording, including the relevant WCAG level and the distinction between requirements and guidance. | Awaiting a report and source read. |
| Existing page-reader, evidence and report fixtures | Check that oversized, unsupported, DNS-rejected, redirect-rejected and truncated pages stay within the reader contract. Check that untrusted page instructions stay quoted, snippet fallback stays visible, and partial and insufficient reports remain distinct. | Passed with synthetic evidence. |

For each material claim, record the claim, source ID and URL, the supporting or conflicting passage, publication date, evidence date, and a manual rating of `supported`, `partial support`, `unsupported` or `not checked`. Record the declared outcome, whether it matches the evidence, which brief conditions the report satisfies, page read outcomes and clipping, latency, generation/search/read counts, known usage and frozen-rate cost, and any unknown cost. Source ID validity establishes citation integrity. The claim ratings require reading the evidence.

## Local checks and review

| Check | Result |
| --- | --- |
| Focused units | 168 passed, covering Research admission, budgets, execution, source and page evidence, metadata and evaluation, plus Native request boundaries, settlement and Perplexity. |
| Server contracts | 148 passed, covering Research offer and unlock, maintenance ordering and failure isolation, and ordinary Chat fallback. |
| PostgreSQL integration | 77 passed across six suites. Research persistence, route and durable runs account for 28. Perplexity submit, poll, credit and persistence account for 23. Chat search settlement and credit finance account for 26. |
| Web Chromium | 18 passed, including the saved RunCard, lost Resume readback, regular Chat follow-up containing the reloaded report in the outbound body, and Perplexity polling and suggestion flows. |
| Native Chromium fixture | 8 passed, including insufficient evidence, stale GET and late action responses, explicit Resume, attachment draft preservation and settings. |
| Settings unit and render regression | 43 passed. The Native tab state uses the existing Native-only tab type, fixing the develop type error exposed by this check. |
| Builds and static checks | Next production build, root and Native typecheck, Native Vite build, changed TypeScript ESLint, accent tokens and enum constraints passed. |
| Independent review | The initial implementation was accepted under `r-20261122-014504-ad8490`. The follow-up preparing activation lock and candidate lookup were accepted under `r-20261122-015219-060d5d` with no findings. |

With the original code, the PostgreSQL barrier test reproduced a stale recovery overwriting known completion as `outcome_unknown`. The initial review identified a second race. A separate barrier reproduced stale preparing recovery overwriting successful activation as `failed_with_reservation`. The final tests cover each completion/recovery winner, concurrent cancellation, an active lease staying active, activation preserving its queued reservation, and an unknown dispatch being settled once across repeated recovery. The dedicated runner applied the test database safety checks. The three Research suites belong to the `accounts` lane, Perplexity and credit finance to `finance`, and Chat search settlement to `routing`. The focused run left the lane filter unset to cover all six suites.

Two minor findings from the initial review remain open. An error in a per-run recovery or checkpoint expiry can defer the rest of that Research batch. An unparseable settlement record can stay in the bounded oldest-first selection. The maintenance tests show that a Research step failure still lets the surrounding maintenance proceed.

The browser suites exercised behavior with mocks and used no screenshot golden comparison. Device testing, live model quality, and current worker, DB and feature readiness remain open. The preview and local product tests used no live model, search or page-read calls.
