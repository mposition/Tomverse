# Compare combined Router and location decisions in Chat

`CHAT_ROUTER_LOCATION_FUSION_ENABLED` defaults to off. On an eligible first
Smart Adaptive question, the existing Router also decides whether the answer
needs the user's current device location. It reads the original message up to
8,000 characters for this decision. Its model-selection input retains its
ordinary 4,000-character limit.

Use these treatment settings with the location classifier enabled
(`TOMVERSE_CHAT_LOCATION_INTENT_ENABLED=true`) and a configured live Router.
Keep the model pool and `CHAT_ROUTER_PRESEARCH_ENABLED` identical across both
arms of a location experiment. Refiner follow-up preparation has its own switch.

| Treatment | `CHAT_FRESH_LOCATION_PREPARATION_ENABLED` | `CHAT_ROUTER_LOCATION_FUSION_ENABLED` |
| --- | --- | --- |
| Separate decisions | false | false |
| Combined decision | false | true |
| Early standalone preparation on builds that support it | true | false |

On first turns, early standalone preparation takes precedence when both switches are true. The signed-in browser proposes fusion for a saved first text
question with one active panel and no Refiner decision. The server checks
the saved turn, current access, conversation settings and actual router
eligibility. Guests, existing grants, suppressed automatic location and other
ineligible turns use their usual paths.

For a follow-up in a signed-in Smart Adaptive conversation, enable
`CHAT_EXISTING_ROUTER_LOCATION_FUSION_ENABLED=true` in addition to
`TOMVERSE_CHAT_LOCATION_INTENT_ENABLED=true` and `CHAT_ROUTER_LOCATION_FUSION_ENABLED=true`.
The follow-up switch defaults off and is independent of early *first-turn*
preparation. To isolate it, leave both master switches on and change only
the follow-up switch. No model, credit, search or GPS settings need to change.

A participating follow-up carries `routerLocationScope: "existing"` on its
initial request and any permitted resume. The Router uses ordinary conversation
and Refiner context to pick a model, but the location question is about the
most recent **authored** message. A location mention in earlier history or in a
rewrite is not a new request for device location. The current question must
already be saved. A panel with a manual location decision, an attachment turn,
or a turn outside the single-panel text path retains its ordinary handling.
When the follow-up is eligible, its separate location classifier is skipped,
including the one that would otherwise run alongside automatic Refiner preparation.

The browser sends participating turns to `POST /api/chat/router-location`.
A negative decision streams the answer on the same request. A positive
decision lets the browser obtain consent for the saved turn and return the
sealed Router selection with any permitted location. Declining permission
continues the answer without coordinates. An omitted location decision can
use the standalone classifier. Current authorization, context and routing
inputs are rechecked on resume. A content-free database claim permits a
single resume within five minutes and binds the saved source question even if
a caller supplies another answer ID. Both location paths share the same
account and IP limits. A confirmed limit refusal lets ordinary Chat continue
without another automatic location lookup. Expired claims are removed by the existing
maintenance job; deleting the conversation cascades to its claims.

In a mixed deployment, an initial 404 from an older build lacking the
versioned endpoint uses the ordinary path. A lost or refused resume does not
trigger a second paid Router call.

For browser QA, use a local worktree with dependencies installed and a
production build. Run PowerShell at the repository root. Playwright's
fixture environment serves the app locally. Run each arm against a newly
started server so its environment matches the intended flags.

```powershell
$env:E2E_CHAT_LOCATION_INTENT_ENABLED = 'true'
$env:E2E_CHAT_FRESH_LOCATION_PREPARATION_ENABLED = 'false'
$env:E2E_CHAT_ROUTER_LOCATION_FUSION_ENABLED = 'true'
npx playwright test tests/e2e/chat-unified-workspace.spec.ts --project desktop-chromium --grep 'Router location'
```

Repeat with `E2E_CHAT_ROUTER_LOCATION_FUSION_ENABLED=false`. For real-model
assessment, pair the same Korean and multilingual questions, named places,
quoted requests, and cases with the deciding instruction after character
4,000. Record model selection, permission requests, answers and sources,
and count all paid calls and refusals. Compare signed browser first-text
and completion p50/p95 and the fraction at or below 10 seconds. Include
the initial submission and any permission wait or resume. The final POST's
server duration alone omits the initial Router request for a positive decision.
The separate [search comparison](./chat-presearch-comparison.md) measures
whether presearch removed an answering-model round trip.

For the dedicated existing-turn browser regression, keep the two master
switches on, set `$env:E2E_CHAT_EXISTING_ROUTER_LOCATION_FUSION_ENABLED` to
`'true'`, and repeat with `'false'` after restarting the server. Select the
existing-turn cases with `--grep 'existing Auto|saved existing turn'`.

For a follow-up A/B, use two identical conversations with the same saved user
and assistant history. Avoid reusing the previous trial's answer as the next
trial's history. Alternate arm order. Confirm that OFF sent a standalone
location request and ON received a combined Router decision; do not count an
alias compatibility fallback as a successful combined decision. The live
`chat_auto_llm_router.routerLocationScope` field is `existing` on these
combined Router calls, `fresh` on combined first turns and null for ordinary
calls. A consent resume reuses a decision and does not produce a second paid
Router call. Record separately any missing signed client timing, manual location
grants, search corpus replays and changes in the answer-model mix. Report the
number of completed searches at or below 10s as well as the p50 and p95.

### Existing-turn real-model comparison (2026-11-11)

One Chromium worker sent each Korean follow-up five times per arm in alternating
order against the same production build, with the same saved neutral history.
Only the existing-turn switch varied. The classifier, router and answer models
were real; the search adapter replayed identical official BOM and NASA evidence.
The answer model pool was GPT 6 Luna and Qwen 3.8 Flash. These are controlled
browser measurements, not production percentiles. Each cell is p50 / p95 seconds
from Send; with five samples per arm and question, p95 is the maximum.

| Question | First text OFF | First text ON | Complete OFF | Complete ON | Complete within 10s OFF → ON |
| --- | ---: | ---: | ---: | ---: | ---: |
| Brisbane weather | 8.11 / 8.77 | 6.23 / 9.14 | 14.02 / 19.61 | 12.93 / 16.65 | 0/5 → 0/5 |
| Voyager UTC launch dates and difference | 7.40 / 10.45 | 6.43 / 8.09 | 10.96 / 13.12 | 9.63 / 12.09 | 2/5 → 4/5 |
| Both questions (equal weights) | 7.82 / 10.45 | 6.23 / 9.14 | 11.95 / 19.61 | 12.09 / 16.65 | 2/10 → 4/10 |

Standalone location calls fell from ten to zero; both arms made ten router and
ten answer-model calls. Nine of ten pairs selected the same answer model. Eight
of ten paired completions improved, but pooled median completion did not. This
change alone did not meet the 10s completion p95 target for either question.
