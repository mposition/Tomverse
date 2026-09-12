# Chat entry, single transcript and recovery — implementation slice v1

Status: local implementation and bounded verification recorded; independent
review, integration and rollout pending. This is not release approval.
Base: `14997bcfbfa90c9bc431efcbba7b0a9ae3490859` (develop).
Branch: `codex/chat-entry-transcript-recovery-20260912`.

## Outcome and boundaries

Connect a gated Chat workspace to the existing platform, preserve one transcript
across model changes, and make interruption recovery explicit without silently
dispatching another paid request. Keep Review and Studio behavior intact.

This slice does not activate flags, attest readiness, migrate product identity,
change `/chat`'s legacy meaning, persist unsent drafts, dispatch live providers,
or claim general stream resumption after a full page reload. Deployment and
public availability remain separate decisions.

The preceding PR #1367 merged as `409cf20d1225b33958a051d21ea938cb6b62ac6e`.
Its staging deployment `1a875926-ec67-41b9-9a98-56edbd596cac` was observed as
`SUCCESS` on 2026-09-12. The new base also includes later develop changes;
this observation does not certify those changes or this new slice.

## Phase 0 — discovered seams

Required contracts:

- [Product identity](../policy/conversation-product-key.md)
- [Auto UI](../ui-contracts/auto-model-selection.md)
- [Identity and concurrency](../policy/chat-concurrency-and-identity.md)
- [Memory-only drafts](../policy/conversation-draft-identity-scope.md)
- [Mobile composer](../ui-contracts/mobile-chat-composer.md)
- [Mobile drawer](../ui-contracts/mobile-sidebar-drawer.md)
- [Image workspace](../ui-contracts/image-generation-workspace.md)
- [Comparison rail](../ui-contracts/comparison-action-rail.md)
- [Delivery plan](../policy/tomverse-chat-delivery-plan.md)
- [Independent review process](cross-review/README.md)

Reuse `ReviewWorkspaceShell` server settings and `ChatPageClient`, not a second
composer, provider pipeline or billing service. `chatSurfaceAvailable` already
owns new Chat entry eligibility. The Chat creation endpoint fixes the product
server-side. Conversation GET supports all messages when `modelId` is absent.
The existing runtime owns controller-scoped abort, load tickets, revisions and
identity cleanup. Existing controlled-stream E2E fixtures allow paid-call-free
verification of interruption and navigation.

Next.js server page search parameters are asynchronous; follow the installed
`node_modules/next/dist/docs/` guide and the existing route pattern. Client
navigation preserves the relevant query rather than reconstructing unrelated
state. External reference: https://nextjs.org/docs/app/api-reference/file-conventions/page

## Phase 1 — additive product entry

1. Add `/chat/workspace` as the gated Chat route. Preserve `/chat`, `/review`,
   continuation and Studio legacy destinations.
2. Reuse shared workspace setup with explicit Chat/transcript mode. New entry
   requires the existing server availability decision; never derive it from a
   client query, flag alone, selected-model count or `kind`.
3. An owned existing Chat remains readable when eligibility disappears. An
   owned Review/Studio/continuation opens its own surface; no product rewrite.
4. Product-aware entry/history links use one shared destination rule. Chat
   creation uses `/api/products/chat/conversations`, not a body product field.
5. Chat permits one selected answer model per send, with explicit replacement
   in its picker; Review retains multi-model behavior. Do not rewrite account
   defaults or silently shrink stored profile/conversation selections. Refuse
   incompatible multi-model profile creation clearly rather than fan out.
6. Existing server Auto offered/manual-return rules remain authoritative.

Verify allowed/denied new entry, owned Chat after cohort loss, other-account
refusal, legacy destinations, Chat creation endpoint and one-request dispatch.

## Phase 2 — single transcript and bounded recovery

1. Add an explicit conversation transcript runtime namespace, separate from
   Review's model namespace and independent of the selected answer model.
2. Chat mounts one shared `ChatApp`; history loading keeps all models' messages.
   Busy, stop and load ownership follow that same runtime across model changes.
3. Final answer attribution follows the actual fallback/routed/requested model,
   never the currently displayed selection or a Planner. Preserve badge rules.
4. Preserve partial answer text after transport failure and render its recovery
   notice separately. Do not turn partial content into an error-title string.
5. Re-entering the same in-memory conversation reuses its active/partial runtime.
   Reload reads saved history only; it must not POST a new answer automatically.
6. A recovery action restores the specific failed question to the composer for
   explicit submission, including after reload. Never resend a different last
   prompt or suggest that a retry continues the original generation.
7. Do not wire model-specific destructive history clearing to a whole Chat
   transcript. No new draft disk persistence, blanket account migration or
   weakening of server ownership/billing/concurrency checks.

General stream partial persistence across a full browser reload and server-side
resumable attempts are not implemented by this client slice. Existing async
Deep Research reattachment remains its distinct persisted-job contract.

Verify A-to-B history and request context, changing selection during a stream,
stop, late history races, transport failure partial preservation, GET-only
reload, explicit retry from the correct prompt, identity isolation and existing
Review panel behavior. Use controlled mock streams, not live providers.

## Phase 3 — verification and independent review

Run focused runtime/product/client tests, relevant server contracts, typecheck,
scoped lint and repository guards. Run new Chat browser journeys and the mobile
composer/drawer/model-picker plus affected Review/Studio regressions against a
local mock setup. Do not re-record visual goldens to make a failure disappear.
Distinguish actual runs from definitions or unavailable device observations.

Local guard portability finding: the existing conversation-writer CLI passed
Windows backslash paths into a slash-based allowlist and reported 58 false
positives, including the shared creation service and fixtures. Normalize only
the filesystem-derived report paths; retain the core and allowlist unchanged.
Actual CLI fixture tests must both admit the existing allowed locations and
reject an unauthorized production writer. This correction is reviewed with the
slice, not treated as a waived or skipped guard.

### Recorded local verification — 2026-09-12

The final local build and browser runs below have persistent receipts under
`H:/Project/chat-entry-transcript-recovery-evidence-20260912/`. Each named
directory contains `command.json`, `output.log`, `result.json`, and
`source-before.json` / `source-after.json`. All six runs exited with code 0,
recorded `sourceUnchanged: true`, and had identical 39-file entry lists and
before/after scope SHA-256:
`e9e55ef3b7e96e22f25816943e1e3724e8c1b804b3e4dd097841b0bb2fcf409d`.
The receipts' Git HEAD is the base commit, because the implementation was still
uncommitted; the file hashes, not that HEAD alone, identify the tested bytes.

| Receipt directory | Actual observation | Boundary |
| --- | --- | --- |
| `final-build` | `npm run build` succeeded; `/chat/workspace` appears as a dynamic route | Local production build, not deployment |
| `final-chat-e2e` | 20 registered, 20 passed, 0 skipped, 0 failed; 25.8 seconds | Chromium mock journeys, including 320/390px composition/text-scaling checks |
| `affected-desktop-e2e` | 187 registered, 150 passed, 37 existing project-conditional skips, 0 failed; 1.6 minutes | Composer, drawer, picker, comparison rail, image workspace and conversation-switch regressions |
| `affected-mobile-e2e` | 130 registered, 82 passed, 48 existing project-conditional skips, 0 failed; 1.4 minutes | Mobile Chromium project: drawer, picker, comparison rail and image workspace |
| `final-typecheck` | `npm run typecheck` passed (`next typegen` and `tsc --noEmit --incremental false`) | Explicit typecheck, separate from build |
| `final-scoped-lint` | ESLint passed for 37 scoped JS/TS files with `--max-warnings=0` | Changed-file lint, not a claim about every repository file |

The browser total is 252 passed with 85 skips recorded separately; skips are
not passes. Two composer golden cases were excluded from the Windows affected
desktop invocation with `--grep-invert=golden`. Linux canonical-golden
verification is still outstanding: no golden was updated and no CI/test gate
was waived. The excluded cases are not included in the table's registered
counts. This local result does not certify physical keyboards, actual iOS/Safari
devices, real database persistence, production accounts or live providers.
Execution used a sanitized environment without inherited provider credentials;
provider calls were not made. Existing affected-suite logs include dummy
loopback database/verification refusals, not successful real-backend evidence.

The new Chat journeys cover single-request creation, model-switch history and
attribution, stream stop/re-entry, partial preservation, GET-only reload and
explicit question restoration. They also exercise changed selection during
context/message-save preparation, edited draft preservation, late creation and
unclassified-lookup responses, and account changes. Server ownership and
public-deployment fixture refusal are separately exercised by mocked server
contract tests, rather than claimed from the browser fixture cookie.

Earlier focused observations were runtime 54, SSR 4, server contracts 19,
entry/product pure tests 24 and writer/CLI tests 17, all passing when observed.
They are development observations, not receipts binding every one of those
runs to the scope hash above. The controller package must run and record them
again against its own frozen source. `pre-archive-observations.md` preserves
earlier browser/build observations and the corrected fixture failure; those
intermediate runs do not replace the final receipts.

This completion entry and the companion progress entry are written after the
six recorded runs. Their two Markdown files were part of the earlier 39-file
scope, so the reporting edits change that aggregate digest. The receipts are
not rewritten, and are not represented as having tested a future commit or
approved these new paragraphs. Application/test source bytes are unchanged by
this documentation-only completion pass. The final review package must bind
the resulting source and record its own checks.

Freeze source commit and diff digest after local checks. Ask Claude to review
requirements and diff first, then test evidence and the author's account, through
the existing controller and subscription CLI in read-only mode. Initial review
plus at most two revision reviews; no execution retries or inherited exceptions.
The user granted a task-specific `--skip-preflight` exception in this task on
2026-09-12 (confirmation: "네 허용합니다"). It covers the initial Claude review
and at most two revision reviews for this slice only. Read-only tools, passing
test gates and subscription CLI authentication remain required. It does not
authorize API billing, paid benchmarks, execution-failure retries or ignoring
findings. The read-only Claude invocation cannot perform the controller's write
probe; the override must be recorded in each applicable verdict.

Do not claim independent approval before an actual matching verdict. Preserve
all review failures and findings. No push/PR publication before independent
review completion; no automatic merge or deployment in this implementation.

## Cycle report

Update [Chat progress](tomverse-chat-progress.md) using its unchanged weighted
web scope, approximate percentage and uncertainty range. Separate implemented,
tested, reviewed, merged and deployed. This plan itself contributes no product
progress. At completion report evidence, residuals and the ordered next work:
integration regressions and gated staging verification, durable recovery only
after its contract is defined, then Planner and separately approved quality work.
