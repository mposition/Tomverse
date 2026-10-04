# Independent review — task chat-owned-detail-handoff-disposition-followup-v1, round 0

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

PR #1673의 CI 후속 Cursor 읽기 전용 검토가 확인한 두 경계만 보완한다. post-boundary owned-detail surface handoff도 provider 전 departure barrier를 거쳐 pending durable-undispatched turn을 promote하고 committed selection ticket을 갱신한다. continuation routing contract는 outstanding URL handoff가 explicit selection을 중단하지 않으며 promotion이 lookup 및 lock acceptance 뒤 router push 전에 정확한 identity로 한 번 실행됨을 동작과 mutation으로 검증한다. 기존 passed chat-saved-undispatched-disposition-followup-v2 exchange는 변경하지 않는다. provider 호출, 배포, flag 변경, commit 및 push는 범위 밖이다.

## Completion criteria

- post-boundary owned-detail response가 current id의 다른 surface를 반환하면 captured navigation attempt가 여전히 최신인 경우에만 router.push 전에 동일한 forced departure barrier를 실행해 current pending durable-undispatched turn을 promote하고 committed selection ticket을 갱신한다. newer locked/refused selection 및 A-to-B-to-A 뒤의 stale response는 commit, promotion 및 push를 모두 수행하지 않는다.
- forced same-id surface departure도 exact current identity로 한 번 promote하며 missing, refused, stale, invalid 또는 locked target은 acceptance 전에 promote하지 않는다.
- routing contract가 outstanding initial URL handoff requested id와 explicit clicked id가 다른 시나리오를 실행하고 handoff settle 뒤 selection이 계속됨을 증명하며 inserted return mutation을 거부한다.
- routing contract가 promotion identity, count 및 order, post-boundary navigation freshness와 commit-before-push를 실행 검증하고 missing, early 및 late barrier와 freshness-guard 제거 mutation을 거부한다.
- external continuation contract, 관련 desktop/mobile Chromium E2E, identity/disposition unit, typecheck, scoped lint, production build 및 diff guard가 통과하고 기존 passed successor exchange는 바이트 불변으로 남는다.

## Change under review — digest sha256:79c2eeb2fb274d931cd45c8d32f185fa2a7b78ce6a463cc0aec607c4c4ec4d63

```diff
diff --git a/app/(site)/(application)/chat/ChatPageClient.tsx b/app/(site)/(application)/chat/ChatPageClient.tsx
index bb8820c62..a72f20c94 100644
--- a/app/(site)/(application)/chat/ChatPageClient.tsx
+++ b/app/(site)/(application)/chat/ChatPageClient.tsx
@@ -3907,7 +3907,7 @@ export function ChatPageClient({
               settleInitialConversationHandoff();
               return false;
             }
-            if (id !== currentChatIdRef.current) {
+            if (forceRouteTransition || id !== currentChatIdRef.current) {
               promoteCurrentUndispatchedTurns(selectionIdentityKey);
             }
             conversationSelectionTicketRef.current =
@@ -4103,9 +4103,15 @@ export function ChatPageClient({
 	  const res = await fetch(`/api/conversations/${accountId}`, { cache: "no-store" });
       if (res.ok) {
         const data = await res.json();
-        if (currentChatIdRef.current === id &&
+        if (navigationAttempt === conversationNavigationAttemptRef.current &&
+            currentChatIdRef.current === id &&
             ["chat", "workspace", "continuation"].includes(data.surface) &&
             data.surface !== mountedSurface) {
+          // The in-place selection above already made `id` current, but this
+          // late server-owned surface answer still leaves the mounted tree.
+          // Re-run the departure barrier so durable-but-undispatched turns are
+          // promoted and late receipts cannot disappear with the unmount.
+          commitConversationSelection(true);
           router.push(conversationHandoffHref(data.surface, id, LEGACY_REVIEW_PATH));
           return;
         }
diff --git a/docs/ops/cross-review/packages/chat-owned-detail-handoff-disposition-followup-v1/authorization.md b/docs/ops/cross-review/packages/chat-owned-detail-handoff-disposition-followup-v1/authorization.md
new file mode 100644
index 000000000..cf7b685be
--- /dev/null
+++ b/docs/ops/cross-review/packages/chat-owned-detail-handoff-disposition-followup-v1/authorization.md
@@ -0,0 +1,86 @@
+# Owned-detail handoff disposition 후속 독립 검토 승인 기록
+
+- approvedBy: `mposition` (현재 대화의 자동 개발 및 독립 검토 지시)
+- approvedAt: `2026-09-24` (Australia/Brisbane)
+- author: `codex`
+- independentReviewer: `cursor-cli`
+- maximumRevisionRounds: `2`
+- task: [task.json](./task.json)
+
+## 범위와 선행 기록
+
+비교 base는 PR #1673의 현재 head
+`5d2c109ab75784d73206c2f904088d84ff3aed13`이다. 이미 `passed`로 종결된
+`chat-saved-undispatched-disposition-followup-v2` exchange와 그 records는 이
+후속 작업에서 수정하거나 재개하지 않는다. 이 package는 그 승인 이후 별도 CI
+검토에서 발견된 owned-detail surface handoff와 routing contract 두 경계만 다룬다.
+
+허용된 제품·테스트 범위는 `ChatPageClient.tsx`,
+`externalContinuationContracts.test.mjs`, 그 contract가 사용하는 AST helper
+`tests/support/continuationRouting.mjs`와 이 package의 task/authorization/records다.
+실제 provider 호출, 유료 실행, staging/production 접근, flag 또는 traffic 변경,
+commit, push, merge 및 deploy는 승인 범위 밖이다. prompt, admission, context 또는
+provider 재실행 권한을 새로 보존하지 않는다.
+
+## Cursor 직접 검토 증거
+
+운영자가 제공한 Cursor CLI 직접 검토 outer JSON을
+`records/cursor-pr1673-ci-followup-review.captured.json`으로 그대로 보존한다.
+원본은 3,528 bytes이며 SHA-256은
+`06aaa16be89cd27769390d82c1985ff4ac340e697c45f68ec31ad31535dd5235`다.
+검토 session은 `ee925073-ae6d-4fb6-80d0-6c7e1c6d8501`, request는
+`bb7ca8f6-903f-483c-9cc4-07d7ab5c7140`, duration 및 API duration은 모두
+924,935ms다. usage는 input 296,827, output 49,566, cache read 4,195,456,
+cache write 0이다. supplied outer result에는 모델 필드가 없으므로 이 문서는 모델
+이름을 추정하지 않는다. narration 뒤 JSON verdict가 포함된 success envelope이며,
+이 자료는 새 exchange의 공식 verdict가 아니라 이 후속 task를 연 근거다.
+
+직접 검토는 다음 두 결함을 `request_changes`로 보고했다.
+
+1. post-boundary owned-detail lookup이 이미 같은 id를 current로 만든 뒤 다른
+   surface로 push할 때 `commitConversationSelection`을 다시 거치지 않아 selection
+   ticket 및 pending durable-undispatched promotion이 누락될 수 있었다.
+2. contract harness는 requested URL id와 클릭 id가 다른 outstanding handoff와
+   promotion identity/count/order를 실행하지 않아 inserted return, missing barrier,
+   refused/stale lookup 전 조기 promotion을 거부하지 못했다.
+
+## 구현과 검증
+
+`commitConversationSelection(true)`는 id가 같더라도 실제 surface departure라면
+pending durable-undispatched turn을 exact current identity로 promote하고 committed
+selection ticket을 갱신한다. post-boundary owned-detail handoff는 `router.push` 전에
+이 barrier를 실행한다. 또한 lookup을 시작할 때 캡처한 navigation attempt가 응답
+시점의 `conversationNavigationAttemptRef`와 정확히 일치할 때만 barrier와 push를
+허용한다. 더 새로운 locked/refused click은 committed conversation id를 바꾸지 않아도
+이전 응답의 authority를 폐기하며, A→B→A로 id가 다시 같아져도 이전 A 응답은
+commit, promotion 또는 push를 수행하지 않는다.
+
+contract harness는 outstanding URL handoff settle 뒤 explicit selection 계속,
+accepted lookup 뒤 promote-before-push, same-id cross-surface promotion, refused 및
+locked target의 zero-promotion을 실행한다. 여섯 mutation은 handoff branch의 inserted
+return, missing promotion, same-id force guard 회귀, lookup 전 조기 promotion,
+trailing barrier 누락 및 push 뒤 늦은 barrier를 각각 거부한다.
+후속 anti-review에서 post-boundary freshness 누락을 재현한 뒤, newer locked/refused
+attempt와 A→B→A ABA를 별도 navigation state로 실행해 commit/promotion/push가 모두
+0임을 고정했다. freshness guard 제거 mutation도 이 두 상태에서 실패한다.
+후속 anti-review에서 그 제거 mutation이 exact source string에 의존한다는 취약성을
+확인했다. AST helper는 strict equality의 두 operand를 의미로 식별해 괄호, operand
+순서 및 AND conjunct 위치와 무관한 `trailingNavigationFreshness` anchor를 제공한다.
+mutation은 이 AST conjunct를 제거하며, freshness가 first/middle/last에 있는 변형과
+reversed/parenthesized equality 모두에서 실제 mutant 생성과 거부를 확인한다.
+
+실행 결과는 다음과 같다.
+
+- 신규 mutation 회귀: 6/6 통과
+- `tests/externalContinuationContracts.test.mjs`: 106/106 통과
+- identity/disposition unit: 13/13 통과
+- 관련 desktop/mobile Chromium focused E2E: 22/22 통과
+- `npm run typecheck`: 통과
+- 변경 제품·계약·AST helper 세 파일 scoped ESLint: 통과
+- `npm run build`: exit 0 (기존 NO_SECRET fallback 로그 및 dynamic filesystem tracing
+  warning은 있었으나 compilation, TypeScript, static generation이 완료됨)
+- `git diff --check 5d2c109ab75784d73206c2f904088d84ff3aed13`: 통과
+
+새 package의 records만 exact `--out`과 `--diff-exclude`로 제외한다. author는
+Codex, 독립 reviewer는 Cursor CLI이며 수정 round 상한은 2다. package 생성 후
+reviewer는 새 digest에만 verdict를 결속해야 한다.
diff --git a/docs/ops/cross-review/packages/chat-owned-detail-handoff-disposition-followup-v1/task.json b/docs/ops/cross-review/packages/chat-owned-detail-handoff-disposition-followup-v1/task.json
new file mode 100644
index 000000000..31b8aa6e5
--- /dev/null
+++ b/docs/ops/cross-review/packages/chat-owned-detail-handoff-disposition-followup-v1/task.json
@@ -0,0 +1,19 @@
+{
+  "taskId": "chat-owned-detail-handoff-disposition-followup-v1",
+  "requirement": "PR #1673의 CI 후속 Cursor 읽기 전용 검토가 확인한 두 경계만 보완한다. post-boundary owned-detail surface handoff도 provider 전 departure barrier를 거쳐 pending durable-undispatched turn을 promote하고 committed selection ticket을 갱신한다. continuation routing contract는 outstanding URL handoff가 explicit selection을 중단하지 않으며 promotion이 lookup 및 lock acceptance 뒤 router push 전에 정확한 identity로 한 번 실행됨을 동작과 mutation으로 검증한다. 기존 passed chat-saved-undispatched-disposition-followup-v2 exchange는 변경하지 않는다. provider 호출, 배포, flag 변경, commit 및 push는 범위 밖이다.",
+  "completionCriteria": [
+    "post-boundary owned-detail response가 current id의 다른 surface를 반환하면 captured navigation attempt가 여전히 최신인 경우에만 router.push 전에 동일한 forced departure barrier를 실행해 current pending durable-undispatched turn을 promote하고 committed selection ticket을 갱신한다. newer locked/refused selection 및 A-to-B-to-A 뒤의 stale response는 commit, promotion 및 push를 모두 수행하지 않는다.",
+    "forced same-id surface departure도 exact current identity로 한 번 promote하며 missing, refused, stale, invalid 또는 locked target은 acceptance 전에 promote하지 않는다.",
+    "routing contract가 outstanding initial URL handoff requested id와 explicit clicked id가 다른 시나리오를 실행하고 handoff settle 뒤 selection이 계속됨을 증명하며 inserted return mutation을 거부한다.",
+    "routing contract가 promotion identity, count 및 order, post-boundary navigation freshness와 commit-before-push를 실행 검증하고 missing, early 및 late barrier와 freshness-guard 제거 mutation을 거부한다.",
+    "external continuation contract, 관련 desktop/mobile Chromium E2E, identity/disposition unit, typecheck, scoped lint, production build 및 diff guard가 통과하고 기존 passed successor exchange는 바이트 불변으로 남는다."
+  ],
+  "baseCommit": "5d2c109ab75784d73206c2f904088d84ff3aed13",
+  "writableScope": [
+    "app/(site)/(application)/chat/ChatPageClient.tsx",
+    "tests/externalContinuationContracts.test.mjs",
+    "tests/support/continuationRouting.mjs",
+    "docs/ops/cross-review/packages/chat-owned-detail-handoff-disposition-followup-v1"
+  ],
+  "generatedPaths": []
+}
diff --git a/tests/externalContinuationContracts.test.mjs b/tests/externalContinuationContracts.test.mjs
index bf0ef51d5..6280a1dfa 100644
--- a/tests/externalContinuationContracts.test.mjs
+++ b/tests/externalContinuationContracts.test.mjs
@@ -501,8 +501,10 @@ async function assertClientSurfaceRouting(client) {
         const encodedId = encodeURIComponent(id);
         const cases = [
             { name: "search hint wins over a conflicting list row", hint: "continuation", row: "workspace", path: `/continuations/${encodedId}` },
+            { name: "an outstanding URL handoff settles and continues the explicit selection", handoffRequestedId: "url-origin", row: "continuation", path: `/continuations/${encodedId}`, events: ["settle", "promote:account:test", "push"] },
             { name: "a search hit absent from the list carries its answer", hint: "continuation", path: `/continuations/${encodedId}` },
             { name: "the list row supplies the server answer", row: "continuation", path: `/continuations/${encodedId}` },
+            { name: "a same-id cross-surface departure promotes before routing", currentId: "clicked", row: "continuation", path: `/continuations/${encodedId}`, events: ["promote:account:test", "settle", "push"] },
             { name: "two continuations navigate to the clicked id", row: "continuation", mounted: "continuation", path: `/continuations/${encodedId}` },
             { name: "the current continuation does not push itself", row: "continuation", mounted: "continuation", pathname: `/continuations/${encodedId}`, workspace: true },
             { name: "leaving a continuation preserves the workspace id", row: "workspace", mounted: "continuation", path: `/chat?conversation=${encodedId}` },
@@ -511,11 +513,13 @@ async function assertClientSurfaceRouting(client) {
             { name: "the matching list row is selected after a decoy", rows: [{ id: "other", surface: "continuation" }, { surface: "workspace" }], workspace: true },
             { name: "the matching list row is selected before a decoy", rows: [{ surface: "workspace" }, { id: "other", surface: "continuation" }], workspace: true },
             { name: "the matching list row routes its own continuation", rows: [{ id: "other", surface: "workspace" }, { surface: "continuation" }], path: `/continuations/${encodedId}` },
+            { name: "a refused lookup never promotes before acceptance", mounted: "chat", status: 403, lookup: true, discarded: true },
             { name: "a Chat list miss ignores a decoy and reads the owned row", rows: [{ id: "other", surface: "continuation" }], mounted: "chat", detail: "workspace", lookup: true, path: `/chat?conversation=${encodedId}` },
             { name: "a workspace list miss ignores a decoy and resolves in place", rows: [{ id: "other", surface: "continuation" }], workspace: true },
             { name: "an unresolved workspace mount resolves in place without an early owned read", detail: "workspace", workspace: true },
             { name: "an unresolved continuation mount resolves in place without an early owned read", mounted: "continuation", detail: "continuation", pathname: `/continuations/${encodedId}`, workspace: true },
             { name: "a Chat list miss reads the owned continuation", mounted: "chat", detail: "continuation", lookup: true, path: `/continuations/${encodedId}` },
+            { name: "an owned lookup promotes only after its accepted answer", mounted: "chat", detail: "continuation", lookup: true, path: `/continuations/${encodedId}`, events: ["fetch", "promote:account:test", "settle", "push"] },
             { name: "a Chat list miss reads the owned workspace", mounted: "chat", detail: "workspace", lookup: true, path: `/chat?conversation=${encodedId}` },
             { name: "an owned Chat proceeds in place", mounted: "chat", detail: "chat", lookup: true, workspace: true },
             { name: "a non-account id cannot start an owned read", mounted: "chat", accountId: null },
@@ -535,18 +539,30 @@ async function assertClientSurfaceRouting(client) {
             { name: "identity namespace drift invalidates parsed owned detail", mounted: "chat", detail: "continuation", namespaceDrift: "json", lookup: true },
             { name: "origin conversation drift invalidates an owned response", mounted: "chat", detail: "continuation", originDrift: "response", lookup: true, discarded: true },
             { name: "origin conversation drift invalidates parsed owned detail", mounted: "chat", detail: "continuation", originDrift: "json", lookup: true },
+            { name: "a locked target does not promote before acceptance", rows: [{ surface: "continuation", isLocked: true }], locked: true },
             { name: "guest selection keeps the existing in-place path", guest: true, mounted: "chat", workspace: true },
         ];
         for (const scenario of cases) {
             const label = `${scenario.name} (${id})`;
             const paths = [];
             const reads = [];
+            const events = [];
+            const promotions = [];
+            let locked = 0;
             let discarded = 0;
             const ticket = { current: 0 };
+            const navigationAttempt = { current: 0 };
+            let nextNavigationAttempt = 0;
+            let nextSelectionTicket = 0;
+            const initialConversationHandoff = {
+                current: { requestedId: scenario.handoffRequestedId ?? id, settled: false },
+            };
             const identityNamespace = { current: scenario.namespace ?? "account:test" };
-            const currentConversation = { current: "previous" };
+            const currentConversation = {
+                current: scenario.currentId === "clicked" ? id : (scenario.currentId ?? "previous"),
+            };
             const invalidate = (phase) => {
-                if (scenario.stale === phase) ticket.current += 1;
+                if (scenario.stale === phase) navigationAttempt.current += 1;
                 if (scenario.namespaceDrift === phase) identityNamespace.current = "account:changed";
                 if (scenario.originDrift === phase) currentConversation.current = "other-conversation";
             };
@@ -557,16 +573,46 @@ async function assertClientSurfaceRouting(client) {
                 pathname: scenario.pathname ?? "/continuations/other",
                 isGuestMode: scenario.guest ?? false,
                 conversationSelectionTicketRef: ticket,
+                conversationNavigationAttemptRef: navigationAttempt,
+                allocateConversationNavigationAttempt: () => {
+                    nextNavigationAttempt += 1;
+                    return nextNavigationAttempt;
+                },
+                allocateConversationSelectionTicket: () => {
+                    nextSelectionTicket += 1;
+                    return nextSelectionTicket;
+                },
+                initialConversationHandoffRef: initialConversationHandoff,
+                settleInitialConversationHandoff: (requestedId) => {
+                    const handoff = initialConversationHandoff.current;
+                    if (handoff.settled ||
+                        (requestedId !== undefined && handoff.requestedId !== requestedId)) return false;
+                    handoff.settled = true;
+                    events.push("settle");
+                    return true;
+                },
                 currentChatIdRef: currentConversation,
                 identityKey: scenario.identity ?? "account:test", identityNamespaceRef: identityNamespace,
                 identityNamespaceKey: (namespace) => namespace,
                 accountConversationId: () => scenario.accountId === null ? null : "owned-id",
+                promoteCurrentUndispatchedTurns: (namespace) => {
+                    promotions.push(namespace);
+                    events.push(`promote:${namespace}`);
+                },
                 conversationSurfaceHref, conversationHandoffHref, LEGACY_REVIEW_PATH: "/chat",
                 PRODUCT_SURFACE_PATH: { ...PRODUCT_SURFACE_PATH, review: "/future-review" },
-                router: { push: (path) => paths.push(path) },
+                router: { push: (path) => {
+                    events.push("push");
+                    paths.push(path);
+                } },
+                setLockedSelectDialog: () => {
+                    locked += 1;
+                    events.push("lock");
+                },
                 discardResponseBody: async () => { discarded += 1; },
                 showToast: () => {}, t: (key) => key,
                 fetch: async (url, options) => {
+                    events.push("fetch");
                     reads.push([url, options.cache]);
                     if (scenario.fail) throw new Error("fixture read failure");
                     invalidate("response");
@@ -584,30 +630,65 @@ async function assertClientSurfaceRouting(client) {
             assert.equal(result, scenario.workspace ? "workspace" : undefined, label);
             assert.deepEqual(reads, scenario.lookup ? [["/api/conversations/owned-id", "no-store"]] : [], label);
             assert.equal(discarded, scenario.discarded ? 1 : 0, label);
+            assert.deepEqual(promotions, scenario.path ? [scenario.namespace ?? "account:test"] : [],
+                `${label}: an accepted departure promotes exactly once and no refused/stale/locked lookup promotes`);
+            assert.equal(locked, scenario.locked ? 1 : 0, label);
+            if (scenario.events) assert.deepEqual(events, scenario.events, `${label}: routing barrier order`);
         }
     }
 
     // Execute the actual trailing if/body against valid and invalid server
-    // surfaces, current/stale origins and the same finite id set: 108 cases.
+    // surfaces, current/stale origins, current/stale navigation attempts and
+    // the same finite id set. A locked/refused selection still allocates a
+    // newer navigation attempt even though it does not change the committed
+    // conversation; A -> B -> A likewise restores the id without restoring
+    // authority to A's older owned-detail response.
     // Merely mentioning a guard cannot satisfy these assertions. This does not
     // prove independence from every possible id derivation or run restoration.
     for (const id of routingIds) {
         for (const mountedSurface of ["workspace", "chat", "continuation"]) {
             for (const surface of ["workspace", "chat", "continuation", "invented", null, undefined]) {
-                for (const currentId of [id, "other"]) {
+                for (const navigationState of [
+                    { name: "current", captured: 7, current: 7, currentId: id },
+                    { name: "newer locked or refused selection", captured: 7, current: 8, currentId: id },
+                    { name: "A-to-B-to-A", captured: 7, current: 9, currentId: id },
+                    { name: "different current origin", captured: 7, current: 7, currentId: "other" },
+                ]) {
+                    const { captured: navigationAttempt, current: currentAttempt, currentId } = navigationState;
                     const valid = ["workspace", "chat", "continuation"].includes(surface);
                     const paths = [];
+                    const committed = [];
+                    const promotions = [];
+                    const departureEvents = [];
                     trailing({ data: { surface }, id, currentChatIdRef: { current: currentId },
-                        mountedSurface, router: { push: (path) => paths.push(path) },
+                        navigationAttempt,
+                        conversationNavigationAttemptRef: { current: currentAttempt },
+                        mountedSurface, router: { push: (path) => {
+                            departureEvents.push("push");
+                            paths.push(path);
+                        } },
+                        commitConversationSelection: (forceRouteTransition) => {
+                            departureEvents.push("commit");
+                            committed.push(forceRouteTransition);
+                            promotions.push("account:test");
+                        },
                         conversationHandoffHref, LEGACY_REVIEW_PATH: "/chat",
                         PRODUCT_SURFACE_PATH: { ...PRODUCT_SURFACE_PATH, review: "/future-review" },
                     })();
-                    const expected = valid && currentId === id && surface !== mountedSurface
+                    const fresh = navigationAttempt === currentAttempt;
+                    const expected = fresh && valid && currentId === id && surface !== mountedSurface
                         ? [conversationHandoffHref(surface, id, "/chat")] : [];
                     const message = !valid ? "trailing handoff rejects an invalid server surface"
                         : currentId !== id ? "trailing handoff rejects a stale origin"
+                        : !fresh ? `trailing handoff rejects ${navigationState.name}`
                         : "trailing handoff follows the current owned server surface";
                     assert.deepEqual(paths, expected, `${message} (${id}, ${mountedSurface}, ${surface}, ${currentId})`);
+                    assert.deepEqual(committed, expected.length > 0 ? [true] : [],
+                        `trailing handoff commits the selection before route (${id}, ${mountedSurface}, ${surface}, ${currentId})`);
+                    assert.deepEqual(promotions, expected.length > 0 ? ["account:test"] : [],
+                        `trailing handoff cannot promote a stale navigation (${id}, ${mountedSurface}, ${surface}, ${navigationState.name})`);
+                    assert.deepEqual(departureEvents, expected.length > 0 ? ["commit", "push"] : [],
+                        `trailing handoff barrier order (${id}, ${mountedSurface}, ${surface}, ${currentId})`);
                 }
             }
         }
@@ -645,6 +726,7 @@ function routingFixture(source) {
     };
     return {
         source, bounds, replaceRange, replaceAnchor, anchorText,
+        replaceHandler: (before, after) => replaceWithin(bounds.handlerStart, bounds.handlerEnd, before, after),
         replaceRouting: (before, after) => replaceWithin(bounds.start, bounds.end, before, after),
         replaceTrailingRouting: (before, after) => replaceWithin(bounds.end, bounds.handlerEnd, before, after),
         removeConjunct: (name) => {
@@ -714,11 +796,22 @@ const routingMutations = [
         'const ownPath = "conversationSurfaceHref(targetSurface, id)";'), /search hint wins/],
     ["handoff drops the clicked id", (f) => f.replaceAnchor("prefixHandoff", "LEGACY_REVIEW_PATH"), /preserves the workspace id/],
     ["owned answer is ignored", (f) => f.replaceAnchor("targetAssignment", "/* targetSurface = detail.surface */"), /a Chat list miss ignores a decoy and reads the owned row/],
-    ["owned refusal falls through", (f) => f.replaceRouting("if (!response.ok) {", "if (false) {"), /refused owned read/],
+    ["owned refusal falls through", (f) => f.replaceRouting("if (!response.ok) {", "if (false) {"), /refused owned read|refused lookup never promotes/],
     ["refused response return is removed", (f) => f.replaceRouting(/return;(?=\s*\}\s*const detail = await response\.json\(\);)/, ""), /refused owned read/],
     ["owned read escapes the Chat mount", (f) => f.replaceRouting('mountedSurface === "chat" && !targetSurface', "!targetSurface"), /resolves in place/],
     ["invalid owned answer is accepted", (f) => f.replaceAnchor("detailGuard", ""), /invalid owned surface/],
-    ["stale selection check is bypassed", (f) => f.replaceRouting("selectionTicket === conversationSelectionTicketRef.current", "true"), /newer selection invalidates/],
+    ["stale navigation check is bypassed", (f) => f.replaceRouting("navigationAttempt === conversationNavigationAttemptRef.current", "true"), /newer selection invalidates/],
+    ["an outstanding handoff stops the replacement selection", (f) => f.replaceHandler(
+        "settleInitialConversationHandoff();\n        }\n        const navigationAttempt",
+        "settleInitialConversationHandoff();\n            return;\n        }\n        const navigationAttempt"), /outstanding URL handoff settles and continues/],
+    ["the departure barrier drops promotion", (f) => f.replaceRouting(
+        "promoteCurrentUndispatchedTurns(selectionIdentityKey);", ""), /promotes exactly once/],
+    ["a forced same-id departure skips promotion", (f) => f.replaceRouting(
+        "if (forceRouteTransition || id !== currentChatIdRef.current) {",
+        "if (id !== currentChatIdRef.current) {"), /same-id cross-surface departure promotes/],
+    ["promotion runs before an owned lookup is accepted", (f) => f.replaceRouting(
+        "const accountId = accountConversationId(id);",
+        "promoteCurrentUndispatchedTurns(selectionIdentityKey);\n            const accountId = accountConversationId(id);"), /refused lookup never promotes/],
     ["missing identity guard is bypassed", (f) => f.replaceRouting("Boolean(identityKey)", "true"), /missing identity/],
     ["identity namespace guard is bypassed", (f) => f.replaceRouting("identityKey === identityNamespaceKey(identityNamespaceRef.current)", "true"), /identity namespace/],
     ["origin conversation guard is bypassed", (f) => f.replaceRouting("originConversationId === currentChatIdRef.current", "true"), /origin conversation/],
@@ -728,6 +821,11 @@ const routingMutations = [
     ["trailing detail derives from id prefix", (f) => f.replaceTrailingRouting("data.surface !== mountedSurface", 'id.startsWith("continuation_")'), /derived from startsWith/],
     ["trailing handoff argument derives from kind", (f) => f.replaceAnchor("trailingHandoff",
         "router.push(conversationHandoffHref(data.kind, id, LEGACY_REVIEW_PATH));"), /derived from kind/],
+    ["trailing handoff drops the departure barrier", (f) => f.replaceTrailingRouting(
+        "commitConversationSelection(true);", ""), /trailing handoff commits the selection/],
+    ["trailing handoff runs the departure barrier after push", (f) => f.replaceTrailingRouting(
+        "commitConversationSelection(true);\n          router.push(conversationHandoffHref(data.surface, id, LEGACY_REVIEW_PATH));",
+        "router.push(conversationHandoffHref(data.surface, id, LEGACY_REVIEW_PATH));\n          commitConversationSelection(true);"), /trailing handoff barrier order/],
     ["missing trailing handoff", (f) => f.replaceAnchor("trailingHandoff", ""), /exactly one trailing owned handoff/],
     ["duplicate trailing handoff", (f) => f.replaceAnchor("trailingHandoff", `${f.trailingHandoffText}\n${f.trailingHandoffText}`), /exactly one trailing owned handoff/],
     ["comment trailing handoff decoy", (f) => f.replaceAnchor("trailingHandoff", `/* ${f.trailingHandoffText} */`), /exactly one trailing owned handoff/],
@@ -737,13 +835,15 @@ const routingMutations = [
     ["an arbitrary first row supplies the surface", (f) => f.replaceAnchor("listSurface", "conversations[0]?.surface"), /matching list row|list miss/],
     ["trailing allowlist is removed", (f) => f.removeConjunct("trailingAllowlist"), /trailing handoff rejects an invalid/],
     ["trailing origin check is removed", (f) => f.removeConjunct("trailingOrigin"), /trailing handoff rejects a stale/],
-    ["id substring infers the surface", (f) => f.replaceRouting(f.initializerText, `${f.initializerText} ?? (id.includes("continuation_") ? "continuation" : undefined)`), /list miss|resolves in place/],
-    ["id regex infers the surface", (f) => f.replaceRouting(f.initializerText, `${f.initializerText} ?? (/^continuation_/.test(id) ? "continuation" : undefined)`), /list miss|resolves in place/],
+    ["trailing navigation freshness check is removed", (f) => f.removeConjunct(
+        "trailingNavigationFreshness"), /newer locked or refused selection|A-to-B-to-A/],
+    ["id substring infers the surface", (f) => f.replaceRouting(f.initializerText, `${f.initializerText} ?? (id.includes("continuation_") ? "continuation" : undefined)`), /list miss|resolves in place|refused lookup never promotes/],
+    ["id regex infers the surface", (f) => f.replaceRouting(f.initializerText, `${f.initializerText} ?? (/^continuation_/.test(id) ? "continuation" : undefined)`), /list miss|resolves in place|refused lookup never promotes/],
     ["an arbitrary last row supplies the surface", (f) => f.replaceAnchor("listSurface", "conversations.at(-1)?.surface"), /matching list row|list miss/],
     ["trailing allowlist is bypassed", (f) => f.replaceAnchor("trailingAllowlist", "true"), /trailing handoff rejects an invalid/],
     ["trailing origin check is bypassed", (f) => f.replaceAnchor("trailingOrigin", "true"), /trailing handoff rejects a stale/],
     ["trailing guard is changed from AND to OR", (f) => f.replaceAnchor("trailingCondition",
-        '(currentChatIdRef.current === id || ["chat", "workspace", "continuation"].includes(data.surface)) && data.surface !== mountedSurface'), /trailing handoff rejects an invalid|trailing handoff rejects a stale/],
+        '(currentChatIdRef.current === id || ["chat", "workspace", "continuation"].includes(data.surface)) && data.surface !== mountedSurface'), /trailing handoff rejects an invalid|trailing handoff rejects a stale|newer locked or refused selection|A-to-B-to-A/],
     ["trailing id substring infers a handoff", (f) => f.replaceTrailingRouting("data.surface !== mountedSurface",
         '(id.includes("continuation_") || data.surface !== mountedSurface)'), /trailing handoff follows the current owned server surface/],
     ["trailing id regex infers a handoff", (f) => f.replaceTrailingRouting("data.surface !== mountedSurface",
@@ -767,13 +867,16 @@ for (const mutation of routingMutations) {
 
 test("equivalent trailing guard grouping and order preserve routing behavior", async () => {
     // First/middle/last guard positions, both association directions, and a
-    // reversed/parenthesized origin comparison must preserve mutation setup.
+    // reversed/parenthesized origin or freshness comparison must preserve
+    // behavior and the AST-backed guard-removal mutation.
     for (const condition of [
-        "(data.surface !== mountedSurface) && (['chat', 'workspace', 'continuation'].includes(data.surface)) && (currentChatIdRef.current === id)",
-        "(['chat', 'workspace', 'continuation'].includes(data.surface) && (((id) === (currentChatIdRef.current)) && (data.surface !== mountedSurface)))",
-        "(((currentChatIdRef.current) === (id)) && ((data.surface !== mountedSurface) && (['chat', 'workspace', 'continuation'].includes(data.surface))))",
+        "navigationAttempt === conversationNavigationAttemptRef.current && (data.surface !== mountedSurface) && (['chat', 'workspace', 'continuation'].includes(data.surface)) && (currentChatIdRef.current === id)",
+        "(['chat', 'workspace', 'continuation'].includes(data.surface) && (((conversationNavigationAttemptRef.current) === (navigationAttempt)) && (((id) === (currentChatIdRef.current)) && (data.surface !== mountedSurface))))",
+        "(((currentChatIdRef.current) === (id)) && ((data.surface !== mountedSurface) && (['chat', 'workspace', 'continuation'].includes(data.surface)))) && ((navigationAttempt) === (conversationNavigationAttemptRef.current))",
     ]) {
         const regrouped = routingFixture(routingClient).replaceAnchor("trailingCondition", condition);
+        assert.ok(routingFixture(regrouped).anchorText("trailingNavigationFreshness").length > 0,
+            "the AST freshness anchor survives operand order, parentheses and conjunct position");
         await assertClientSurfaceRouting(regrouped);
         for (const mutation of routingMutations) await assertRoutingMutation(mutation, regrouped);
     }
diff --git a/tests/support/continuationRouting.mjs b/tests/support/continuationRouting.mjs
index ad10b73ff..38d09e3a8 100644
--- a/tests/support/continuationRouting.mjs
+++ b/tests/support/continuationRouting.mjs
@@ -58,6 +58,15 @@ const isSurfaceAllowlist = (node) => {
     return values !== null && new Set(values).size === 3 &&
         values.every((value) => ["chat", "workspace", "continuation"].includes(value));
 };
+const isNavigationFreshness = (node) => {
+    node = unparenthesized(node);
+    if (!ts.isBinaryExpression(node) ||
+        node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
+    const sides = [node.left, node.right].map((side) =>
+        accessPath(unparenthesized(side)));
+    return sides.includes("navigationAttempt") &&
+        sides.includes("conversationNavigationAttemptRef.current");
+};
 
 export function extractContinuationRouting(text) {
     const source = ts.createSourceFile("ChatPageClient.tsx", text,
@@ -145,6 +154,8 @@ export function extractContinuationRouting(text) {
             const sides = [node.left, node.right].map((side) => accessPath(unparenthesized(side)));
             return sides.includes("currentChatIdRef.current") && sides.includes("id");
         }).map(conjunctSpan),
+        trailingNavigationFreshness: conjuncts(trailingDecision.expression)
+            .filter(isNavigationFreshness).map(conjunctSpan),
     };
     return {
         anchors,

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test tests/externalContinuationContracts.test.mjs` (44627ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 44523.9309

## Guard results (run by the control program)

- PASS `git diff --check 5d2c109ab75784d73206c2f904088d84ff3aed13` (74ms)
- PASS `npm run typecheck` (63823ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npm exec eslint -- 'app/(site)/(application)/chat/ChatPageClient.tsx' tests/externalContinuationContracts.test.mjs tests/support/continuationRouting.mjs` (45711ms)

## Author's account (read last; a claim, not a finding)

Summary: Fence post-boundary owned-detail handoffs with an AST-verified fresh navigation-attempt check and durable-undispatched departure barrier.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "chat-owned-detail-handoff-disposition-followup-v1",
  "round": 0,
  "reviewedDigest": "sha256:79c2eeb2fb274d931cd45c8d32f185fa2a7b78ce6a463cc0aec607c4c4ec4d63",
  "conclusion": "approve | request_changes | blocked",
  "findings": [
    {
      "location": "path:line or symbol",
      "severity": "error | warning | nit",
      "basis": "evidence | preference | judgement",
      "claim": "what is wrong, in one sentence",
      "reproduction": "how to see it: a command, or an input and its expected output (required for the finding to be acted on)"
    }
  ],
  "nextAction": "one sentence"
}
```

`reviewedDigest` must be the digest above, verbatim. A finding with basis `preference` is settled by the project's rules; any other finding is acted on only with a reproduction, and without one it is recorded and the current version stands.
