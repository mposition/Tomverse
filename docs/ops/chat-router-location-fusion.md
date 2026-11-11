# Compare Router and location decisions on a new Chat

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

When both experiment switches are true, early standalone preparation takes
precedence. The signed-in browser proposes fusion for a saved first text
question with one active panel and no Refiner decision. The server checks
the saved turn, current access, conversation settings and actual router
eligibility. Guests, existing grants, suppressed automatic location and other
ineligible turns use their usual paths.

The browser sends participating turns to `POST /api/chat/router-location`.
A negative decision streams the answer on the same request. A positive
decision lets the browser obtain consent for the saved turn and return the
sealed Router selection with any permitted location. Declining permission
continues the answer without coordinates. An omitted location decision can
use the standalone classifier. Current authorization, context and routing
inputs are rechecked on resume. A content-free database claim permits a
single resume within five minutes and binds the first saved question even if
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
