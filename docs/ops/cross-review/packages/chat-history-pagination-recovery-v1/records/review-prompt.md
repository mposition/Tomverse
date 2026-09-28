# Independent review — task chat-history-pagination-recovery-v1, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Tomverse Chat의 기존 대화 기록을 페이지별로 복원할 때 첫 페이지와 모든 후속 페이지가 완전하고 유효할 때만 해당 runtime transcript를 loaded로 인정한다. 후속 페이지 503, malformed 첫 200 응답, 누락·반복 cursor, 캐시된 대화 재방문 및 진행 중 조회를 상속한 panel remount에서 부분 기록을 성공처럼 표시하거나 전송하지 않는다. 실패 상태와 수동 retry는 동일 identity·conversation runtime key에 결속하고 작성 중인 draft를 보존하며, 조회 재시도가 provider POST를 만들지 않는다. Review의 다중 모델 model-only 경로도 재조회 중 숨겨진 전송을 만들지 않고 기존 정상 동작을 유지한다. E2E conversation detail GET fixture는 실제 API와 같은 필수 messagePage를 반환해야 하며 chat-send-history-race의 독립 fixture도 이 계약을 따른다. 저장된 Message에 대한 답변 dispatch가 시작되지 않은 경우에는 중복 Message를 만들 수 있는 재전송 대신 reload로 사실을 확인하도록 7개 locale의 정확한 안내를 제공한다. 변경은 지정된 열여섯 제품·테스트 파일과 이 검토 패키지에 한정한다. 실제 provider 호출, 유료 실행, Railway staging/production, flag 변경, 병합·배포는 범위 밖이다. author는 Codex, 독립 reviewer는 Claude Code Max 구독 CLI다.

## Completion criteria

- 첫 페이지와 후속 페이지의 messages 및 messagePage 형식을 검사하고, 후속 페이지 503·malformed JSON·누락 또는 반복 cursor를 complete history로 오인하지 않는다. 실패한 페이지까지의 임시 messages는 화면이나 전송 context에 적용하지 않는다.
- 이전에 loaded였던 대화를 재방문해 후속 페이지 갱신에 실패해도 cached loaded=true가 남지 않는다. 같은 runtime key의 in-flight load를 새 panel이 상속한 뒤 이전 panel의 요청이 실패하면 공유 실패 상태를 관측하고 수동 retry에 도달한다. 낡은 ticket의 release/settle은 최신 ticket을 바꾸지 않는다.
- local send 또는 stream이 조회 중 동일 key의 transcript revision을 진전시킨 경우 늦은 조회 응답은 그 transcript를 덮지 않는다. identity·conversation 전환 뒤 이전 응답과 실패는 현재 화면, 다른 key의 draft·toast 또는 전송 권한으로 이전되지 않는다. 특히 다른 계정으로 전환한 뒤 이전 계정의 보류 중 Message save가 끝나도 saved-but-unanswered 안내를 새 계정 화면에 표시하지 않는다.
- 기록 로드 전·실패 중에는 Chat 전역 composer와 Review 다중 모델 model-only form의 모든 전송 진입점이 Message 저장과 provider POST 전에 멈춘다. 비활성 버튼 외에 Enter/form submit 및 settings-preparation 대기 뒤의 재검사도 포함한다. 다만 Message POST가 이미 in flight인 동안 viewport remount가 기록 GET claim을 시작하고 그 Message save가 성공한 경우, 이미 커밋된 Message를 답변 없이 버리지 않고 완전한 cached transcript를 보존하며 한 번만 이어서 전송해야 한다. Message 저장 이후 onBeforeSend 대기 중 발생하는 remount·기록 claim도 같은 계약으로 검증한다. Review 다중 모델 model-only Message POST 진행 중 viewport remount와 page2 GET hold/503이 겹친 뒤 POST가 commit되면 provider stream이 spinner 뒤에 숨지 않거나 완전 로드까지 보류되며, 실패한 GET을 성공으로 위장하지 않는지 검증한다. 정상 로드 뒤에는 해당 경로가 한 번만 전송된다.
- 오류 UI는 현재 runtime key의 실제 실패에만 나타나고 pending load와 failed load를 서로 다른 메시지·상태로 정직하게 표시한다. 재시도는 기록 GET만 다시 수행하고 중복 provider 실행·무한 자동 재시도·숨겨진 답변을 만들지 않으며, 사용자가 입력한 draft는 실패·재시도·대화 전환 중 보존된다. durable Message 저장은 성공했으나 동시 최신 run이 이겨 답변 dispatch가 시작되지 않은 경우, 완료나 미저장으로 위장하지 않고 중복 Message 위험이 있는 '다시 보내라' 대신 reload로 확인하라는 정확한 복구 disposition을 7개 locale에 제공하고 검증한다.
- 집중 runtime unit과 desktop/mobile 브라우저 회귀는 후속 페이지 503, malformed 첫 200, cached revisit, in-flight remount 실패, Review model-only 경합, draft/retry, 완전한 message 순서 및 Chat POST 0건의 실패 경계를 검증한다. 정상 복구 뒤 전송은 완전한 기록을 사용한다. 공용 및 세 독립 E2E fixture는 실제 conversation detail GET의 필수 messagePage 형식을 유지해야 하며 chat-markdown-theme, conversation-draft-isolation, chat-send-history-race, model-change-send-barrier 회귀를 실행한다. cached revisit와 model-change를 desktop/mobile에서 재실행하고 Loading-state golden은 Windows에서 파일 부재로 난 실패를 픽셀 통과로 오인하지 않고 정본 Linux runner에서 snapshot 갱신 없이 실제 비교한다. 관련 regression, typecheck, lint 및 diff guard의 실제 결과를 기록하며 실패·skip을 통과로 표현하지 않는다.
- 검토 package는 base ad2b51622992c29056706c443d80bdba928336e1 이후 지정된 열여섯 변경 파일과 이 task/authorization을 모두 포함한다. 생성된 records/만 동일한 exact --out 및 --diff-exclude 경로로 제외하고 source/test나 다른 파일을 제외하지 않는다. generatedPaths는 빈 배열이다.
- Claude는 요구사항과 전체 diff를 먼저 읽고 작성자 테스트 기록을 그 뒤에 검토한다. verdict는 package digest를 명시하고 finding마다 위치·심각도·근거·재현을 제공한다. 사용자 승인 --skip-preflight 예외와 저장된 Claude Code Max 구독 CLI의 읽기 전용 도구만 사용한다. Anthropic API·API key fallback, --review-despite-check-failures, 실제 provider/staging 호출, 과금, flag 변경, push·merge·deploy는 이 task가 승인하지 않는다.

## Change under review — digest sha256:63f99fbb5f577bb684e79b719a635b09f2594ce5d6f70bbef51efaf0874c2018

```diff
diff --git a/app/(site)/(application)/chat/ChatPageClient.tsx b/app/(site)/(application)/chat/ChatPageClient.tsx
index 27c7785ff..0fbe1e2a1 100644
--- a/app/(site)/(application)/chat/ChatPageClient.tsx
+++ b/app/(site)/(application)/chat/ChatPageClient.tsx
@@ -107,7 +107,7 @@ import {
 } from "@/lib/continuationFocusHandoff";
 import { continuationTimelineMessages } from "@/lib/continuationTimelineMessages";
 import { CHAT_WORKSPACE_PATH, LEGACY_REVIEW_PATH } from "@/lib/productSurfaceRoutes";
-import { chatRuntimeKey, isChatRuntimeStreaming } from "@/lib/chatStreamRuntime";
+import { chatRuntimeKey, getChatRuntimeSnapshot, isChatRuntimeStreaming } from "@/lib/chatStreamRuntime";
 import { chatDraftMatchesSubmission, chatPreparedSendIsCurrent, newWorkspaceDraftModels } from "@/lib/chatWorkspaceEntry";
 import { ImageGenerationWorkspace } from "@/components/images/ImageGenerationWorkspace";
 import { IMAGE_GROUP_MAX_MODELS_BOUNDS } from "@/lib/imageGroupLimits";
@@ -4365,12 +4365,20 @@ export function ChatPageClient({
     const submitFence = submitIdentityFenceRef.current;
     const ownerKey = identityKey ?? "unresolved";
     if (pendingSubmissionOwnersRef.current.has(ownerKey)) return;
-    if (mountedSurface === "chat" && currentChatIdRef.current && isChatRuntimeStreaming(chatRuntimeKey({
+    const existingChatRuntimeKey = mountedSurface === "chat" && currentChatIdRef.current
+      ? chatRuntimeKey({
       identityKey: identityKey ?? "account",
       conversationId: currentChatIdRef.current,
       modelId: latestModelSettingsRef.current.models[0] ?? "",
       transcriptScope: "conversation",
-    }))) return;
+    }) : null;
+    if (existingChatRuntimeKey && !getChatRuntimeSnapshot(existingChatRuntimeKey).isLoaded) {
+      if (getChatRuntimeSnapshot(existingChatRuntimeKey).loadFailed) {
+        showToast(t("chat.workspaceError.body"), "error");
+      }
+      return;
+    }
+    if (existingChatRuntimeKey && isChatRuntimeStreaming(existingChatRuntimeKey)) return;
     const owner: PendingSubmissionOwner = {
       token: crypto.randomUUID(),
       identityKey,
@@ -4728,7 +4736,7 @@ export function ChatPageClient({
       // all: the preflight would price an empty set and the turn would sit
       // unanswered. Abandon instead, leaving the answers already on screen.
       if (!activeModelIds.length) return;
-      const chatSendIsCurrent = () => {
+      const chatSendIsCurrent = (requireLoaded = true) => {
         if (!submitOwnerIsCurrent()) return false;
         if (mountedSurface !== "chat") return true;
         const currentIdentityKey = identityNamespaceKey(identityNamespaceRef.current);
@@ -4744,7 +4752,24 @@ export function ChatPageClient({
         if (!current && identityKey === currentIdentityKey) {
           showToast(t("chat.sendPreparationChanged"), "info");
         }
-        return current;
+        if (!current) return false;
+        // A viewport remount can begin a fresh history load without changing
+        // the conversation or selection ticket. The initial submit check is
+        // no longer evidence after an awaited preflight/context/draft step.
+        // Fresh Chat has no origin transcript to reload and keeps its first
+        // send path unchanged.
+        const currentRuntime = requireLoaded && submitOwner.originConversationId
+          ? getChatRuntimeSnapshot(chatRuntimeKey({
+          identityKey: identityKey ?? "account",
+          conversationId: submitOwner.originConversationId,
+          modelId: activeModelIds[0] ?? "",
+          transcriptScope: "conversation",
+        })) : null;
+        if (currentRuntime && !currentRuntime.isLoaded) {
+          if (currentRuntime.loadFailed) showToast(t("chat.workspaceError.body"), "error");
+          return false;
+        }
+        return true;
       };
       if (!chatSendIsCurrent()) return;
       const preflight = await runComparisonPreflight({
@@ -4820,6 +4845,7 @@ export function ChatPageClient({
       }
       let savedAttachments: ChatAttachment[] = promptAttachments;
       let sendCurrentAfterMessageSave = true;
+      let messageWasSaved = false;
       if (!isGuestMode) {
         const messageToSave: {
           clientRequestId: string;
@@ -4853,6 +4879,10 @@ export function ChatPageClient({
           | "transport"
           | null = null;
         let indeterminateFailureCode: string | undefined;
+        if (!chatSendIsCurrent()) {
+          if (preparedDraft) abortDraftSend(preparedDraft);
+          return;
+        }
         try {
           const { response: saveResponse, body: saveBody, bodyValid } =
             await fetchJsonWithTimeout(
@@ -5004,6 +5034,7 @@ export function ChatPageClient({
         }
 
         if (saved) {
+          messageWasSaved = true;
           /*
             Swap the composer's upload ids for the durable attachment ids the
             save just wrote, in place, so the cards already on screen are the
@@ -5042,7 +5073,10 @@ export function ChatPageClient({
             // exact revision. Only now may the local snapshot disappear; any
             // text typed while the request was frozen is retained as a fresh
             // revision-0 draft by the hook.
-            sendCurrentAfterMessageSave = chatSendIsCurrent();
+            // The Message is durable. A viewport remount may now refresh its
+            // history, but must not erase the accepted turn merely because
+            // that GET is pending. The panel will wait for a complete view.
+            sendCurrentAfterMessageSave = chatSendIsCurrent(false);
             const submittedDraftStillCurrent = commitDraftSend(
               preparedDraft,
               originScopeId,
@@ -5080,7 +5114,7 @@ export function ChatPageClient({
 
       // Last await boundary: an intervening model/account/conversation change
       // must not publish a payload to another panel or discard the draft.
-      if (!sendCurrentAfterMessageSave || !chatSendIsCurrent()) return;
+      if (!sendCurrentAfterMessageSave || !chatSendIsCurrent(!messageWasSaved)) return;
       const conversation = conversations.find((item) => item.id === activeChatId);
       const previousCount = promptCountsRef.current.get(activeChatId) ??
         (conversation?.messageCount ? 1 : 0);
diff --git a/components/chat/ChatApp.tsx b/components/chat/ChatApp.tsx
index ea76d4b1f..3ae119357 100644
--- a/components/chat/ChatApp.tsx
+++ b/components/chat/ChatApp.tsx
@@ -69,6 +69,7 @@ import {
   beginChatRuntimeRun,
   chatRuntimeIdentityKey,
   chatRuntimeKey,
+  captureChatRuntimeCompleteView,
   claimChatRuntimeLoad,
   endChatRuntimeRun,
   getChatRuntimeLastPrompt,
@@ -83,6 +84,8 @@ import {
   markChatRuntimeJobResumed,
   ownsChatRuntimeTranscript,
   releaseChatRuntimeLoad,
+  restoreChatRuntimeCompleteViewForSend,
+  isChatRuntimeCompleteViewRecordCurrent,
   setChatRuntimeLastPrompt,
   settleChatRuntimeLoad,
   subscribeChatRuntime,
@@ -431,6 +434,7 @@ function ChatAppComponent({
    * first will settle the record either way.
    */
   const settledViewKeyRef = useRef<string | null>(null);
+  const [historyLoadRetry, setHistoryLoadRetry] = useState(0);
   /**
    * The send barrier and this panel's current model, read through refs by the
    * auto-send effect below.
@@ -816,8 +820,17 @@ function ChatAppComponent({
           });
           if (response.ok) {
             const data = await response.json();
+            if (!Array.isArray(data.messages) || !data.messagePage ||
+                typeof data.messagePage.hasMore !== "boolean") {
+              throw new Error("Conversation history first page is incomplete.");
+            }
             let nextCursor = data.messagePage?.nextCursor;
-            while (data.messagePage?.hasMore && nextCursor && isCurrentLoad()) {
+            const visitedCursors = new Set<string>();
+            while (data.messagePage?.hasMore && isCurrentLoad()) {
+              if (typeof nextCursor !== "string" || !nextCursor || visitedCursors.has(nextCursor)) {
+                throw new Error("Conversation history cursor is missing or repeated.");
+              }
+              visitedCursors.add(nextCursor);
               const pageResponse = await fetch(
                 `/api/conversations/${initialConversationId}?${modelQuery}&cursor=${encodeURIComponent(nextCursor)}`,
                 {
@@ -827,12 +840,14 @@ function ChatAppComponent({
               );
               if (!pageResponse.ok) {
                 await discardResponseBody(pageResponse);
-                break;
+                throw new Error(`Conversation history page failed: ${pageResponse.status}`);
               }
               const pageData = await pageResponse.json();
-              if (Array.isArray(pageData.messages)) {
-                data.messages.push(...pageData.messages);
+              if (!Array.isArray(pageData.messages) || !pageData.messagePage ||
+                  typeof pageData.messagePage.hasMore !== "boolean") {
+                throw new Error("Conversation history page is incomplete.");
               }
+              data.messages.push(...pageData.messages);
               data.messagePage = pageData.messagePage;
               nextCursor = pageData.messagePage?.nextCursor;
             }
@@ -915,7 +930,9 @@ function ChatAppComponent({
         // because a send advanced this key while the request was in flight:
         // the transcript on screen is then the send's, and it is loaded.
         if (isCurrentLoad()) {
-          if (loadFailed) {
+          if (getChatRuntimeRevision(loadKey) !== revisionAtStart || isChatRuntimeStreaming(loadKey)) {
+            settleChatRuntimeLoad(loadKey, requestId, { loaded: true });
+          } else if (loadFailed) {
             // Let a later re-run retry instead of pinning the view to a failed
             // load, which would leave the loading placeholder up for good.
             settledViewKeyRef.current = null;
@@ -954,6 +971,7 @@ function ChatAppComponent({
     t,
     runtimeKey,
     transcriptScope,
+    historyLoadRetry,
   ]);
 
   // A reload never resubmits /api/chat. The history read above discovers
@@ -1353,7 +1371,9 @@ function ChatAppComponent({
 	};
 	
     writeChatRuntimeMessages(runKey, (prev) => [
-      ...prev,
+      // A refresh that completed after the durable Message POST may already
+      // include this user row. The accepted turn must appear once, in order.
+      ...prev.filter((message) => message.id !== userMsgId),
       userMessage,
       assistantMessage,
     ]);
@@ -2392,17 +2412,21 @@ function ChatAppComponent({
     // models the send was made for may answer it -- a model swapped in
     // afterwards was not part of this run and has no answer to give here.
     if (!promptPayload.modelIds.includes(modelId)) return;
+    if (transcriptScope === "conversation" && !runtime.isLoaded) return;
 
     const promptKey = `${promptPayload.id}:${promptPayload.chatId}:${modelId}`;
     if (processedPromptKeys.has(promptKey)) return;
 
     let cancelled = false;
+    let claimed = false;
+    let retainClaim = false;
     queueMicrotask(() => {
       if (cancelled || isPanelDisabled) return;
       if (processedPromptKeys.has(promptKey)) return;
       // Claimed before the barrier is awaited, not after: a re-render during
       // the await must not let a second pass start the same send.
       processedPromptKeys.add(promptKey);
+      claimed = true;
       void (async () => {
         // Every other send path (global submit, per-panel follow-up, both
         // retries) flushes the model-settings sync before it sends. This one
@@ -2413,6 +2437,7 @@ function ChatAppComponent({
         // server rather than racing it.
         const settingsReady =
           (await onBeforeSendRef.current?.(promptPayload.chatId)) ?? true;
+        if (cancelled) return;
         // Abandoned stays abandoned, exactly like the other send paths: a
         // refused flush has already told the user and put the screen back on
         // the selection the server confirmed, so re-sending behind that would
@@ -2420,7 +2445,19 @@ function ChatAppComponent({
         // payload up again. The model check catches the panel having moved on
         // while the flush was running -- sending then would file this answer
         // under a model the panel is no longer showing.
-        if (!settingsReady || panelModelIdRef.current !== modelId) return;
+        if (!settingsReady || panelModelIdRef.current !== modelId) {
+          retainClaim = true;
+          return;
+        }
+        if (transcriptScope === "conversation" &&
+            !getChatRuntimeSnapshot(runtimeKey).isLoaded) {
+          // A remount claimed a fresh history load while settings were being
+          // confirmed. Keep the durable user Message but wait for the full
+          // transcript (or its manual retry) before contacting a provider.
+          processedPromptKeys.delete(promptKey);
+          return;
+        }
+        retainClaim = true;
         void handleSendPrompt(
           promptPayload.text,
           promptPayload.chatId,
@@ -2439,6 +2476,7 @@ function ChatAppComponent({
     });
     return () => {
       cancelled = true;
+      if (claimed && !retainClaim) processedPromptKeys.delete(promptKey);
     };
   }, [
     handleSendPrompt,
@@ -2447,19 +2485,30 @@ function ChatAppComponent({
     isPanelDisabled,
     modelId,
     promptPayload,
+    runtime.isLoaded,
+    runtimeKey,
     session?.user,
     status,
+    transcriptScope,
   ]);
 
     const handleModelOnlySubmit = async () => {
         const trimmed = modelInput.trim();
-        if (!trimmed || isSending || isPanelDisabled || !initialConversationId) return;
+        if (!trimmed || isSending || isPanelDisabled || !initialConversationId ||
+            !getChatRuntimeSnapshot(runtimeKey).isLoaded) return;
         const preparationToken = beginSendPreparation(runtimeKey);
         if (!preparationToken) return;
 
         try {
           const settingsReady = await onBeforeSend?.(initialConversationId) ?? true;
           if (!settingsReady) return;
+          // Settings preparation can outlive this view's history load claim.
+          // Do not persist or dispatch a follow-up against an incomplete page.
+          if (!getChatRuntimeSnapshot(runtimeKey).isLoaded) return;
+          const completeView = !isGuestMode
+            ? captureChatRuntimeCompleteView(runtimeKey)
+            : null;
+          if (!isGuestMode && !completeView) return;
 
           const userRequestId = crypto.randomUUID();
           let userMsgId = userRequestId;
@@ -2489,6 +2538,16 @@ function ChatAppComponent({
             }
           }
 
+          if (completeView && !restoreChatRuntimeCompleteViewForSend(completeView)) {
+            // A newer local turn owns this panel now. The Message is durable,
+            // but this stale continuation has no authority to dispatch it.
+            // Do not ask for a blind resend: that could duplicate the saved
+            // question. The provider was never contacted for this turn.
+            if (isChatRuntimeCompleteViewRecordCurrent(completeView)) {
+              dispatchAppToast(t("chat.savedQuestionNotSent"), "info");
+            }
+            return;
+          }
           setModelInput("");
           onFollowupSent?.(modelId);
           await handleSendPrompt(trimmed, initialConversationId, userMsgId);
@@ -2504,11 +2563,30 @@ function ChatAppComponent({
                   <div className="min-h-0 flex-1 overflow-hidden">
       {!isCurrentMessageViewLoaded ? (
         <div
-          data-testid="chat-panel-loading"
-          aria-busy="true"
-          className="flex h-full items-center justify-center text-xs text-zinc-500"
+          data-testid={runtime.loadFailed
+            ? "chat-history-load-error" : "chat-panel-loading"}
+          role={runtime.loadFailed ? "alert" : undefined}
+          aria-busy={!runtime.loadFailed}
+          className={runtime.loadFailed
+            ? "flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-xs text-zinc-500"
+            : "flex h-full items-center justify-center text-xs text-zinc-500"}
         >
-          {t("auth.loading")}
+          {runtime.loadFailed ? (
+            <>
+              <p>{t("chat.workspaceError.title")}</p>
+              <p>{t("chat.workspaceError.body")}</p>
+              <button
+                type="button"
+                data-testid="chat-history-load-retry"
+                onClick={() => {
+                  setHistoryLoadRetry((current) => current + 1);
+                }}
+                className="min-h-11 rounded-lg border border-zinc-300 px-4 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
+              >
+                {t("chat.workspaceError.retry")}
+              </button>
+            </>
+          ) : t("auth.loading")}
         </div>
       ) : useCenteredWelcome &&
         isConversationEmpty &&
@@ -2600,7 +2678,8 @@ function ChatAppComponent({
                           type="submit"
                           data-testid="model-only-send"
                           data-model-id={modelId}
-                          disabled={!modelInput.trim() || isSending || isSendPreparing || !initialConversationId}
+                          disabled={!modelInput.trim() || isSending || isSendPreparing ||
+                            !initialConversationId || !isCurrentMessageViewLoaded}
                           className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500"
                           title={t("chat.modelOnlySendTitle")}
                           aria-label={t("chat.modelOnlySendTitle")}
diff --git a/docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/authorization.md b/docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/authorization.md
new file mode 100644
index 000000000..98c2735f6
--- /dev/null
+++ b/docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/authorization.md
@@ -0,0 +1,174 @@
+# Chat 기록 페이지네이션 복구 독립 검토 제한 승인 기록
+
+- approvedBy: `mposition` (현재 작업 지시에서 Claude 독립 검토와 `--skip-preflight` 예외 승인)
+- approvedAt: `2026-09-22` (Australia/Brisbane, 현재 작업 지시 기준)
+- author: `codex`
+- independentReviewer: `claude-code-max` (저장된 Claude Code Max 구독 CLI)
+- task: [task.json](./task.json)
+
+이 기록은 지정된 변경의 읽기 전용 교차 검토 준비 범위만 명시한다. 사용자 메시지의
+전자서명, 검토 통과, 테스트 통과, 제품 출시, commit·push·PR 병합·배포 또는
+실제 공급자 실행 승인이 아니다. 최초 작성 시점에는 package와 review를 아직
+실행하지 않았고, 이후 Claude round 0은 `request_changes`를 남겼다. 이번 문서
+보강은 그 verdict를 통과로 소급하거나 추가 권한을 부여하는 기록이 아니다.
+
+검토 기준은 base commit `ad2b51622992c29056706c443d80bdba928336e1`이다.
+검토 diff에는 [task](./task.json)의 `writableScope`에 열거된 열여섯 제품·테스트
+파일과 이 패키지의 `task.json`·`authorization.md`를 포함한다. 생성될
+`docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/records/`만
+package 명령의 동일한 exact `--out` 및 `--diff-exclude` 경로로 제외한다.
+`records/`를 `generatedPaths`에 다시 선언하지 않으며, source/test 파일이나
+상위 패키지 디렉터리를 제외하지 않는다. 범위 밖 변경이 있거나 검사에 실패하면
+검토를 진행하지 않는다.
+
+`tests/e2e/support/app-fixtures.ts`는 공용 conversation GET
+fixture가 실제 API의 필수 `messagePage`를 빠뜨려 기존
+`model-change-send-barrier.spec.ts` 7건이 새 첫 페이지 검증에서 실패한 것을
+바로잡는 최소 정합성 수정이다. 제품 API 계약을 완화하거나 첫 페이지 검증을
+우회하는 변경이 아니다. 추가된 두 spec인
+`tests/e2e/chat-markdown-theme.spec.ts`와
+`tests/e2e/conversation-draft-isolation.spec.ts`도 동일한 필수 필드를 빠뜨린
+독립 conversation detail GET fixture만 정합화한다. 검토자는 이 두 회귀와
+cached revisit·model-change·loading golden의 재실행, pending/failed 표시 구분,
+저장 완료됐으나 답변이 없는 Message의 복구 disposition을 확인한다.
+Claude round 1에서 추가로 지적된 `tests/e2e/chat-send-history-race.spec.ts`도
+독립 conversation detail GET fixture에 필수 `messagePage`가 빠져 있어, 검토
+범위에 정확한 그 테스트 파일을 추가했다. 이 fixture의 최소 정합성 수정은 제품
+첫 페이지의 fail-closed 검증을 약화하지 않는다.
+그 disposition에는 7개 locale의 정확한 안내를 포함한다. durable Message 저장이
+성공했지만 동시 최신 run에 밀려 답변 dispatch가 시작되지 않았을 때 기존
+`sendPreparationChanged`의 '다시 보내라' 안내는 중복 Message를 만들 수 있으므로,
+재전송을 지시하지 않고 reload 후 저장·답변 상태를 확인하도록 안내하는 범위에
+한정한다.
+
+Claude는 원 요구사항과 변경 diff를 먼저 읽고 작성자 설명·검증 기록을 그 뒤에
+읽는다. 사용자가 승인한 `--skip-preflight`는 읽기 도구만 허용된 Claude child에서
+쓰기 거부 probe를 입증할 수 없는 이번 검토에 한한 예외이며, preflight 통과나
+쓰기 불가능성의 증거가 아니다. `--review-despite-check-failures` 또는 실패한
+검사 우회는 허용하지 않는다. Claude child는 `--print --safe-mode
+--output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob
+--strict-mcp-config`의 읽기 전용 제한을 유지하고 shell·write 도구, 추가 MCP
+접근과 모델 override를 받지 않는다.
+
+Claude Code Max의 저장된 `claude.ai` 로그인만 사용한다. Review child에서
+`ANTHROPIC_*`, `CLAUDE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` 및
+Bedrock/Vertex/Foundry 전환 변수를 제거하고, 로그인 확인에 실패하면 중단한다.
+Anthropic API 또는 API key fallback은 금지한다. 이 제한은 parent 환경이나
+영구 설정을 바꾸라는 지시가 아니다.
+
+검토는 후속 페이지 503·malformed 첫 200 응답·cached revisit·in-flight remount,
+Review model-only 경합, draft 보존·retry와 숨겨진 전송 부재를 독립적으로 확인한다.
+실제 provider 또는 R2 호출, 유료 실행, Railway staging/production 접근,
+feature flag 변경, 자동 또는 수동 push·merge·deploy는 이 승인에 포함되지 않는다.
+
+## Round 0 수정본의 로컬 검증 (2026-09-22)
+
+이 항목은 작성자가 로컬에서 직접 실행한 결과이며 독립 검토 verdict나 Linux CI
+결과가 아니다. 검토자는 명령·환경과 변경 diff를 독립적으로 확인한다.
+
+- 자체 conversation GET fixture 두 곳의 `messagePage` 누락은 수정 전 해당 두
+  E2E 실패로 재현했고, 수정 후
+  `npm run test:e2e:run -- --project=desktop-chromium tests/e2e/chat-markdown-theme.spec.ts tests/e2e/conversation-draft-isolation.spec.ts`
+  는 13/13 통과했다.
+- `npm run test:e2e:run -- --project=desktop-chromium --project=mobile-chromium tests/e2e/chat-unified-workspace.spec.ts --grep "cached transcript"`
+  는 2/2 통과했다.
+- `npm run test:e2e:run -- --project=desktop-chromium --project=mobile-chromium tests/e2e/model-change-send-barrier.spec.ts tests/e2e/chat-state-visual-regression.spec.ts --grep "Loading state|barrier"`
+  는 13 통과·17 의도된 skip·4 실패였다. 네 실패 모두 Windows `-win32.png`
+  Loading-state golden 파일이 저장소에 없어서 발생한 것으로, 픽셀 비교 결과가
+  아니다. golden을 생성·갱신하지 않았으며 기존 일반 Loading 클래스는 원래
+  값으로 유지했다. Linux CI에서 해당 golden 비교를 따로 확인해야 한다.
+- pending history load 중 전송 버튼 비활성·거짓 오류 toast 없음, 실제 실패 후
+  오류·재시도는 E2E로 확인했다. 두 parent 전송 guard는 `loadFailed`일 때만
+  실패 toast를 표시한다.
+- Review model-only 저장 POST를 보류한 사이 새 global Review turn을 시작하는
+  경합에서, durable Message가 저장되었지만 답변 요청은 시작되지 않았음을
+  확인했다. 새 정확한 안내 기대값은 수정 전 E2E에서 실패했고, 수정 후 통과했다.
+  페이지 reload는 같은 대화의 저장 질문을 다시 보여주며 provider 자동 재전송은
+  없었다.
+- 최종 묶음
+  `npm run test:e2e:run -- --project=desktop-chromium tests/e2e/chat-unified-workspace.spec.ts tests/e2e/chat-markdown-theme.spec.ts tests/e2e/conversation-draft-isolation.spec.ts tests/e2e/model-change-send-barrier.spec.ts`
+  는 119 통과·1 기존 skip·0 실패였다. Mobile focused 실행
+  `npm run test:e2e:run -- --project=mobile-chromium tests/e2e/chat-unified-workspace.spec.ts tests/e2e/model-change-send-barrier.spec.ts --grep 'mobile composer|failed later history page|Review model-only follow-up|Review question saved behind|model change send barrier'`
+  은 6 통과·7 desktop-only skip·0 실패였다.
+- `node --conditions=react-server --import tsx --test --test-concurrency=1 tests/chatStreamRuntime.test.mjs`
+  는 21/21 통과, `npm run build`(TypeScript 포함)와 `npm run typecheck`,
+  변경된 15개 source/test/locale 파일의 `npm run lint -- <15 paths>`,
+  `git diff HEAD --check`는 모두 exit 0이다. 전체 779파일 unit suite는 이
+  최종 수정본에서 실행하지 않았으며 통과로 주장하지 않는다.
+
+## Round 1 독립 검토 후속 (2026-09-22)
+
+[round 1 verdict](./records/verdict-round1.json)는 `request_changes`와 지적 3건을
+남겼다. 이는 위의 Round 0 수정본 로컬 검증을 취소하거나 새 수정본의 검증
+통과를 뜻하지 않는다.
+
+1. `chat-send-history-race.spec.ts`의 독립 conversation detail GET fixture에는
+   실제 API의 필수 `messagePage`가 빠져 있다. Claude가 예측한 새 Chat 첫 전송
+   E2E 실패는 fixture 수정 전 이 Windows 최종 build에서 2/2 통과해 재현되지
+   않았다. 새 전송이 늦은 GET보다 먼저 runtime revision을 선점한 경로다. 따라서
+   이 파일의 `messagePage` 한 줄 보강은 재현된 실패의 수정이 아니라 실제 API
+   형식과의 정합성 수정이며, 범위에 포함해 두 경합 테스트를 다시 확인한다.
+2. 이전 계정의 model-only Message POST가 계정 전환 뒤 끝날 때
+   saved-but-unanswered toast가 새 계정 화면에 나타날 수 있다. 현재 identity와
+   owner key를 전송 후에도 대조하고, 해당 계정 전환 경합을 브라우저로 검증한다.
+3. 이전 로컬 검증의 Windows Loading-state 4건 실패는 `-win32.png` golden
+   부재였으므로 픽셀 비교 증거가 아니다. 정본 Linux runner에서 golden 갱신
+   없이 Loading-state desktop/mobile 비교를 수행하고, cached revisit 및
+   model-change의 desktop/mobile 회귀도 함께 확인한다.
+
+이 항목은 수정 계획과 남은 증거의 한계를 기록한다. 새 source/test 수정,
+Linux visual 비교, mobile 전체 회귀, 다음 Claude verdict의 결과를 여기서
+선행 성공으로 주장하지 않는다. `records/`의 기존 review 결과는 변경하지 않는다.
+
+## Round 1 수정본의 최종 로컬 검증 (2026-09-22)
+
+아래 결과는 Windows 로컬 실행이며 새 독립 verdict나 정본 Linux visual 증거가
+아니다. 검토자는 명령 범위와 실제 diff를 별도로 대조해야 한다.
+
+- desktop Chromium의 다섯 관련 spec은 **123 pass · 1 existing skip · 0 fail**이다.
+- mobile Chromium의 `chat-unified-workspace`, `model-change-send-barrier`,
+  `chat-send-history-race` 세 spec은 **102 pass · 9 desktop-only skip · 0 fail**이다.
+- guest→account identity transition의 A→B 및 A→B→A 경합은 수정 전 기대값이
+  실패하는 red를 확인했고, 수정 후 desktop·mobile 합계 **12/12 pass**로 green을
+  확인했다. 이전 identity의 saved-but-unanswered toast가 새 identity에 나타나지
+  않는 경계를 포함한다.
+- `chat-send-history-race`는 fixture 수정 전에도 Windows 최종 build에서 **2/2
+  pass**여서 Claude가 예측한 실패는 재현되지 않았다. 새 Chat 전송이 late GET보다
+  먼저 revision을 선점한 결과이며, `messagePage` 추가는 실제 conversation detail
+  API와 fixture를 맞추는 정합성 수정이다.
+- runtime unit은 **21/21 pass**이고, typecheck·변경 범위 lint·diff check는 모두
+  **exit 0**이다.
+- 전체 `npm run test:unit`은 **exit 0**이다. server는 **10,109 tests =
+  10,108 pass · 1 existing skip · 0 fail**, client는 **59/59 pass · 0 fail**이다.
+- `ubuntu-24.04` 정본 runner의 Loading-state visual golden 비교는 아직
+  **pending**이다. Windows의 golden 파일 부재와 위 기능 회귀 통과는 Linux 픽셀
+  비교를 대신하지 않으며 snapshot을 갱신했다는 주장도 하지 않는다.
+
+## Round 2 정본 Linux visual 증거 (2026-09-22)
+
+소스 snapshot commit `93b18c8f37be46cbfce47658cc638e77aa008d63`을 push한 뒤,
+기존 수동 실행 가능한 `Nightly Visual Regression` workflow를 그 exact branch
+head에서 실행했다. run은
+[`35700992823`](https://github.com/mposition/Tomverse/actions/runs/35700992823),
+job은 `106658716490`, attempt는 `1`, runner는 `ubuntu-24.04`이고 Playwright의
+pinned desktop Chromium을 설치한 뒤 snapshot update 없이
+`npm run test:e2e:visual -- --retries=0`을 실행했다.
+
+- 이 변경의 남은 증거였던 `Loading state` 9건은 **9/9 pass**였다. desktop/mobile,
+  light/dark, success와의 models·price 정합성, model-slot count 및 1057/1058px
+  breakpoint를 모두 포함한다. 따라서 Windows에서 Linux golden 부재 때문에
+  비교하지 못했던 loading placeholder는 정본 runner에서 실제 golden 비교를
+  통과했다.
+- workflow 전체 conclusion은 **failure**이며 이를 green으로 표현하지 않는다.
+  전체 81건 중 **27 pass · 54 fail**이었다. 54건은 Loading 다음의 Streaming,
+  Success, Partial/Full error, Retry, credits, Deep Research, attachment 및 AI Review
+  상태에 분포한다. 실패 diff/report artifact는
+  `nightly-visual-regression-35700992823`(artifact id `10682643399`)로 보존됐다.
+- 이 task diff는 `chat-state-visual-regression.spec.ts`와 그 snapshot 파일을
+  수정하지 않는다. 직전 green scheduled run `35663989907`의 main head
+  `9e4fd0c52a5d5b764d4e1b70e819ce7628d67481`과 task base
+  `ad2b51622992c29056706c443d80bdba928336e1` 사이에는 ChatPageClient,
+  ChatApp, ChatInput, ChatMessageList, ChatSidebar, desktop/mobile shells 등 대규모
+  UI 변경과 일부 golden 변경이 존재한다. 이 사실은 범위 밖 54건을 통과로
+  바꾸지 않으며, 이번 review는 exact source head의 Loading 9건 통과와 전체
+  workflow red를 함께 판단해야 한다. golden은 생성하거나 갱신하지 않았다.
diff --git a/docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/task.json b/docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/task.json
new file mode 100644
index 000000000..2354914d5
--- /dev/null
+++ b/docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/task.json
@@ -0,0 +1,35 @@
+{
+  "taskId": "chat-history-pagination-recovery-v1",
+  "requirement": "Tomverse Chat의 기존 대화 기록을 페이지별로 복원할 때 첫 페이지와 모든 후속 페이지가 완전하고 유효할 때만 해당 runtime transcript를 loaded로 인정한다. 후속 페이지 503, malformed 첫 200 응답, 누락·반복 cursor, 캐시된 대화 재방문 및 진행 중 조회를 상속한 panel remount에서 부분 기록을 성공처럼 표시하거나 전송하지 않는다. 실패 상태와 수동 retry는 동일 identity·conversation runtime key에 결속하고 작성 중인 draft를 보존하며, 조회 재시도가 provider POST를 만들지 않는다. Review의 다중 모델 model-only 경로도 재조회 중 숨겨진 전송을 만들지 않고 기존 정상 동작을 유지한다. E2E conversation detail GET fixture는 실제 API와 같은 필수 messagePage를 반환해야 하며 chat-send-history-race의 독립 fixture도 이 계약을 따른다. 저장된 Message에 대한 답변 dispatch가 시작되지 않은 경우에는 중복 Message를 만들 수 있는 재전송 대신 reload로 사실을 확인하도록 7개 locale의 정확한 안내를 제공한다. 변경은 지정된 열여섯 제품·테스트 파일과 이 검토 패키지에 한정한다. 실제 provider 호출, 유료 실행, Railway staging/production, flag 변경, 병합·배포는 범위 밖이다. author는 Codex, 독립 reviewer는 Claude Code Max 구독 CLI다.",
+  "completionCriteria": [
+    "첫 페이지와 후속 페이지의 messages 및 messagePage 형식을 검사하고, 후속 페이지 503·malformed JSON·누락 또는 반복 cursor를 complete history로 오인하지 않는다. 실패한 페이지까지의 임시 messages는 화면이나 전송 context에 적용하지 않는다.",
+    "이전에 loaded였던 대화를 재방문해 후속 페이지 갱신에 실패해도 cached loaded=true가 남지 않는다. 같은 runtime key의 in-flight load를 새 panel이 상속한 뒤 이전 panel의 요청이 실패하면 공유 실패 상태를 관측하고 수동 retry에 도달한다. 낡은 ticket의 release/settle은 최신 ticket을 바꾸지 않는다.",
+    "local send 또는 stream이 조회 중 동일 key의 transcript revision을 진전시킨 경우 늦은 조회 응답은 그 transcript를 덮지 않는다. identity·conversation 전환 뒤 이전 응답과 실패는 현재 화면, 다른 key의 draft·toast 또는 전송 권한으로 이전되지 않는다. 특히 다른 계정으로 전환한 뒤 이전 계정의 보류 중 Message save가 끝나도 saved-but-unanswered 안내를 새 계정 화면에 표시하지 않는다.",
+    "기록 로드 전·실패 중에는 Chat 전역 composer와 Review 다중 모델 model-only form의 모든 전송 진입점이 Message 저장과 provider POST 전에 멈춘다. 비활성 버튼 외에 Enter/form submit 및 settings-preparation 대기 뒤의 재검사도 포함한다. 다만 Message POST가 이미 in flight인 동안 viewport remount가 기록 GET claim을 시작하고 그 Message save가 성공한 경우, 이미 커밋된 Message를 답변 없이 버리지 않고 완전한 cached transcript를 보존하며 한 번만 이어서 전송해야 한다. Message 저장 이후 onBeforeSend 대기 중 발생하는 remount·기록 claim도 같은 계약으로 검증한다. Review 다중 모델 model-only Message POST 진행 중 viewport remount와 page2 GET hold/503이 겹친 뒤 POST가 commit되면 provider stream이 spinner 뒤에 숨지 않거나 완전 로드까지 보류되며, 실패한 GET을 성공으로 위장하지 않는지 검증한다. 정상 로드 뒤에는 해당 경로가 한 번만 전송된다.",
+    "오류 UI는 현재 runtime key의 실제 실패에만 나타나고 pending load와 failed load를 서로 다른 메시지·상태로 정직하게 표시한다. 재시도는 기록 GET만 다시 수행하고 중복 provider 실행·무한 자동 재시도·숨겨진 답변을 만들지 않으며, 사용자가 입력한 draft는 실패·재시도·대화 전환 중 보존된다. durable Message 저장은 성공했으나 동시 최신 run이 이겨 답변 dispatch가 시작되지 않은 경우, 완료나 미저장으로 위장하지 않고 중복 Message 위험이 있는 '다시 보내라' 대신 reload로 확인하라는 정확한 복구 disposition을 7개 locale에 제공하고 검증한다.",
+    "집중 runtime unit과 desktop/mobile 브라우저 회귀는 후속 페이지 503, malformed 첫 200, cached revisit, in-flight remount 실패, Review model-only 경합, draft/retry, 완전한 message 순서 및 Chat POST 0건의 실패 경계를 검증한다. 정상 복구 뒤 전송은 완전한 기록을 사용한다. 공용 및 세 독립 E2E fixture는 실제 conversation detail GET의 필수 messagePage 형식을 유지해야 하며 chat-markdown-theme, conversation-draft-isolation, chat-send-history-race, model-change-send-barrier 회귀를 실행한다. cached revisit와 model-change를 desktop/mobile에서 재실행하고 Loading-state golden은 Windows에서 파일 부재로 난 실패를 픽셀 통과로 오인하지 않고 정본 Linux runner에서 snapshot 갱신 없이 실제 비교한다. 관련 regression, typecheck, lint 및 diff guard의 실제 결과를 기록하며 실패·skip을 통과로 표현하지 않는다.",
+    "검토 package는 base ad2b51622992c29056706c443d80bdba928336e1 이후 지정된 열여섯 변경 파일과 이 task/authorization을 모두 포함한다. 생성된 records/만 동일한 exact --out 및 --diff-exclude 경로로 제외하고 source/test나 다른 파일을 제외하지 않는다. generatedPaths는 빈 배열이다.",
+    "Claude는 요구사항과 전체 diff를 먼저 읽고 작성자 테스트 기록을 그 뒤에 검토한다. verdict는 package digest를 명시하고 finding마다 위치·심각도·근거·재현을 제공한다. 사용자 승인 --skip-preflight 예외와 저장된 Claude Code Max 구독 CLI의 읽기 전용 도구만 사용한다. Anthropic API·API key fallback, --review-despite-check-failures, 실제 provider/staging 호출, 과금, flag 변경, push·merge·deploy는 이 task가 승인하지 않는다."
+  ],
+  "baseCommit": "ad2b51622992c29056706c443d80bdba928336e1",
+  "writableScope": [
+    "app/(site)/(application)/chat/ChatPageClient.tsx",
+    "components/chat/ChatApp.tsx",
+    "lib/chatStreamRuntime.ts",
+    "locales/de.ts",
+    "locales/en.ts",
+    "locales/es.ts",
+    "locales/fr.ts",
+    "locales/ko.ts",
+    "locales/pt.ts",
+    "locales/zh.ts",
+    "tests/chatStreamRuntime.test.mjs",
+    "tests/e2e/chat-markdown-theme.spec.ts",
+    "tests/e2e/chat-send-history-race.spec.ts",
+    "tests/e2e/chat-unified-workspace.spec.ts",
+    "tests/e2e/conversation-draft-isolation.spec.ts",
+    "tests/e2e/support/app-fixtures.ts",
+    "docs/ops/cross-review/packages/chat-history-pagination-recovery-v1"
+  ],
+  "generatedPaths": []
+}
diff --git a/lib/chatStreamRuntime.ts b/lib/chatStreamRuntime.ts
index cf47802c0..c6def402a 100644
--- a/lib/chatStreamRuntime.ts
+++ b/lib/chatStreamRuntime.ts
@@ -99,6 +99,8 @@ export type ChatRuntimeSnapshot = {
   messages: Message[];
   /** True once `messages` describes this exact key -- not a previous view. */
   isLoaded: boolean;
+  /** The newest history load failed; any remounted panel may offer a manual retry. */
+  loadFailed: boolean;
   /** A request, stream or deep-research poll this key owns is in flight. */
   isStreaming: boolean;
 };
@@ -142,10 +144,13 @@ const EMPTY_MESSAGES = Object.freeze([]) as unknown as Message[];
 export const EMPTY_CHAT_RUNTIME_SNAPSHOT: ChatRuntimeSnapshot = Object.freeze({
   messages: EMPTY_MESSAGES,
   isLoaded: false,
+  loadFailed: false,
   isStreaming: false,
 });
 
 type ChatRuntimeRecord = {
+  /** Unique for each lifetime of a key, including after identity release. */
+  generation: number;
   snapshot: ChatRuntimeSnapshot;
   listeners: Set<() => void>;
   /** Stops the run this key owns. Null when nothing is in flight. */
@@ -174,6 +179,10 @@ type ChatRuntimeRecord = {
 };
 
 const records = new Map<string, ChatRuntimeRecord>();
+let nextRecordGeneration = 1;
+// A key can be deleted on A→B and recreated on B→A. Tickets must remain
+// unique across those record lifetimes, not merely within one record.
+let nextLoadRequestId = 1;
 
 const notify = (record: ChatRuntimeRecord) => {
   for (const listener of record.listeners) listener();
@@ -204,6 +213,7 @@ const ensureRecord = (key: string): ChatRuntimeRecord => {
     return existing;
   }
   const created: ChatRuntimeRecord = {
+    generation: nextRecordGeneration++,
     snapshot: EMPTY_CHAT_RUNTIME_SNAPSHOT,
     listeners: new Set(),
     controller: null,
@@ -226,6 +236,7 @@ const patchSnapshot = (key: string, patch: Partial<ChatRuntimeSnapshot>): void =
   if (
     next.messages === record.snapshot.messages &&
     next.isLoaded === record.snapshot.isLoaded &&
+    next.loadFailed === record.snapshot.loadFailed &&
     next.isStreaming === record.snapshot.isStreaming
   ) {
     return;
@@ -305,6 +316,50 @@ export function advanceChatRuntimeRevision(key: string): number {
   return record.revision;
 }
 
+/** A complete server view witnessed before an awaited durable Message save. */
+export type ChatRuntimeCompleteView = {
+  key: string;
+  messages: Message[];
+  revision: number;
+  generation: number;
+};
+
+export function captureChatRuntimeCompleteView(key: string): ChatRuntimeCompleteView | null {
+  const record = records.get(key);
+  if (!record?.snapshot.isLoaded || record.snapshot.isStreaming) return null;
+  return { key, messages: record.snapshot.messages, revision: record.revision,
+    generation: record.generation };
+}
+
+/** A stale continuation must not announce its old account's result after identity release. */
+export function isChatRuntimeCompleteViewRecordCurrent(view: ChatRuntimeCompleteView): boolean {
+  return records.get(view.key)?.generation === view.generation;
+}
+
+/**
+ * A confirmed send may use its previously complete view even if a remount
+ * started another GET while the Message POST was on the wire. Supersede that
+ * GET before publishing the local turn; its late result cannot hide or replace
+ * the answer. Never restore over a newer local send or stream.
+ */
+export function restoreChatRuntimeCompleteViewForSend(view: ChatRuntimeCompleteView): boolean {
+  const record = records.get(view.key);
+  if (!record || record.generation !== view.generation ||
+      record.revision !== view.revision || record.snapshot.isStreaming) return false;
+  record.loadRequestId = nextLoadRequestId++;
+  record.isLoading = false;
+  patchSnapshot(view.key, {
+    // A refresh may have completed while the Message POST was pending. Its
+    // complete server view can include newer rows from another tab and must
+    // not be replaced by the older capture. Only an incomplete/failed load
+    // needs the captured complete view restored.
+    messages: record.snapshot.isLoaded ? record.snapshot.messages : view.messages,
+    isLoaded: true,
+    loadFailed: false,
+  });
+  return true;
+}
+
 export function setChatRuntimeLastPrompt(
   key: string,
   prompt: ChatRuntimeLastPrompt | null
@@ -338,11 +393,15 @@ export function isChatRuntimeLoadInFlight(key: string): boolean {
   return records.get(key)?.isLoading ?? false;
 }
 
-/** Claims the newest load ticket for this key. */
+/** Claims the newest load ticket and closes the send barrier until it settles. */
 export function claimChatRuntimeLoad(key: string): number {
   const record = ensureRecord(key);
-  record.loadRequestId += 1;
+  record.loadRequestId = nextLoadRequestId++;
   record.isLoading = true;
+  // A cached server view is not proof that this refresh completed. Invalidate
+  // it synchronously so neither this panel nor the parent composer can send
+  // with an incomplete or failed later page.
+  patchSnapshot(key, { isLoaded: false, loadFailed: false });
   return record.loadRequestId;
 }
 
@@ -365,7 +424,7 @@ export function settleChatRuntimeLoad(
   const record = records.get(key);
   if (!record || record.loadRequestId !== requestId) return;
   record.isLoading = false;
-  patchSnapshot(key, { isLoaded: outcome.loaded });
+  patchSnapshot(key, { isLoaded: outcome.loaded, loadFailed: false });
 }
 
 /**
@@ -377,6 +436,7 @@ export function releaseChatRuntimeLoad(key: string, requestId: number): void {
   const record = records.get(key);
   if (!record || record.loadRequestId !== requestId) return;
   record.isLoading = false;
+  patchSnapshot(key, { isLoaded: false, loadFailed: true });
 }
 
 /* -------------------------------------------------------------------------
diff --git a/locales/de.ts b/locales/de.ts
index 945083cc1..ba7e03b79 100644
--- a/locales/de.ts
+++ b/locales/de.ts
@@ -139,6 +139,7 @@ export const de = {
         messageReceiptRecoveryBody: "Die Speicherantwort wurde unterbrochen. Die Bearbeitung ist pausiert, damit die Frage nicht doppelt gesendet wird oder verloren geht. Laden Sie die Unterhaltung neu, um den Speicherstatus sicher zu prüfen.",
         messageReceiptRecoveryReload: "Unterhaltung neu laden",
         sendPreparationChanged: "Während der Vorbereitung wurde die Unterhaltung oder das Modell geändert. Prüfe deine Frage und sende sie erneut.",
+        savedQuestionNotSent: "Deine Frage wurde gespeichert, aber keine Antwortanfrage gesendet. Lade diese Unterhaltung neu, um den Status vor einem erneuten Versuch zu prüfen.",
         conversationOpenFailed: "Diese Unterhaltung konnte nicht geöffnet werden. Deine aktuelle Unterhaltung bleibt unverändert.",
         questionSaveFailed: "Die Frage konnte nicht mit ihren Dateien gespeichert werden. Dein Entwurf bleibt erhalten.",
         retryQuestionSaveFailed: "Die Frage konnte für diesen erneuten Versuch nicht gespeichert werden. Es wurde keine Antwort angefordert.",
diff --git a/locales/en.ts b/locales/en.ts
index 0a13b00df..1f3c961ef 100644
--- a/locales/en.ts
+++ b/locales/en.ts
@@ -126,6 +126,7 @@ export const en = {
     },
    chat: {
         sendPreparationChanged: "The conversation or model changed while preparing the answer. Check your question and send again.",
+        savedQuestionNotSent: "Your question was saved, but no answer request was sent. Reload this conversation to check it before trying again.",
         conversationOpenFailed: "This conversation could not be opened. Your current conversation has not changed.",
         questionSaveFailed: "The question could not be saved with its files. Your draft has been kept.",
         retryQuestionSaveFailed: "The question could not be saved for this retry. No answer request was sent.",
diff --git a/locales/es.ts b/locales/es.ts
index 469db770c..2b5b50f12 100644
--- a/locales/es.ts
+++ b/locales/es.ts
@@ -139,6 +139,7 @@ export const es = {
         messageReceiptRecoveryBody: "La respuesta de guardado se interrumpió. La edición está pausada para evitar preguntas duplicadas o perdidas. Recarga la conversación para comprobar el estado guardado de forma segura.",
         messageReceiptRecoveryReload: "Recargar conversación",
         sendPreparationChanged: "La conversación o el modelo cambió mientras se preparaba la respuesta. Revisa tu pregunta y envíala de nuevo.",
+        savedQuestionNotSent: "Tu pregunta se guardó, pero no se envió ninguna solicitud de respuesta. Recarga esta conversación para comprobar su estado antes de intentarlo de nuevo.",
         conversationOpenFailed: "No se pudo abrir esta conversación. Tu conversación actual no ha cambiado.",
         questionSaveFailed: "No se pudo guardar la pregunta con sus archivos. Tu borrador se ha conservado.",
         retryQuestionSaveFailed: "No se pudo guardar la pregunta para este reintento. No se envió ninguna solicitud de respuesta.",
diff --git a/locales/fr.ts b/locales/fr.ts
index fd8cfbf39..91f41bed0 100644
--- a/locales/fr.ts
+++ b/locales/fr.ts
@@ -139,6 +139,7 @@ export const fr = {
         messageReceiptRecoveryBody: "La réponse d’enregistrement a été interrompue. La modification est suspendue pour éviter une question perdue ou en double. Rechargez la conversation pour vérifier son état en toute sécurité.",
         messageReceiptRecoveryReload: "Recharger la conversation",
         sendPreparationChanged: "La conversation ou le modèle a changé pendant la préparation. Vérifiez votre question et envoyez-la à nouveau.",
+        savedQuestionNotSent: "Votre question a été enregistrée, mais aucune demande de réponse n’a été envoyée. Rechargez cette conversation pour vérifier son état avant de réessayer.",
         conversationOpenFailed: "Cette conversation n’a pas pu être ouverte. Votre conversation actuelle reste inchangée.",
         questionSaveFailed: "La question n’a pas pu être enregistrée avec ses fichiers. Votre brouillon a été conservé.",
         retryQuestionSaveFailed: "La question n’a pas pu être enregistrée pour cette nouvelle tentative. Aucune demande de réponse n’a été envoyée.",
diff --git a/locales/ko.ts b/locales/ko.ts
index e1e7e0ff6..333993b86 100644
--- a/locales/ko.ts
+++ b/locales/ko.ts
@@ -130,6 +130,7 @@ export const ko = {
     },
    chat: {
         sendPreparationChanged: "답변 준비 중 대화 또는 모델이 변경되었습니다. 질문을 확인한 뒤 다시 전송해 주세요.",
+        savedQuestionNotSent: "질문은 저장되었지만 답변 요청은 전송되지 않았습니다. 다시 시도하기 전에 이 대화를 새로고침해 상태를 확인해 주세요.",
         conversationOpenFailed: "이 대화를 열지 못했습니다. 현재 대화는 그대로 유지됩니다.",
         questionSaveFailed: "파일과 함께 질문을 저장하지 못했습니다. 작성 중인 초안은 유지됩니다.",
         retryQuestionSaveFailed: "다시 시도할 질문을 저장하지 못했습니다. 답변 요청은 전송되지 않았습니다.",
diff --git a/locales/pt.ts b/locales/pt.ts
index 2b2e5c5cd..ab92ce643 100644
--- a/locales/pt.ts
+++ b/locales/pt.ts
@@ -139,6 +139,7 @@ export const pt = {
         messageReceiptRecoveryBody: "A resposta de gravação foi interrompida. A edição está pausada para evitar uma pergunta duplicada ou perdida. Recarregue a conversa para verificar o estado guardado com segurança.",
         messageReceiptRecoveryReload: "Recarregar conversa",
         sendPreparationChanged: "A conversa ou o modelo mudou durante a preparação da resposta. Confira a pergunta e envie novamente.",
+        savedQuestionNotSent: "A sua pergunta foi guardada, mas não foi enviado nenhum pedido de resposta. Recarregue esta conversa para verificar o estado antes de tentar novamente.",
         conversationOpenFailed: "Não foi possível abrir esta conversa. A sua conversa atual permanece inalterada.",
         questionSaveFailed: "Não foi possível salvar a pergunta com seus arquivos. Seu rascunho foi mantido.",
         retryQuestionSaveFailed: "Não foi possível salvar a pergunta para esta nova tentativa. Nenhuma solicitação de resposta foi enviada.",
diff --git a/locales/zh.ts b/locales/zh.ts
index f65b7ea8a..ca10c0a13 100644
--- a/locales/zh.ts
+++ b/locales/zh.ts
@@ -156,6 +156,7 @@ export const zh = {
         messageReceiptRecoveryBody: "保存响应已中断。为避免问题重复发送或丢失，编辑已暂停。请重新加载对话以安全确认保存状态。",
         messageReceiptRecoveryReload: "重新加载对话",
         sendPreparationChanged: "准备回答时，对话或模型发生了变化。请检查问题后重新发送。",
+        savedQuestionNotSent: "您的问题已保存，但尚未发送回答请求。再次尝试前，请重新加载此对话以确认状态。",
         conversationOpenFailed: "无法打开此对话。您当前的对话保持不变。",
         questionSaveFailed: "无法连同文件一起保存问题。你的草稿已保留。",
         retryQuestionSaveFailed: "无法保存本次重试的问题，因此未发送回答请求。",
diff --git a/tests/chatStreamRuntime.test.mjs b/tests/chatStreamRuntime.test.mjs
index e1d2280ab..73ee69994 100644
--- a/tests/chatStreamRuntime.test.mjs
+++ b/tests/chatStreamRuntime.test.mjs
@@ -7,6 +7,7 @@ import {
   chatRuntimeIdentityKey,
   chatRuntimeKey,
   chatRuntimeKeyIdentity,
+  captureChatRuntimeCompleteView,
   claimChatRuntimeLoad,
   endChatRuntimeRun,
   getChatRuntimeLastPrompt,
@@ -17,10 +18,12 @@ import {
   isChatRuntimeLoadInFlight,
   isChatRuntimeStreaming,
   isCurrentChatRuntimeLoad,
+  isChatRuntimeCompleteViewRecordCurrent,
   markChatRuntimeJobResumed,
   ownsChatRuntimeTranscript,
   releaseChatRuntimeForOtherIdentities,
   releaseChatRuntimeLoad,
+  restoreChatRuntimeCompleteViewForSend,
   resetChatStreamRuntime,
   setChatRuntimeLastPrompt,
   settleChatRuntimeLoad,
@@ -190,6 +193,40 @@ test("a failed load releases its claim so a later attempt can retry", () => {
   );
 });
 
+test("refreshing a cached transcript invalidates the loaded send barrier until it settles", () => {
+  const first = claimChatRuntimeLoad(A);
+  settleChatRuntimeLoad(A, first, { loaded: true });
+  assert.equal(getChatRuntimeSnapshot(A).isLoaded, true);
+
+  const refresh = claimChatRuntimeLoad(A);
+  assert.equal(getChatRuntimeSnapshot(A).isLoaded, false);
+  releaseChatRuntimeLoad(A, refresh);
+  assert.equal(getChatRuntimeSnapshot(A).isLoaded, false);
+
+  const retry = claimChatRuntimeLoad(A);
+  settleChatRuntimeLoad(A, retry, { loaded: true });
+  assert.equal(getChatRuntimeSnapshot(A).isLoaded, true);
+});
+
+test("a failed load notifies a remounted subscriber and a new ticket clears only its own failure", () => {
+  const snapshots = [];
+  const unsubscribe = subscribeChatRuntime(A, () => {
+    const { isLoaded, loadFailed } = getChatRuntimeSnapshot(A);
+    snapshots.push({ isLoaded, loadFailed });
+  });
+  const first = claimChatRuntimeLoad(A);
+  releaseChatRuntimeLoad(A, first);
+  assert.deepEqual(snapshots.at(-1), { isLoaded: false, loadFailed: true });
+
+  const retry = claimChatRuntimeLoad(A);
+  assert.deepEqual(snapshots.at(-1), { isLoaded: false, loadFailed: false });
+  releaseChatRuntimeLoad(A, first);
+  assert.deepEqual(snapshots.at(-1), { isLoaded: false, loadFailed: false });
+  settleChatRuntimeLoad(A, retry, { loaded: true });
+  assert.deepEqual(snapshots.at(-1), { isLoaded: true, loadFailed: false });
+  unsubscribe();
+});
+
 test("a transcript this session produced is never re-read from the server", () => {
   const requestId = claimChatRuntimeLoad(A);
   settleChatRuntimeLoad(A, requestId, { loaded: true });
@@ -222,6 +259,78 @@ test("an unloaded key is never treated as owning a transcript", () => {
   );
 });
 
+test("a confirmed send restores only the complete view it captured before a remount load", () => {
+  writeChatRuntimeMessages(A, [{ id: "saved-51", role: "user", content: "Complete history" }]);
+  const initial = claimChatRuntimeLoad(A);
+  settleChatRuntimeLoad(A, initial, { loaded: true });
+  const completeView = captureChatRuntimeCompleteView(A);
+  assert.ok(completeView);
+
+  const refresh = claimChatRuntimeLoad(A);
+  assert.equal(getChatRuntimeSnapshot(A).isLoaded, false);
+  assert.equal(restoreChatRuntimeCompleteViewForSend(completeView), true);
+  assert.equal(isCurrentChatRuntimeLoad(A, refresh), false);
+  assert.equal(isChatRuntimeLoadInFlight(A), false);
+  assert.equal(getChatRuntimeSnapshot(A).isLoaded, true);
+  assert.deepEqual(getChatRuntimeSnapshot(A).messages.map((item) => item.id), ["saved-51"]);
+  releaseChatRuntimeLoad(A, refresh);
+  assert.equal(getChatRuntimeSnapshot(A).loadFailed, false);
+
+  advanceChatRuntimeRevision(A);
+  assert.equal(restoreChatRuntimeCompleteViewForSend(completeView), false);
+  assert.equal(isChatRuntimeCompleteViewRecordCurrent(completeView), true);
+  assert.equal(captureChatRuntimeCompleteView(A)?.revision, 1);
+});
+
+test("a confirmed send keeps a newer complete GET instead of its older capture", () => {
+  writeChatRuntimeMessages(A, [{ id: "saved-52", role: "user", content: "Older complete view" }]);
+  const initial = claimChatRuntimeLoad(A);
+  settleChatRuntimeLoad(A, initial, { loaded: true });
+  const capture = captureChatRuntimeCompleteView(A);
+  assert.ok(capture);
+
+  const refresh = claimChatRuntimeLoad(A);
+  writeChatRuntimeMessages(A, [
+    { id: "saved-52", role: "user", content: "Older complete view" },
+    { id: "saved-53", role: "user", content: "New durable row from another tab" },
+  ]);
+  settleChatRuntimeLoad(A, refresh, { loaded: true });
+  assert.equal(restoreChatRuntimeCompleteViewForSend(capture), true);
+  assert.deepEqual(getChatRuntimeSnapshot(A).messages.map((item) => item.id), ["saved-52", "saved-53"]);
+});
+
+test("a captured view cannot overwrite a new record for the same identity after A-B-A", () => {
+  writeChatRuntimeMessages(A, [{ id: "old-a", role: "user", content: "Old session" }]);
+  const oldLoad = claimChatRuntimeLoad(A);
+  settleChatRuntimeLoad(A, oldLoad, { loaded: true });
+  const oldCapture = captureChatRuntimeCompleteView(A);
+  assert.ok(oldCapture);
+  assert.equal(isChatRuntimeCompleteViewRecordCurrent(oldCapture), true);
+
+  releaseChatRuntimeForOtherIdentities("account:other-user");
+  assert.equal(isChatRuntimeCompleteViewRecordCurrent(oldCapture), false);
+  writeChatRuntimeMessages(A, [{ id: "new-a", role: "user", content: "New session" }]);
+  const newLoad = claimChatRuntimeLoad(A);
+  settleChatRuntimeLoad(A, newLoad, { loaded: true });
+  assert.equal(isChatRuntimeCompleteViewRecordCurrent(oldCapture), false);
+  assert.equal(restoreChatRuntimeCompleteViewForSend(oldCapture), false);
+  assert.deepEqual(getChatRuntimeSnapshot(A).messages.map((item) => item.id), ["new-a"]);
+});
+
+test("a pre-switch load ticket cannot settle a new A record after A-B-A", () => {
+  const oldTicket = claimChatRuntimeLoad(A);
+  releaseChatRuntimeForOtherIdentities("account:other-user");
+  const newTicket = claimChatRuntimeLoad(A);
+  assert.notEqual(oldTicket, newTicket);
+  assert.equal(isCurrentChatRuntimeLoad(A, oldTicket), false);
+  settleChatRuntimeLoad(A, oldTicket, { loaded: true });
+  releaseChatRuntimeLoad(A, oldTicket);
+  assert.equal(getChatRuntimeSnapshot(A).isLoaded, false);
+  assert.equal(isChatRuntimeLoadInFlight(A), true);
+  settleChatRuntimeLoad(A, newTicket, { loaded: true });
+  assert.equal(getChatRuntimeSnapshot(A).isLoaded, true);
+});
+
 test("a deep-research job is re-attached to once, not once per remount", () => {
   assert.equal(hasResumedChatRuntimeJob(A, "job-1"), false);
   markChatRuntimeJobResumed(A, "job-1");
diff --git a/tests/e2e/chat-markdown-theme.spec.ts b/tests/e2e/chat-markdown-theme.spec.ts
index 56aae5aa0..688104375 100644
--- a/tests/e2e/chat-markdown-theme.spec.ts
+++ b/tests/e2e/chat-markdown-theme.spec.ts
@@ -28,6 +28,7 @@ test("assistant code blocks keep readable contrast in the light theme", async ({
         shareEnabled: false,
         shareExpiresAt: null,
         nextCursor: null,
+        messagePage: { hasMore: false, nextCursor: null },
         messages: [
           {
             id: "assistant-code-block",
diff --git a/tests/e2e/chat-send-history-race.spec.ts b/tests/e2e/chat-send-history-race.spec.ts
index 8f5b30fcf..50778b74b 100644
--- a/tests/e2e/chat-send-history-race.spec.ts
+++ b/tests/e2e/chat-send-history-race.spec.ts
@@ -54,6 +54,7 @@ async function delayConversationHistory(page: Page, delayMs: number) {
           disabledPanels: [],
           messages: [],
           nextCursor: null,
+          messagePage: { hasMore: false, nextCursor: null },
         }),
       });
     }
diff --git a/tests/e2e/chat-unified-workspace.spec.ts b/tests/e2e/chat-unified-workspace.spec.ts
index ac18d1137..0babd23af 100644
--- a/tests/e2e/chat-unified-workspace.spec.ts
+++ b/tests/e2e/chat-unified-workspace.spec.ts
@@ -307,6 +307,7 @@ async function openChat(page: Page, options: {
   messageSaveResponseLostAfterCommit?: boolean;
   messageSaveBodyStall?: boolean;
   holdMessageSaveBeforeTransaction?: boolean;
+  holdFirstMessageSaveBeforeTransaction?: boolean;
   messageReceiptUnavailable?: boolean;
   messageReceiptResponseBody?: unknown;
   messageReceiptBodyStall?: boolean;
@@ -315,6 +316,10 @@ async function openChat(page: Page, options: {
   holdDraftHydrate?: boolean;
   holdNextDraftMutation?: boolean;
   draftSyncFailure?: boolean;
+  historyPageFailureOnCursorRead?: number;
+  holdHistoryPageFailure?: boolean;
+  holdContextBundleOnce?: boolean;
+  malformedFirstHistoryPageOnRead?: number;
   malformedDraftRead?: boolean;
   invalidDraftAttachmentRead?: boolean;
   draftFailurePlan?: Array<{ method: string; scopeKey: string }>;
@@ -369,6 +374,11 @@ async function openChat(page: Page, options: {
   let attemptReadCount = 0;
   const attemptPollFailures: Array<{ status: number; retryAfter?: string }> = [];
   let contextBundleRead = 0;
+  let contextBundleStarted = false;
+  let releaseContextBundle = () => {};
+  const contextBundleGate = new Promise<void>((resolve) => {
+    releaseContextBundle = resolve;
+  });
   let messageSaveFailureReturned = false;
   let draftHydrateStarted = false;
   let draftReadCount = 0;
@@ -377,6 +387,7 @@ async function openChat(page: Page, options: {
   let draftFailuresReturned = 0;
   let draftMutationStarted = false;
   let messageSaveStarted = false;
+  let messageSaveCount = 0;
   let messageReceiptStarted = false;
   let releaseDraftHydrate = () => {};
   let releaseDraftMutation = () => {};
@@ -400,6 +411,13 @@ async function openChat(page: Page, options: {
   const accountBConversations: ConversationFixture[] = [];
   let exposePreviousAccountDrafts = true;
   let visibleConversations = conversations;
+  let historyCursorReadCount = 0;
+  let firstHistoryPageReadCount = 0;
+  let historyPageFailureStarted = false;
+  let releaseHistoryPageFailure = () => {};
+  const historyPageFailureGate = new Promise<void>((resolve) => {
+    releaseHistoryPageFailure = resolve;
+  });
   const payload = (row: ConversationFixture) => ({
     ...row, disabledPanels: options.disabledPanels ?? [], webSearchMode: "off", memoryMode: "inherit",
     selectionMode: "manual", autoSelection: { offered: false },
@@ -629,7 +647,11 @@ async function openChat(page: Page, options: {
     if (!row) return route.fulfill({ status: 404, json: { code: "CONVERSATION_NOT_FOUND" } });
     if (path.endsWith("/messages") && method === "POST") {
       messageSaveStarted = true;
-      if (options.holdMessageSaveBeforeTransaction) await messageSaveGate;
+      messageSaveCount += 1;
+      if (options.holdMessageSaveBeforeTransaction ||
+          (options.holdFirstMessageSaveBeforeTransaction && messageSaveCount === 1)) {
+        await messageSaveGate;
+      }
       if (
         options.messageSaveFailure ||
         (options.messageSaveFailureOnce && !messageSaveFailureReturned)
@@ -712,7 +734,33 @@ async function openChat(page: Page, options: {
     }
     if (method === "PATCH" && Array.isArray(body.selectedModels)) row.selectedModels = body.selectedModels as string[];
     if (method === "GET") historyReads.push(url.pathname + url.search);
-    return route.fulfill({ json: payload(row) });
+    if (method === "GET" && row.id === CONVERSATION && !url.searchParams.has("cursor") &&
+        ++firstHistoryPageReadCount === options.malformedFirstHistoryPageOnRead) {
+      return route.fulfill({ json: {
+        ...payload(row), messages: null,
+        messagePage: { hasMore: false, nextCursor: null },
+      } });
+    }
+    if (method === "GET" && options.historyPageFailureOnCursorRead && row.id === CONVERSATION) {
+      const cursor = url.searchParams.get("cursor");
+      if (cursor && ++historyCursorReadCount === options.historyPageFailureOnCursorRead) {
+        historyPageFailureStarted = true;
+        if (options.holdHistoryPageFailure) await historyPageFailureGate;
+        return route.fulfill({ status: 503, json: { code: "QA_HISTORY_PAGE_UNAVAILABLE" } });
+      }
+      const cursorIndex = cursor ? row.messages.findIndex((message) => message.id === cursor) : -1;
+      if (cursor && cursorIndex < 0) throw new Error("QA history cursor was not found");
+      const start = cursorIndex + 1;
+      const messages = row.messages.slice(start, start + 50);
+      const hasMore = start + messages.length < row.messages.length;
+      return route.fulfill({ json: {
+        ...payload(row), messages,
+        messagePage: { hasMore, nextCursor: hasMore ? messages.at(-1)?.id ?? null : null },
+      } });
+    }
+    return route.fulfill({ json: method === "GET"
+      ? { ...payload(row), messagePage: { hasMore: false, nextCursor: null } }
+      : payload(row) });
   });
   // No title generation, provider operation or real ownership mutation escapes
   // the fabricated routes, even if a regression calls an unexpected endpoint.
@@ -720,6 +768,14 @@ async function openChat(page: Page, options: {
   // Same no-memory contract used by chat-memory-context.spec.ts. Preparation
   // stays local too; a dummy database refusal is not needed for this journey.
   await page.route("**/api/chat/context", (route) => {
+    if (options.holdContextBundleOnce && contextBundleRead === 0) {
+      contextBundleStarted = true;
+      return contextBundleGate.then(() => {
+        contextBundleRead += 1;
+        return route.fulfill({ json: { ok: true, contextBundle: options.contextBundle ?? null,
+          memoryUsedCount: 0 } });
+      });
+    }
     const bundles = options.contextBundles;
     const contextBundle = bundles
       ? bundles[Math.min(contextBundleRead, bundles.length - 1)] ?? null
@@ -758,6 +814,10 @@ async function openChat(page: Page, options: {
   }
   return {
     conversations, writes, historyReads, userSettingsWrites, drafts,
+    contextBundleStarted: () => contextBundleStarted,
+    releaseContextBundle,
+    historyPageFailureStarted: () => historyPageFailureStarted,
+    releaseHistoryPageFailure,
     detail: (id: string) => payload(conversations.find((row) => row.id === id)!),
     hidePreviousAccount: () => {
       visibleConversations = accountBConversations;
@@ -1694,6 +1754,402 @@ test.describe("Chat unified workspace", { tag: "@ui-risk" }, () => {
     expect(await persistentProviderStreamCount(page)).toBe(1);
   });
 
+  test("a failed later history page stays unloaded until retry restores the complete send context", async ({ page }) => {
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `history-user-${index}`, role: "user", content: `Saved question ${index + 1}.` },
+      { id: `history-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Saved answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const state = await openChat(page, {
+      viewport: MOBILE_VIEWPORT,
+      messages: savedMessages,
+      historyPageFailureOnCursorRead: 1,
+    });
+
+    await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
+    await expect(message(page, "Saved question 1.")).toHaveCount(0);
+    await expect(message(page, "Saved answer 26.")).toHaveCount(0);
+    await submitComposer(page, "Use the whole saved conversation.", MOBILE_VIEWPORT.width);
+    await page.waitForTimeout(150);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(0);
+
+    await page.getByTestId("chat-history-load-retry").click();
+    await expect(message(page, "Saved answer 26.")).toBeVisible();
+    await expect(page.getByTestId("chat-history-load-error")).toHaveCount(0);
+    await expect(page.getByTestId("chat-textarea")).toHaveValue("Use the whole saved conversation.");
+    await submitComposer(page, "Use the whole saved conversation.", MOBILE_VIEWPORT.width);
+    await expect.poll(async () => (await requests(page)).length).toBe(1);
+    const outgoing = (await requests(page))[0].messages as Array<{ id?: string; content: unknown }>;
+    expect(outgoing.slice(0, savedMessages.length).map((item) => item.id))
+      .toEqual(savedMessages.map((item) => item.id));
+    expect(outgoing.at(-1)?.content).toBe("Use the whole saved conversation.");
+    expect(state.historyReads.some((read) => read.includes("cursor=history-answer-24"))).toBe(true);
+    await drive(page, 0, "push", "Answer with complete history.");
+    await drive(page, 0, "finish");
+  });
+
+  test("an in-flight history page does not announce a load failure before it fails", async ({ page }) => {
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `history-user-${index}`, role: "user", content: `Saved question ${index + 1}.` },
+      { id: `history-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Saved answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const state = await openChat(page, {
+      messages: savedMessages,
+      historyPageFailureOnCursorRead: 1,
+      holdHistoryPageFailure: true,
+    });
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+    await expect(page.getByTestId("chat-panel-loading")).toBeVisible();
+    await expect(page.getByTestId("chat-send-button")).toBeDisabled();
+    await submitComposer(page, "Wait until loading completes.", DESKTOP_VIEWPORT.width);
+    await page.waitForTimeout(150);
+    await expect(page.getByTestId("app-toast").filter({ hasText: "Your conversations are safe." }))
+      .toHaveCount(0);
+    expect(await persistentChatPostCount(page)).toBe(0);
+
+    state.releaseHistoryPageFailure();
+    await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
+    await submitComposer(page, "Wait until loading completes.", DESKTOP_VIEWPORT.width);
+    await expect(page.getByTestId("app-toast").filter({ hasText: "Your conversations are safe." }))
+      .toBeVisible();
+    expect(await persistentChatPostCount(page)).toBe(0);
+  });
+
+  test("a cached transcript cannot bypass a failed later-page refresh", async ({ page }) => {
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `history-user-${index}`, role: "user", content: `Saved question ${index + 1}.` },
+      { id: `history-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Saved answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const state = await openChat(page, {
+      viewport: DESKTOP_VIEWPORT,
+      messages: savedMessages,
+      historyPageFailureOnCursorRead: 2,
+    });
+    await expect(message(page, "Saved answer 26.")).toBeVisible();
+    await page.locator(`[data-testid="sidebar-conversation-item"][data-conversation-id="${SECOND_CONVERSATION}"]`).click();
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    await page.locator(`[data-testid="sidebar-conversation-item"][data-conversation-id="${CONVERSATION}"]`).click();
+
+    await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
+    await expect(message(page, "Saved question 1.")).toHaveCount(0);
+    await submitComposer(page, "Do not send partial cached history.", DESKTOP_VIEWPORT.width);
+    await page.waitForTimeout(150);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(0);
+
+    await page.getByTestId("chat-history-load-retry").click();
+    await expect(message(page, "Saved answer 26.")).toBeVisible();
+    await expect(page.getByTestId("chat-textarea")).toHaveValue("Do not send partial cached history.");
+    await submitComposer(page, "Do not send partial cached history.", DESKTOP_VIEWPORT.width);
+    await expect.poll(async () => (await requests(page)).length).toBe(1);
+    const outgoing = (await requests(page))[0].messages as Array<{ id?: string; content: unknown }>;
+    expect(outgoing.slice(0, savedMessages.length).map((item) => item.id))
+      .toEqual(savedMessages.map((item) => item.id));
+    expect(outgoing.at(-1)?.content).toBe("Do not send partial cached history.");
+    await drive(page, 0, "finish");
+  });
+
+  test("a global Chat send rechecks history after async preparation and viewport remount", async ({ page }) => {
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `history-user-${index}`, role: "user", content: `Saved question ${index + 1}.` },
+      { id: `history-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Saved answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const state = await openChat(page, {
+      messages: savedMessages,
+      historyPageFailureOnCursorRead: 2,
+      holdHistoryPageFailure: true,
+      holdContextBundleOnce: true,
+    });
+    await expect(message(page, "Saved answer 26.")).toBeVisible();
+    await submitComposer(page, "Wait for the refreshed full history.", DESKTOP_VIEWPORT.width);
+    await expect.poll(state.contextBundleStarted).toBe(true);
+    await page.setViewportSize(MOBILE_VIEWPORT);
+    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
+    await page.setViewportSize(DESKTOP_VIEWPORT);
+    await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+
+    state.releaseContextBundle();
+    await page.waitForTimeout(200);
+    await expect(page.getByTestId("app-toast").filter({ hasText: "Your conversations are safe." }))
+      .toHaveCount(0);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(0);
+    state.releaseHistoryPageFailure();
+    await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
+    await expect(page.getByTestId("chat-textarea")).toHaveValue("Wait for the refreshed full history.");
+
+    await page.getByTestId("chat-history-load-retry").click();
+    await expect(message(page, "Saved answer 26.")).toBeVisible();
+    await submitComposer(page, "Wait for the refreshed full history.", DESKTOP_VIEWPORT.width);
+    await expect.poll(async () => (await requests(page)).length).toBe(1);
+    const outgoing = (await requests(page))[0].messages as Array<{ id?: string; content?: unknown }>;
+    expect(outgoing.slice(0, savedMessages.length).map((item) => item.id))
+      .toEqual(savedMessages.map((item) => item.id));
+    await drive(page, 0, "finish");
+  });
+
+  test("a committed Chat Message survives a history refresh started during its POST", async ({ page }) => {
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `history-user-${index}`, role: "user", content: `Saved question ${index + 1}.` },
+      { id: `history-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Saved answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const state = await openChat(page, {
+      messages: savedMessages,
+      holdMessageSaveBeforeTransaction: true,
+      historyPageFailureOnCursorRead: 2,
+      holdHistoryPageFailure: true,
+    });
+    await expect(message(page, "Saved answer 26.")).toBeVisible();
+    await submitComposer(page, "Finish the accepted request after the remount.", DESKTOP_VIEWPORT.width);
+    await expect.poll(state.messageSaveStarted).toBe(true);
+    await page.setViewportSize(MOBILE_VIEWPORT);
+    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
+    await page.setViewportSize(DESKTOP_VIEWPORT);
+    await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+
+    state.releaseMessageSave();
+    await page.waitForTimeout(200);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    state.releaseHistoryPageFailure();
+    await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
+    await page.getByTestId("chat-history-load-retry").click();
+    await expect.poll(async () => (await requests(page)).length).toBe(1);
+    const outgoing = (await requests(page))[0].messages as Array<{ id?: string; content?: unknown }>;
+    expect(outgoing.slice(0, savedMessages.length).map((item) => item.id))
+      .toEqual(savedMessages.map((item) => item.id));
+    expect(outgoing.filter((item) => item.id === savedMessages.at(-1)?.id)).toHaveLength(1);
+    expect(outgoing.filter((item) => item.content === "Finish the accepted request after the remount."))
+      .toHaveLength(1);
+    await expect(message(page, "Finish the accepted request after the remount.")).toHaveCount(1);
+    await drive(page, 0, "finish");
+  });
+
+  test("a remounted panel learns that its inherited history request failed", async ({ page }) => {
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `history-user-${index}`, role: "user", content: `Saved question ${index + 1}.` },
+      { id: `history-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Saved answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const state = await openChat(page, {
+      messages: savedMessages,
+      historyPageFailureOnCursorRead: 2,
+      holdHistoryPageFailure: true,
+    });
+    await expect(message(page, "Saved answer 26.")).toBeVisible();
+    const item = (id: string) => page.locator(
+      `[data-testid="sidebar-conversation-item"][data-conversation-id="${id}"]`
+    );
+    await item(SECOND_CONVERSATION).click();
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    await item(CONVERSATION).click();
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+    await item(SECOND_CONVERSATION).click();
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    await item(CONVERSATION).click();
+    await expect(page.getByTestId("chat-panel-loading")).toBeVisible();
+    state.releaseHistoryPageFailure();
+
+    await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
+    await expect(message(page, "Saved question 1.")).toHaveCount(0);
+    await submitComposer(page, "Wait for inherited load recovery.", DESKTOP_VIEWPORT.width);
+    await page.waitForTimeout(150);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(0);
+    await page.getByTestId("chat-history-load-retry").click();
+    await expect(message(page, "Saved answer 26.")).toBeVisible();
+    await expect(page.getByTestId("chat-textarea")).toHaveValue("Wait for inherited load recovery.");
+    await submitComposer(page, "Wait for inherited load recovery.", DESKTOP_VIEWPORT.width);
+    await expect.poll(async () => (await requests(page)).length).toBe(1);
+    const outgoing = (await requests(page))[0].messages as Array<{ id?: string }>;
+    expect(outgoing.slice(0, savedMessages.length).map((item) => item.id))
+      .toEqual(savedMessages.map((item) => item.id));
+    await drive(page, 0, "finish");
+  });
+
+  test("a Review model-only follow-up waits for complete history and retains its draft through retry", async ({ page }) => {
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `review-user-${index}`, role: "user", content: `Review question ${index + 1}.` },
+      { id: `review-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Review answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const state = await openChat(page, {
+      legacyReview: true,
+      selectedModels: [MODEL_A, MODEL_B],
+      messages: savedMessages,
+      historyPageFailureOnCursorRead: 1,
+      holdHistoryPageFailure: true,
+    });
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+    const form = page.getByTestId("model-only-form").first();
+    const input = page.getByTestId("model-only-input").first();
+    const send = page.getByTestId("model-only-send").first();
+    await input.fill("Review with the full prior history.");
+    await expect(send).toBeDisabled();
+    await form.evaluate((element) => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
+    await page.waitForTimeout(150);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(0);
+
+    state.releaseHistoryPageFailure();
+    await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
+    await expect(input).toHaveValue("Review with the full prior history.");
+    await expect(send).toBeDisabled();
+    await form.evaluate((element) => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
+    await page.waitForTimeout(150);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(0);
+
+    await page.getByTestId("chat-history-load-retry").click();
+    await expect(message(page, "Review answer 26.")).toBeVisible();
+    await expect(input).toHaveValue("Review with the full prior history.");
+    await expect(send).toBeEnabled();
+    await send.click();
+    await expect.poll(async () => (await requests(page)).length).toBe(1);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(1);
+    await drive(page, 0, "finish");
+  });
+
+  test("a Review model-only turn stays visible when its saved Message races a remount load", async ({ page }) => {
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `review-user-${index}`, role: "user", content: `Review question ${index + 1}.` },
+      { id: `review-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Review answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const state = await openChat(page, {
+      legacyReview: true,
+      selectedModels: [MODEL_A, MODEL_B],
+      messages: savedMessages,
+      holdMessageSaveBeforeTransaction: true,
+      historyPageFailureOnCursorRead: 3,
+      holdHistoryPageFailure: true,
+    });
+    await expect(message(page, "Review answer 26.")).toBeVisible();
+    await page.getByTestId("model-only-input").first().fill("Show this accepted Review question while answering.");
+    await page.getByTestId("model-only-send").first().click();
+    await expect.poll(state.messageSaveStarted).toBe(true);
+    await page.setViewportSize(MOBILE_VIEWPORT);
+    await page.setViewportSize(DESKTOP_VIEWPORT);
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+
+    state.releaseMessageSave();
+    await expect.poll(async () => (await requests(page)).length).toBe(1);
+    await expect(message(page, "Show this accepted Review question while answering.")).toHaveCount(1);
+    await expect(page.getByTestId("chat-history-load-error")).toHaveCount(0);
+    state.releaseHistoryPageFailure();
+    await expect(message(page, "Show this accepted Review question while answering.")).toHaveCount(1);
+    const outgoing = (await requests(page))[0].messages as Array<{ id?: string; content?: unknown }>;
+    expect(outgoing.slice(0, savedMessages.length).map((item) => item.id))
+      .toEqual(savedMessages.map((item) => item.id));
+    expect(outgoing.filter((item) => item.content === "Show this accepted Review question while answering."))
+      .toHaveLength(1);
+    await drive(page, 0, "finish");
+  });
+
+  test("a Review question saved behind a newer turn is not mislabeled as unsaved", async ({ page }) => {
+    const state = await openChat(page, {
+      legacyReview: true,
+      selectedModels: [MODEL_A, MODEL_B],
+      holdFirstMessageSaveBeforeTransaction: true,
+    });
+    await expect(message(page, FIRST_ANSWER)).toBeVisible();
+    await page.getByTestId("model-only-input").first().fill("Earlier Review-only question.");
+    await page.getByTestId("model-only-send").first().click();
+    await expect.poll(state.messageSaveStarted).toBe(true);
+
+    await submitComposer(page, "Newer global Review question.", DESKTOP_VIEWPORT.width);
+    await expect.poll(async () => (await requests(page)).length).toBeGreaterThan(0);
+    await expect.poll(() => state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`).length).toBe(2);
+    state.releaseMessageSave();
+    await expect.poll(() => state.conversations[0]!.messages.some((item) =>
+      item.content === "Earlier Review-only question.")).toBe(true);
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: "Your question was saved, but no answer request was sent.",
+    })).toBeVisible();
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: "The conversation or model changed while preparing the answer.",
+    })).toHaveCount(0);
+    expect((await requests(page)).every((request) =>
+      request.messages?.every((item) =>
+        item.content !== "Earlier Review-only question.") ?? true)).toBe(true);
+    await drive(page, 0, "finish");
+    const dispatchedBeforeReload = await persistentChatPostCount(page);
+    await page.reload();
+    await expect(message(page, "Earlier Review-only question.")).toBeVisible();
+    expect(await persistentChatPostCount(page)).toBe(dispatchedBeforeReload);
+  });
+
+  for (const returnToA of [false, true]) {
+    test(`a saved Review question from an old identity raises no notice after ${returnToA ? "A-to-B-to-A" : "A-to-B"}`, async ({ page }) => {
+      const state = await openChat(page, {
+        legacyReview: true,
+        selectedModels: [MODEL_A, MODEL_B],
+        holdMessageSaveBeforeTransaction: true,
+      });
+      await page.evaluate(() => {
+        const tracker = window as unknown as { __qaSavedNoticeEvents: string[] };
+        tracker.__qaSavedNoticeEvents = [];
+        window.addEventListener("tomverse:toast", (event) => {
+          const message = (event as CustomEvent<{ message?: string }>).detail?.message;
+          if (message) tracker.__qaSavedNoticeEvents.push(message);
+        });
+      });
+      await page.getByTestId("model-only-input").first().fill("Account A saved question.");
+      await page.getByTestId("model-only-send").first().click();
+      await expect.poll(state.messageSaveStarted).toBe(true);
+
+      await switchToFixtureAccountB(page, state);
+      await expect(message(page, FIRST_ANSWER)).toHaveCount(0);
+      if (returnToA) {
+        await switchToFixtureAccountA(page, state);
+        await chooseConversation(page, CONVERSATION);
+        await expect(message(page, FIRST_ANSWER)).toBeVisible();
+      }
+      state.releaseMessageSave();
+      await expect.poll(() => state.conversations[0]!.messages.some((item) =>
+        item.content === "Account A saved question.")).toBe(true);
+      await page.waitForTimeout(200);
+      const notices = await page.evaluate(() =>
+        (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents);
+      expect(notices).not.toContain(
+        "Your question was saved, but no answer request was sent. Reload this conversation to check it before trying again."
+      );
+      expect(await persistentChatPostCount(page)).toBe(0);
+    });
+  }
+
+  test("a malformed first history page remains retryable without a send", async ({ page }) => {
+    const state = await openChat(page, { malformedFirstHistoryPageOnRead: 2 });
+    await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
+    await expect(message(page, FIRST_ANSWER)).toHaveCount(0);
+    await submitComposer(page, "Wait for valid first page.", DESKTOP_VIEWPORT.width);
+    await page.waitForTimeout(150);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(0);
+
+    await page.getByTestId("chat-history-load-retry").click();
+    await expect(message(page, FIRST_ANSWER)).toBeVisible();
+    await expect(page.getByTestId("chat-textarea")).toHaveValue("Wait for valid first page.");
+    await submitComposer(page, "Wait for valid first page.", DESKTOP_VIEWPORT.width);
+    await expect.poll(async () => (await requests(page)).length).toBe(1);
+    await drive(page, 0, "finish");
+  });
+
   test("reload adopts a durable partial and passively polls to terminal without resubmitting", async ({ page }) => {
     const state = await openChat(page);
     const active = {
diff --git a/tests/e2e/conversation-draft-isolation.spec.ts b/tests/e2e/conversation-draft-isolation.spec.ts
index d74acdce1..7721db528 100644
--- a/tests/e2e/conversation-draft-isolation.spec.ts
+++ b/tests/e2e/conversation-draft-isolation.spec.ts
@@ -110,6 +110,7 @@ async function mockConversationPair(
         ...row(id, title),
         messages: world.savedMessages[id] ?? [],
         nextCursor: null,
+        messagePage: { hasMore: false, nextCursor: null },
       })
     );
   };
diff --git a/tests/e2e/support/app-fixtures.ts b/tests/e2e/support/app-fixtures.ts
index 881bec227..f4aa71f11 100644
--- a/tests/e2e/support/app-fixtures.ts
+++ b/tests/e2e/support/app-fixtures.ts
@@ -1245,6 +1245,7 @@ export async function mockAuthenticatedApi(
         ...conversation(),
         messages: savedMessages as unknown as JsonValue,
         nextCursor: null,
+        messagePage: { hasMore: false, nextCursor: null },
       })
     );
   });
@@ -1313,6 +1314,7 @@ export async function mockAuthenticatedApi(
             ...extraBody(extra),
             messages: extra.savedMessages as unknown as JsonValue,
             nextCursor: null,
+            messagePage: { hasMore: false, nextCursor: null },
           })
         );
       }

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test --test-concurrency=1 tests/chatStreamRuntime.test.mjs && npm run test:e2e:run -- --project=desktop-chromium tests/e2e/chat-unified-workspace.spec.ts tests/e2e/chat-markdown-theme.spec.ts tests/e2e/chat-send-history-race.spec.ts tests/e2e/conversation-draft-isolation.spec.ts tests/e2e/model-change-send-barrier.spec.ts` (176225ms)
  ok 123 [desktop-chromium] › tests\e2e\chat-unified-workspace.spec.ts:3424:9 › Chat single-transcript mobile composer › 320px and 200% text preserve the textarea row and Korean composition @ui-risk (905ms)
    ok 124 [desktop-chromium] › tests\e2e\chat-unified-workspace.spec.ts:3424:9 › Chat single-transcript mobile composer › 390px and 200% text preserve the textarea row and Korean composition @ui-risk (938ms)
  
    1 skipped
    123 passed (2.9m)

## Guard results (run by the control program)

- PASS `git diff --check ad2b51622992c29056706c443d80bdba928336e1` (80ms)
- PASS `npm run typecheck` (82853ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npm exec eslint -- 'app/(site)/(application)/chat/ChatPageClient.tsx' components/chat/ChatApp.tsx lib/chatStreamRuntime.ts locales/de.ts locales/en.ts locales/es.ts locales/fr.ts locales/ko.ts locales/pt.ts locales/zh.ts tests/chatStreamRuntime.test.mjs tests/e2e/chat-markdown-theme.spec.ts tests/e2e/chat-send-history-race.spec.ts tests/e2e/chat-unified-workspace.spec.ts tests/e2e/conversation-draft-isolation.spec.ts tests/e2e/support/app-fixtures.ts` (39716ms)

## Findings from the previous round (check each was addressed)

- [error/evidence] tests/e2e/chat-send-history-race.spec.ts:38-61 against components/chat/ChatApp.tsx:822-825 and components/chat/ChatApp.tsx:2414: Round 0's fixture-parity finding was fixed only for the two specs it named: chat-send-history-race.spec.ts registers its own conversation-detail GET mock (after mockAuthenticatedApi, so Playwright LIFO makes it win) that returns `{id, title, selectedModels, disabledPanels, messages: [], nextCursor: null}` with no `messagePage`, so the new first-page validation throws, releaseChatRuntimeLoad marks the key failed, and — because the panel's auto-send effect now returns while `!runtime.isLoaded` — the first send of the newly created qa-conversation is never dispatched at all; the file is outside `writableScope`, so the change as scoped leaves the suite red.
- [warning/judgement] components/chat/ChatApp.tsx:2540-2546 (restoreChatRuntimeCompleteViewForSend false branch) with lib/chatStreamRuntime.ts:335-345: The new `chat.savedQuestionNotSent` toast is not gated on the identity still being current, so when the model-only Message POST is outstanding across an account switch the record is deleted by releaseChatRuntimeForOtherIdentities (ChatPageClient.tsx:1953), the generation lookup fails, and the previous identity's failure is announced on the new identity's screen — contrary to criterion 3, and inconsistent with the adjacent `sendPreparationChanged` toast, which is shown only when `identityKey === currentIdentityKey` (ChatPageClient.tsx:4752-4754).
- [warning/evidence] verification record: docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/authorization.md "Round 0 수정본의 로컬 검증" vs criterion 6: Criterion 6's loading-golden and desktop+mobile browser regression evidence is still absent for this revision: the control program ran only --project=desktop-chromium over four spec files, and the author's own record states the chat-state-visual-regression Loading-state run produced 4 failures from missing `-win32.png` goldens (never a pixel comparison) plus a grep-narrowed mobile subset, so no golden comparison for the placeholder this diff edits has actually been made.

## Author's account (read last; a claim, not a finding)

Summary: (no summary supplied; the diff is the record)

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "chat-history-pagination-recovery-v1",
  "round": 2,
  "reviewedDigest": "sha256:63f99fbb5f577bb684e79b719a635b09f2594ce5d6f70bbef51efaf0874c2018",
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
