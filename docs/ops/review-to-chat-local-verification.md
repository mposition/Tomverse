# Review to Chat local implementation

Base: `80a95b53ea9fe99f3ef1466fd142cfb0679dddcf`, fetched `origin/main` on
2026-11-14. The fetched main matched the analysis base. Work was isolated from
the existing checkout, with a fresh lockfile-based `npm ci`.

## Implementation decisions

- `lib/reviewToChat.ts` projects typed AI Review and Quick Summary results.
  It captures one reviewer, preserves complete questions, positions and quotes,
  distinguishes quote matching from factual verification, and retains unknowns
  and limitations. It omits whole analysis items within 24,000 characters;
  an oversized question or selected item fails with guidance instead of slicing.
- Quick Summary's GET originally exposed only cache availability. That could
  not distinguish a regenerated result under the same upserted row id. Its
  existing owner/unlock-protected cache branch now returns a typed saved
  snapshot only for `handoff=1`. Existing POST results include their original
  input source, so handoff does not depend on AI Review model availability or
  add a preparation request. There is no new endpoint or permission grant.
- One tab-local packet expires after five minutes, binds the account and epoch,
  and is consumed once. A/B/A cannot revive a prior packet or authorise an old
  confirmation callback. No result is stored in URL or browser storage.
- `useConversationDrafts` exposes successful current-scope hydration. The
  receiver waits for that signal, blocks on existing sync/conflict state,
  suppresses last-Chat restoration and preserves existing text/attachments.
  Explicit append uses the ordinary writer and revision CAS. Send uses the
  existing Chat create/message/execution path and current Chat settings.

## Acceptance coverage

| Requirements | Executable coverage |
| --- | --- |
| R01–R03 | Studio without synthesis, Classic reviewer/finding, Quick adapter, cached reuse, one analysis execution |
| R04–R07 | Refuse partial/missing source, exact saved version/input, regeneration, Unicode and atomic omission, quote status and unknowns |
| R08–R12 | Opaque navigation, no handoff execution/create, recent Chat suppression, delayed/failed hydration, explicit append/cancel with attachment preservation, normal CAS conflict |
| R13–R15 | Account/epoch tests, real session refetch and late callback, double click, expiry, missing marker, cancellation while hydration is pending |
| R16–R18 | Mocked ordinary Chat Send, read-only owner/lock/delete recheck failures, unchanged source, unsupported entry notices |
| R19–R20 | Desktop/mobile browser actions, 320px/enlarged text/focus return, locale parity and translations; native explicitly excluded |

Unit tests: `tests/reviewToChat.test.mjs`, existing draft store/session/recovery,
Review evidence/cache and locale tests. Browser tests:
`tests/e2e/review-to-chat.spec.ts`; existing Studio, comparison and product
switcher regression suites. Loopback fixtures block external network and use
no production credentials or real model calls. A dedicated port is required
when another checkout owns the standard test server port.

### Executed results (2026-11-14)

- Fresh `npm ci`: passed; the implementation checkout's root `node_modules`
  is a real directory, not the audit checkout's dependency junction.
- Focused Node unit/regression tests: **92 passed**.
- New production-build E2E: **22 distinct scenarios passed** (12 desktop
  Chromium, 10 mobile Chromium), including Back/Forward and another-Chat
  selection while hydration is pending.
- Existing production-build E2E: **149 passed** across comparison review,
  Review Studio, product switcher, source grounding, item feedback, guest
  attachment/review and comparison action rail. Six mobile-only rail cases
  were skipped in the desktop project; two desktop-only new cases were skipped
  in the mobile project. These eight skips are outside their selected project.
- `npm run verify:studio-answer-analysis`, `npm run check:locale-translation`,
  `npm run typecheck`, changed-file ESLint and `npm run build`: **passed**.

The local production server used port **3187**, `reuseExistingServer: false`,
the standard fixture/network-blocking environment and the implementation
checkout's build. Initial runs found and resolved a preview stacking/focus
problem and stale test mocks for the newly mode-qualified GET. The affected
cases passed after correction; no product failure remains unresolved. Node
typecheck/build needed `NODE_OPTIONS=--max-old-space-size=12288` on this machine;
the default heap failed before the completed checks above.

## Scope boundaries

Guest, imported-continuation Reviews, public share pages, native analysis entry
wiring and Deep Research execution remain outside this implementation. The
packet does not survive a new tab or full reload; a missing/expired marker opens
a normal new draft with an explanation. Already applied drafts use existing
durable recovery. Source deletion/locking does not erase the user's independent
copied text. Merge, deployment and paid live evaluation are separate actions.
