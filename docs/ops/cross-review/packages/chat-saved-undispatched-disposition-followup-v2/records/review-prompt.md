# Independent review — task chat-saved-undispatched-disposition-followup-v2, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

종료된 chat-history-pagination-recovery-v1 exchange의 round 2 승인 verdict에 남은 대화 범위 notice 지적 두 건만 보완한다. Chat 전역 전송의 user Message가 durable 저장된 뒤 불완전한 history 때문에 provider dispatch 전 대화를 떠난 경우 prompt/admission/context를 보관하거나 자동 재전송하지 않고, 원래 identity와 conversation으로 돌아왔을 때만 saved-but-undispatched 안내를 표시한다. Review model-only 저장이 최신 run에 밀린 경우에도 같은 identity의 다른 conversation에는 안내를 노출하지 않고 원래 conversation에서만 표시한다. 기존 v1 exchange는 변경하지 않는다. 실제 provider 호출, 유료 실행, staging/production, flag 변경, push·merge·deploy는 범위 밖이다. author는 Codex, 독립 reviewer는 Cursor CLI다.

## Completion criteria

- Chat 전역 prompt payload가 history failure 뒤 다른 conversation 선택으로 소멸하거나 durable Message commit 응답이 conversation/ticket 변경 뒤 늦게 도착해도, 답변 요청이 시작되지 않았다는 disposition을 identity와 originating conversation에만 결속한다. 다른 conversation에서는 toast를 표시하지 않고 원래 conversation 재선택 때 한 번 표시한다. same-conversation cleanup도 opaque disposition을 저장하되 exact durable payload가 mount된 responsive remount 동안만 소비를 보류하고, full unmount 또는 active-row 재선택으로 payload가 사라지면 한 번 소비한다. 최초 URL conversation handoff가 도달 성공, lock 취소, missing/unowned target 또는 fallback 선택으로 terminal된 뒤에는 frozen initial id가 이후 conversation의 disposition 소비를 막지 않으며 실제 in-flight handoff 동안만 transient conversation의 소비를 막는다. 새 conversation의 commit 응답은 기존 pending-adoption current 판정이 유지된다.
- disposition에는 prompt text, attachment, admission token, context bundle 또는 provider 재실행 권한을 보관하지 않는다. conversation 전환 뒤 blind resend나 자동 provider POST를 만들지 않고 기존 savedQuestionNotSent의 reload 확인 문구를 사용한다.
- Review model-only Message 저장이 최신 local run에 밀린 뒤 사용자가 같은 identity의 다른 conversation에 있어도 toast를 그 화면에 표시하지 않는다. Review 전역 composer의 durable commit도 모든 surface에서 캡처한 conversation과 committed selection ticket을 확인하므로 same-identity A→B→A 뒤 provider payload를 발행하지 않고 origin notice를 한 번 표시한다. 원래 conversation으로 돌아왔을 때만 한 번 표시하고, identity epoch가 바뀐 A→B 및 A→B→A의 늦은 durable callback은 같은 account key로 돌아왔더라도 notice 없이 폐기한다. callback authority는 active identity, namespace, submit-fence identity key 및 epoch를 모두 요구해 unresolved/loading 경계도 old identity를 승인하지 않는다. ChatPage가 완전히 unmount된 동안 identity가 바뀐 경우에도 sessionStorage owner marker가 mismatch disposition을 폐기하며 같은 identity remount만 복구한다. browser identity epoch는 layout commit에서만 채택하고 SSR에서는 module fence를 읽거나 쓰지 않는다.
- desktop/mobile Chromium focused E2E가 유형별 계약을 검증한다. Chat/Review abandonment와 late global commit은 다른 conversation notice 0건, origin notice 1건, saved question provider POST 0건과 테스트가 확인하는 durable Message 1건을 검증한다. 같은 Chat의 full unmount와 active-row 재선택은 origin notice 1건·provider POST 0건을 검증하며, continuation New Chat은 loopback-only onBeforeModelSend barrier로 durable commit 이후 provider 전 경계를 고정해 재진입 notice 1건·provider POST 0건·durable Message 1건을 검증한다. Review와 continuation의 다중 panel은 첫 panel의 실제 provider POST 뒤 둘째 panel cleanup 순서를 고정해 provider POST 1건, savedQuestionNotSent notice 0건, persisted disposition 0건을 검증한다. lock 취소는 notice 0건, current conversation 불변 및 cleanup/remount 뒤 false notice 0건을 검증하고, locked initial URL 취소와 missing/unowned initial URL 뒤에는 다른 origin의 notice가 정상 소비됨을 검증한다. same-identity rapid conversation A→B→A는 origin notice 1건과 provider POST 0건을, identity A→B/A→B→A는 old identity notice 0건과 old prompt provider POST 0건을 검증한다. full-unmount A disposition→B mount→A mount는 old A notice와 provider POST 0건을 검증한다. async fixture는 고정 sleep 대신 response-settled 상태를 기다린다. bounded storage/identity unit, typecheck, 변경 범위 lint, production build 및 diff guard 결과를 정직하게 기록한다.
- 기존 chat-history-pagination-recovery-v1 exchange와 records는 on_hold(revisions_exhausted) 상태로 바이트 불변 보존하고 이 successor의 supersedes lineage가 그 exchange를 가리킨다.
- 새 package digest는 audit-only base bef622a565468fb9857639bc4ef24171c2c57a5f 이후 지정된 아홉 제품·테스트 파일과 이 task/authorization만 검토 변경으로 포함한다. 제품 source lineage는 그 base의 parent 93b18c8f37be46cbfce47658cc638e77aa008d63이며, audit-only base commit은 v1 authorization과 records만 추가한다. 이 successor의 생성 records 디렉터리만 동일한 exact out/diff-exclude로 제외하고 Cursor CLI verdict는 그 digest에 결속한다.

## Change under review — digest sha256:5ad307d081c9c6746f18e526c2aefb8e61b1012009143df52baef066d7ae8980

```diff
diff --git a/app/(site)/(application)/chat/ChatPageClient.tsx b/app/(site)/(application)/chat/ChatPageClient.tsx
index 0fbe1e2a1..bb8820c62 100644
--- a/app/(site)/(application)/chat/ChatPageClient.tsx
+++ b/app/(site)/(application)/chat/ChatPageClient.tsx
@@ -247,6 +247,21 @@ import {
   NO_WEB_SEARCH_BACKENDS,
   type WebSearchBackendReadiness,
 } from "@/lib/webSearchBackends";
+import {
+  SAVED_QUESTION_NOT_SENT_CHANGE_EVENT,
+  addSavedQuestionNotSentKey,
+  addSavedQuestionNotSentKeys,
+  bindSavedQuestionNotSentOwner,
+  clearSavedQuestionNotSentKeys,
+  consumeSavedQuestionNotSentPrefix,
+  removeSavedQuestionNotSentKey,
+  setBoundedMapEntry,
+} from "@/lib/chatSavedQuestionDisposition";
+import {
+  activeChatIdentityIs,
+  adoptActiveChatIdentity,
+  chatIdentityCallbackIsCurrent,
+} from "@/lib/chatIdentityEpoch";
 
 // Persists which conversation is open in *this tab* so an F5 / crash
 // recovery restores it instead of falling back to the welcome screen --
@@ -256,7 +271,16 @@ import {
 // Defined in lib/guestChatInitialModels so the first-render guest model
 // decision reads the same key this file writes.
 const ACTIVE_CHAT_STORAGE_KEY = GUEST_ACTIVE_CHAT_STORAGE_KEY;
-
+let conversationSelectionTicketSequence = 0;
+const allocateConversationSelectionTicket = (): number => {
+  conversationSelectionTicketSequence += 1;
+  return conversationSelectionTicketSequence;
+};
+let conversationNavigationAttemptSequence = 0;
+const allocateConversationNavigationAttempt = (): number => {
+  conversationNavigationAttemptSequence += 1;
+  return conversationNavigationAttemptSequence;
+};
 /**
  * Where the draft and message-receipt recovery notices float: under the
  * header, never at the bottom of the screen.
@@ -783,8 +807,47 @@ export function ChatPageClient({
    * re-open the URL's conversation on top of whatever the user had since
    * chosen.
    */
-  const initialConversationAppliedRef = useRef(false);
+  // App Router can preserve this client tree while changing between routed
+  // surfaces. Track the particular URL-named conversation that was applied,
+  // rather than a once-per-component boolean: A -> B -> A must honour the
+  // second A handoff even when the same component instance survives.
+  const initialConversationAppliedRef = useRef<string | null>(null);
   const [currentChatId, setCurrentChatId] = useState<string | null>(null);
+  // A server-provided conversation id is a handoff, not a permanent allow
+  // list for which conversation may consume a saved-undispatched notice.
+  // App Router can retain this client tree after the handoff query is removed,
+  // leaving the prop frozen at A while the user later works in B. Suppress a
+  // notice only until this tree has actually reached the requested id; after
+  // that, every committed selection owns its own conversation-scoped notice.
+  const initialConversationHandoffRef = useRef<{
+    requestedId: string | null;
+    settled: boolean;
+  }>({
+    requestedId: initialConversationId ?? null,
+    settled: !initialConversationId,
+  });
+  const [initialConversationHandoffRevision, setInitialConversationHandoffRevision] =
+    useState(0);
+  const settleInitialConversationHandoff = useCallback((requestedId?: string | null) => {
+    const handoff = initialConversationHandoffRef.current;
+    if (handoff.settled ||
+        (requestedId !== undefined && handoff.requestedId !== requestedId)) return false;
+    handoff.settled = true;
+    setInitialConversationHandoffRevision((value) => value + 1);
+    return true;
+  }, []);
+  useLayoutEffect(() => {
+    const requestedId = initialConversationId ?? null;
+    if (initialConversationHandoffRef.current.requestedId !== requestedId) {
+      initialConversationHandoffRef.current = {
+        requestedId,
+        settled: requestedId === null,
+      };
+    }
+    if (requestedId === null || currentChatId === requestedId) {
+      settleInitialConversationHandoff(requestedId);
+    }
+  }, [currentChatId, initialConversationId, settleInitialConversationHandoff]);
   const [conversations, setConversations] = useState<Conversation[]>([]);
   // True while a "new image" draft is open: the workspace renders with no
   // server row, which is only created by the first successful generation
@@ -1147,14 +1210,27 @@ export function ChatPageClient({
   const [pendingSubmissionOwners, setPendingSubmissionOwners] = useState(
     () => new Map<string, PendingSubmissionOwner>()
   );
-  const submitIdentityFenceRef = useRef({ identityKey, epoch: 0 });
+  // Browser-realm monotonic allocation also fences a preserved async closure
+  // when App Router replaces the page tree during A→B→A. A component-local
+  // counter would restart at zero and make the returning A indistinguishable
+  // from the old A epoch that owns the late Message response.
+  // The browser-realm fence is adopted in the layout effect below. Rendering
+  // (including SSR) never reads or mutates module-global identity state.
+  const [identityEpoch, setIdentityEpoch] = useState(0);
+  const submitIdentityFenceRef = useRef({ identityKey, epoch: identityEpoch });
   useLayoutEffect(() => {
-    const current = submitIdentityFenceRef.current;
-    if (current.identityKey === identityKey) return;
-    submitIdentityFenceRef.current = {
+    const adopted = adoptActiveChatIdentity(identityKey);
+    const nextFence = {
       identityKey,
-      epoch: current.epoch + 1,
+      epoch: adopted.epoch,
     };
+    const current = submitIdentityFenceRef.current;
+    if (current.identityKey === nextFence.identityKey &&
+        current.epoch === nextFence.epoch) return;
+    submitIdentityFenceRef.current = nextFence;
+    // Publish the ref-owned fence to panels. The ref is the async authority;
+    // state only ensures the committed child tree captures the new epoch.
+    setIdentityEpoch(nextFence.epoch);
   }, [identityKey]);
   const pendingSubmissionOwnerKey = identityKey ?? "unresolved";
   const pendingSubmission =
@@ -1164,6 +1240,12 @@ export function ChatPageClient({
     text: string;
     chatId: string;
     userMessageId: string;
+    /** True only after an account Message receipt/mapping was accepted. */
+    messageWasDurablySaved: boolean;
+    /** Conversation-selection epoch at acceptance; independent of identity. */
+    conversationSelectionTicket: number;
+    /** Identity/session epoch that originally owned this accepted send. */
+    identityEpoch: number;
     /**
      * The models this send was actually made for -- the set the preflight
      * priced, reserved admission slots for, and the send barrier confirmed
@@ -1189,6 +1271,14 @@ export function ChatPageClient({
     contextBundle?: string | null;
     contextLayout?: "single" | "comparison";
   } | null>(null);
+  const providerDispatchedPromptIdsRef = useRef<Set<string>>(new Set());
+  const pendingDurableUndispatchedTurnsRef = useRef(new Map<string, {
+    identityKey: string;
+    identityEpoch: number;
+    conversationId: string;
+    turnId: string;
+    selectionTicket: number;
+  }>());
   const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
   const [pendingRemoveModelId, setPendingRemoveModelId] = useState<string | null>(null);
   const [pendingRevokeShareId, setPendingRevokeShareId] = useState<string | null>(null);
@@ -1828,6 +1918,7 @@ export function ChatPageClient({
   // Only the newest selection intent may apply an asynchronous surface read.
   // A new blank/image intent also invalidates reads when the id stays null.
   const conversationSelectionTicketRef = useRef(0);
+  const conversationNavigationAttemptRef = useRef(0);
   const pendingCreatedChatRef = useRef<{
     id: string;
     title: string;
@@ -1847,10 +1938,10 @@ export function ChatPageClient({
   );
 
   useLayoutEffect(() => {
-    conversationSelectionTicketRef.current += 1;
+    conversationNavigationAttemptRef.current = allocateConversationNavigationAttempt();
     pendingCreatedChatRef.current = null;
     return () => {
-      conversationSelectionTicketRef.current += 1;
+      conversationNavigationAttemptRef.current = allocateConversationNavigationAttempt();
       pendingCreatedChatRef.current = null;
     };
   }, [identityKey]);
@@ -1880,6 +1971,13 @@ export function ChatPageClient({
   const showToastRef = useRef<
     ((message: string, tone: AppToast["tone"]) => void) | null
   >(null);
+  // A durable Message can lose dispatch authority after it is saved. Keep
+  // only the opaque (identity, conversation, turn id) disposition here -- never the
+  // prompt, admission token or context bundle -- so returning to that exact
+  // conversation can explain what happened without replaying a provider
+  // request. This state is tab-local and cleared at every identity boundary.
+  const savedQuestionNotSentKeysRef = useRef<Set<string>>(new Set());
+  const [savedQuestionNotSentRevision, setSavedQuestionNotSentRevision] = useState(0);
 
   const belongsToCurrentIdentity = useCallback(
     (id: string | null | undefined) =>
@@ -1929,6 +2027,11 @@ export function ChatPageClient({
     );
     identityNamespaceRef.current = identityNamespace;
     appliedIdentityKeyRef.current = nextKey;
+    bindSavedQuestionNotSentOwner(
+      savedQuestionNotSentKeysRef.current,
+      typeof window === "undefined" ? null : window.sessionStorage,
+      nextKey
+    );
     // First resolution of a freshly mounted tab: there is no previous identity
     // to have carried anything over from, and the restore effect below still
     // validates the saved id against this account's own conversation list.
@@ -1943,6 +2046,11 @@ export function ChatPageClient({
     modelSettingsSyncQueueRef.current =
       createConversationModelSettingsSyncQueue();
     staleConversationIdsRef.current.clear();
+    clearSavedQuestionNotSentKeys(
+      savedQuestionNotSentKeysRef.current,
+      typeof window === "undefined" ? null : window.sessionStorage
+    );
+    pendingDurableUndispatchedTurnsRef.current.clear();
     // Panel transcripts and their in-flight runs are held per (identity,
     // conversation, model) so they survive a conversation switch
     // (lib/chatStreamRuntime.ts). Surviving an *identity* change is a
@@ -1966,6 +2074,7 @@ export function ChatPageClient({
 
     const retainedId = selectionAfterIdentityTransition(carriedId, transition);
     if (retainedId !== carriedId) {
+      conversationSelectionTicketRef.current = allocateConversationSelectionTicket();
       currentChatIdRef.current = retainedId;
       setCurrentChatId(retainedId);
       setPromptPayload(null);
@@ -2015,6 +2124,7 @@ export function ChatPageClient({
         previous.filter((conversation) => conversation.id !== conversationId)
       );
       if (currentChatIdRef.current === conversationId) {
+        conversationSelectionTicketRef.current = allocateConversationSelectionTicket();
         currentChatIdRef.current = null;
         setCurrentChatId(null);
         // A new chat starts with no assistant. Carrying the last one over
@@ -2246,6 +2356,252 @@ export function ChatPageClient({
     showToastRef.current = showToast;
   }, [showToast]);
 
+  const signalSavedQuestionNotSentChange = useCallback(() => {
+    if (typeof window === "undefined") return;
+    window.dispatchEvent(new Event(SAVED_QUESTION_NOT_SENT_CHANGE_EVENT));
+  }, []);
+
+  const persistSavedQuestionNotSent = useCallback((dispositionKey: string) => {
+    const ownerIdentityKey = dispositionKey.split("\0", 1)[0] ?? "";
+    bindSavedQuestionNotSentOwner(
+      savedQuestionNotSentKeysRef.current,
+      typeof window === "undefined" ? null : window.sessionStorage,
+      ownerIdentityKey
+    );
+    addSavedQuestionNotSentKey(
+      savedQuestionNotSentKeysRef.current,
+      typeof window === "undefined" ? null : window.sessionStorage,
+      dispositionKey
+    );
+    // `storage` is not emitted to the same window. This prompt-free event lets
+    // a newer App Router tree consume a receipt written by an older closure.
+    signalSavedQuestionNotSentChange();
+  }, [signalSavedQuestionNotSentChange]);
+
+  const promoteCurrentUndispatchedTurns = useCallback((
+    selectionIdentityKey: string
+  ) => {
+    const originConversationId = currentChatIdRef.current;
+    if (!originConversationId) return;
+    const dispositions: string[] = [];
+    for (const [promptId, pending] of pendingDurableUndispatchedTurnsRef.current) {
+      if (pending.identityKey !== selectionIdentityKey ||
+          pending.identityEpoch !== submitIdentityFenceRef.current.epoch ||
+          pending.conversationId !== originConversationId ||
+          providerDispatchedPromptIdsRef.current.has(promptId)) continue;
+      dispositions.push(
+        `${pending.identityKey}\0${pending.conversationId}\0${pending.turnId}`
+      );
+      pendingDurableUndispatchedTurnsRef.current.delete(promptId);
+    }
+    if (dispositions.length === 0) return;
+    bindSavedQuestionNotSentOwner(
+      savedQuestionNotSentKeysRef.current,
+      typeof window === "undefined" ? null : window.sessionStorage,
+      selectionIdentityKey
+    );
+    addSavedQuestionNotSentKeys(
+      savedQuestionNotSentKeysRef.current,
+      typeof window === "undefined" ? null : window.sessionStorage,
+      dispositions
+    );
+    signalSavedQuestionNotSentChange();
+  }, [signalSavedQuestionNotSentChange]);
+
+  const handleSavedQuestionNotSent = useCallback((
+    originIdentityKey: string,
+    originIdentityEpoch: number,
+    conversationId: string,
+    turnId: string,
+    originSelectionTicket: number,
+    reason: "terminal" | "conversation-left"
+  ) => {
+    const currentIdentityKey = identityNamespaceKey(identityNamespaceRef.current);
+    if (!chatIdentityCallbackIsCurrent({
+      originIdentityKey,
+      originIdentityEpoch,
+      currentNamespaceKey: currentIdentityKey,
+      submitFence: submitIdentityFenceRef.current,
+    })) return;
+
+    const dispositionKey = `${originIdentityKey}\0${conversationId}\0${turnId}`;
+    pendingDurableUndispatchedTurnsRef.current.delete(turnId);
+    if (providerDispatchedPromptIdsRef.current.has(turnId)) {
+      // Provider-start is monotonic across sibling panels. One panel can cross
+      // the provider boundary while another is still waiting on preparation;
+      // that sibling's later cleanup must not recreate an "undispatched"
+      // receipt for the exact turn the provider has already received.
+      removeSavedQuestionNotSentKey(
+        savedQuestionNotSentKeysRef.current,
+        typeof window === "undefined" ? null : window.sessionStorage,
+        dispositionKey
+      );
+      return;
+    }
+    if (currentChatIdRef.current === conversationId) {
+      if (reason === "conversation-left") {
+        // Conversation cleanup can be a responsive shell remount, a full page
+        // unmount, or an explicit re-click/new-chat departure. Persist first;
+        // the consumer below protects the exact still-mounted payload during
+        // a responsive remount and consumes it once that payload is gone.
+        persistSavedQuestionNotSent(dispositionKey);
+        return;
+      }
+      removeSavedQuestionNotSentKey(
+        savedQuestionNotSentKeysRef.current,
+        typeof window === "undefined" ? null : window.sessionStorage,
+        dispositionKey
+      );
+      // A responsive-shell remount also cleans up an incomplete panel. It is
+      // not abandonment while the originating conversation and selection
+      // epoch are still current. Identity handoff is fenced separately by the
+      // monotonic identity epoch above; this ticket only describes a committed
+      // conversation transition within that identity epoch.
+      if (reason === "terminal" ||
+          conversationSelectionTicketRef.current !== originSelectionTicket) {
+        showToast(t("chat.savedQuestionNotSent"), "info");
+      }
+      return;
+    }
+
+    persistSavedQuestionNotSent(dispositionKey);
+  }, [persistSavedQuestionNotSent, showToast, t]);
+
+  const handleDurableUndispatchedAccepted = useCallback((
+    originIdentityKey: string,
+    originIdentityEpoch: number,
+    conversationId: string,
+    turnId: string,
+    originSelectionTicket: number
+  ): boolean => {
+    if (!chatIdentityCallbackIsCurrent({
+      originIdentityKey,
+      originIdentityEpoch,
+      currentNamespaceKey: identityNamespaceKey(identityNamespaceRef.current),
+      submitFence: submitIdentityFenceRef.current,
+    })) return false;
+    // Cross-surface navigation unmounts this workspace before a held Message
+    // save can settle.  In that case there will be no later selection cleanup
+    // in this component tree to promote the accepted receipt into a
+    // conversation-scoped disposition.  The accepted receipt is already the
+    // exact durable boundary, and leaving the origin invalidates this panel's
+    // dispatch authority, so persist the opaque key immediately.  The prompt,
+    // admission token and context never cross the surface boundary.
+    if (currentChatIdRef.current !== conversationId ||
+        conversationSelectionTicketRef.current !== originSelectionTicket) {
+      const dispositionKey = `${originIdentityKey}\0${conversationId}\0${turnId}`;
+      persistSavedQuestionNotSent(dispositionKey);
+      return false;
+    }
+    setBoundedMapEntry(pendingDurableUndispatchedTurnsRef.current, turnId, {
+      identityKey: originIdentityKey,
+      identityEpoch: originIdentityEpoch,
+      conversationId,
+      turnId,
+      selectionTicket: originSelectionTicket,
+    });
+    return true;
+  }, [persistSavedQuestionNotSent]);
+
+  const handleProviderDispatchStarted = useCallback((
+    originIdentityKey: string,
+    originIdentityEpoch: number,
+    conversationId: string,
+    promptId: string
+  ) => {
+    if (!chatIdentityCallbackIsCurrent({
+      originIdentityKey,
+      originIdentityEpoch,
+      currentNamespaceKey: identityNamespaceKey(identityNamespaceRef.current),
+      submitFence: submitIdentityFenceRef.current,
+    })) return;
+    providerDispatchedPromptIdsRef.current.add(promptId);
+    pendingDurableUndispatchedTurnsRef.current.delete(promptId);
+    // A held model-only receipt can settle after a surface switch and record
+    // its opaque disposition before the continuation reaches the exact
+    // provider-fetch boundary. If that boundary is reached, it is not an
+    // undispatched turn: retract both the in-memory and tab-persistent key.
+    // Turn ids are server-issued/UUID opaque ids, so no prompt or execution
+    // authority is needed to cancel the notice.
+    removeSavedQuestionNotSentKey(
+      savedQuestionNotSentKeysRef.current,
+      typeof window === "undefined" ? null : window.sessionStorage,
+      `${originIdentityKey}\0${conversationId}\0${promptId}`
+    );
+    if (providerDispatchedPromptIdsRef.current.size > 64) {
+      const oldest = providerDispatchedPromptIdsRef.current.values().next().value;
+      if (typeof oldest === "string") {
+        providerDispatchedPromptIdsRef.current.delete(oldest);
+      }
+    }
+  }, []);
+
+  const consumeSavedQuestionNotSent = useCallback((
+    targetIdentityKey: string,
+    conversationId: string,
+    preserveKey: string | null = null
+  ) => {
+    const found = consumeSavedQuestionNotSentPrefix(
+      savedQuestionNotSentKeysRef.current,
+      typeof window === "undefined" ? null : window.sessionStorage,
+      targetIdentityKey,
+      conversationId,
+      preserveKey
+    );
+    if (!found) return false;
+    // Consumption runs during surface arrival. Dispatch through the shared
+    // event after the queued effect boundary so the newly mounted workspace's
+    // toast listener owns the notice; setting this mount's local state directly
+    // can be discarded by the App Router handoff that is still settling.
+    dispatchAppToast(t("chat.savedQuestionNotSent"), "info");
+    return true;
+  }, [t]);
+
+  useEffect(() => {
+    const handleChange = () => {
+      setSavedQuestionNotSentRevision((value) => value + 1);
+    };
+    window.addEventListener(SAVED_QUESTION_NOT_SENT_CHANGE_EVENT, handleChange);
+    return () => {
+      window.removeEventListener(SAVED_QUESTION_NOT_SENT_CHANGE_EVENT, handleChange);
+    };
+  }, []);
+
+  useEffect(() => {
+    if (!isInitialConversationResolved || !identityKey || !currentChatId) return;
+    // A committed navigation updates the ref synchronously before React can
+    // commit the next conversation state. A same-window disposition event in
+    // that gap belongs to the destination tree, not the stale origin render.
+    if (currentChatIdRef.current !== currentChatId) return;
+    // A routed surface can mount with the tab's previously active id before
+    // it applies the conversation named by the URL. Do not consume an origin
+    // notice against that transient id: it would render on the wrong surface
+    // and disappear when the route selection finishes.
+    const handoff = initialConversationHandoffRef.current;
+    if (handoff.requestedId === initialConversationId && !handoff.settled) return;
+    const protectedDispositionKey = promptPayload?.messageWasDurablySaved &&
+      promptPayload.chatId === currentChatId &&
+      promptPayload.identityEpoch === submitIdentityFenceRef.current.epoch &&
+      !providerDispatchedPromptIdsRef.current.has(promptPayload.id)
+        ? `${identityKey}\0${currentChatId}\0${promptPayload.id}`
+        : null;
+    let cancelled = false;
+    queueMicrotask(() => {
+      if (!cancelled) {
+        consumeSavedQuestionNotSent(
+          identityKey,
+          currentChatId,
+          protectedDispositionKey
+        );
+      }
+    });
+    return () => {
+      cancelled = true;
+    };
+  }, [consumeSavedQuestionNotSent, currentChatId, identityKey, initialConversationId,
+    initialConversationHandoffRevision, isInitialConversationResolved,
+    promptPayload, savedQuestionNotSentRevision]);
+
   const restoreChatPrompt = useCallback((prompt: {
     text: string;
     attachments: ChatAttachment[];
@@ -3212,7 +3568,13 @@ export function ChatPageClient({
 
     const handleNewChat = () => {
         resetPromptRefinerFixture();
-        conversationSelectionTicketRef.current += 1;
+        if (mountedSurface === "continuation" && identityKey) {
+            // This route transition unmounts the continuation tree. Promote
+            // accepted turns before changing the selection ticket so their
+            // prompt-free receipt survives into the next mount.
+            promoteCurrentUndispatchedTurns(identityKey);
+        }
+        conversationSelectionTicketRef.current = allocateConversationSelectionTicket();
         pendingCreatedChatRef.current = null;
         /*
           A new chat on a continuation's URL has to leave that URL.
@@ -3316,7 +3678,7 @@ export function ChatPageClient({
             return;
         }
         resetPromptRefinerFixture();
-        conversationSelectionTicketRef.current += 1;
+        conversationSelectionTicketRef.current = allocateConversationSelectionTicket();
         setChatDraftBeforeImage({
             scopeId: currentChatIdRef.current,
             /*
@@ -3373,7 +3735,7 @@ export function ChatPageClient({
     // Leaving the image draft without generating: the chat draft comes back
     // exactly as it was, in the conversation it belonged to.
     const handleCancelImageDraft = () => {
-        conversationSelectionTicketRef.current += 1;
+        conversationSelectionTicketRef.current = allocateConversationSelectionTicket();
         const restore = chatDraftBeforeImage;
         setIsImageDraftActive(false);
         setImageDraftSeedPrompt("");
@@ -3389,7 +3751,7 @@ export function ChatPageClient({
 
     const handleNewImage = () => {
         resetPromptRefinerFixture();
-        conversationSelectionTicketRef.current += 1;
+        conversationSelectionTicketRef.current = allocateConversationSelectionTicket();
         localComparisonResponsesRef.current.clear();
         latestLocalComparisonPromptRef.current = null;
         setIsImageDraftActive(true);
@@ -3457,7 +3819,17 @@ export function ChatPageClient({
         skipLockCheck = false,
         surfaceHint?: ConversationSurface
     ) => {
-        const selectionTicket = ++conversationSelectionTicketRef.current;
+        const outstandingHandoff = initialConversationHandoffRef.current;
+        if (!outstandingHandoff.settled &&
+            outstandingHandoff.requestedId !== id) {
+            // An explicit selection of another conversation replaces the URL
+            // handoff. From this point the frozen server prop is historical,
+            // not a reason to suppress this selection's future notices.
+            settleInitialConversationHandoff();
+        }
+        const navigationAttempt = allocateConversationNavigationAttempt();
+        conversationNavigationAttemptRef.current = navigationAttempt;
+        const selectionIdentityKey = identityNamespaceKey(identityNamespaceRef.current);
         /*
           A continuation opens at its own URL
           (docs/policy/external-conversation-continuation.md §8.2).
@@ -3478,10 +3850,13 @@ export function ChatPageClient({
             // A URL/list miss is not product authority. Resolve the owned row
             // before mounting a Chat transcript for an unclassified id.
             const accountId = accountConversationId(id);
-            if (!accountId) return;
+            if (!accountId) {
+                settleInitialConversationHandoff(id);
+                return;
+            }
             const originConversationId = currentChatIdRef.current;
             const lookupIsCurrent = () => Boolean(identityKey) &&
-                selectionTicket === conversationSelectionTicketRef.current &&
+                navigationAttempt === conversationNavigationAttemptRef.current &&
                 identityKey === identityNamespaceKey(identityNamespaceRef.current) &&
                 originConversationId === currentChatIdRef.current;
             if (!lookupIsCurrent()) return;
@@ -3493,18 +3868,54 @@ export function ChatPageClient({
                 }
                 if (!response.ok) {
                     await discardResponseBody(response);
-                    if (lookupIsCurrent()) showToast(t("chat.conversationOpenFailed"), "info");
+                    if (lookupIsCurrent()) {
+                        settleInitialConversationHandoff(id);
+                        showToast(t("chat.conversationOpenFailed"), "info");
+                    }
                     return;
                 }
                 const detail = await response.json();
                 if (!lookupIsCurrent()) return;
-                if (!["chat", "workspace", "continuation"].includes(detail.surface)) return;
+                if (!["chat", "workspace", "continuation"].includes(detail.surface)) {
+                    settleInitialConversationHandoff(id);
+                    return;
+                }
                 targetSurface = detail.surface;
             } catch {
-                if (lookupIsCurrent()) showToast(t("chat.conversationOpenFailed"), "info");
+                if (lookupIsCurrent()) {
+                    settleInitialConversationHandoff(id);
+                    showToast(t("chat.conversationOpenFailed"), "info");
+                }
+                return;
+            }
+        }
+
+        // A refused click is not a departure. In particular, opening the lock
+        // prompt must not turn the current conversation's pending receipt into
+        // a saved-but-undispatched disposition. Promote only after all lookup
+        // and lock checks have accepted the target, immediately before the
+        // actual route or selection transition below.
+        if (!isGuestMode && !skipLockCheck) {
+            const targetConv = conversations.find((c) => c.id === id);
+            if (targetConv?.isLocked) {
+                setLockedSelectDialog({ id, password: "", error: "" });
                 return;
             }
         }
+        const commitConversationSelection = (forceRouteTransition = false) => {
+            if (!forceRouteTransition && id === currentChatIdRef.current) {
+              settleInitialConversationHandoff();
+              return false;
+            }
+            if (id !== currentChatIdRef.current) {
+              promoteCurrentUndispatchedTurns(selectionIdentityKey);
+            }
+            conversationSelectionTicketRef.current =
+              allocateConversationSelectionTicket();
+            currentChatIdRef.current = id;
+            settleInitialConversationHandoff();
+            return true;
+        };
         /*
           Navigate whenever the target's surface is not the one this mount is.
 
@@ -3549,6 +3960,11 @@ export function ChatPageClient({
                 // open row): pushing the current path again is a history entry
                 // that goes nowhere.
                 if (pathname !== ownPath) {
+                    // Record the departure before navigation unmounts this
+                    // workspace. A late durable model-only save otherwise sees
+                    // the conversation being left as "current" and emits its
+                    // notice into a component tree that no longer exists.
+                    commitConversationSelection(true);
                     router.push(ownPath);
                     return;
                 }
@@ -3558,6 +3974,7 @@ export function ChatPageClient({
                 // `LEGACY_REVIEW_PATH`, not `PRODUCT_SURFACE_PATH.review`:
                 // this is where the workspace lives *today*, and the two stop
                 // being equal on the day of the cutover.
+                commitConversationSelection(true);
                 router.push(
                     conversationHandoffHref(targetSurface, id, LEGACY_REVIEW_PATH)
                 );
@@ -3573,16 +3990,6 @@ export function ChatPageClient({
         pendingCreatedChatRef.current = null;
         latestLocalComparisonPromptRef.current = null;
 
-        if (!isGuestMode && !skipLockCheck) {
-            const targetConv = conversations.find((c) => c.id === id);
-
-            if (targetConv && targetConv.isLocked) {
-                setLockedSelectDialog({ id, password: "", error: "" });
-                return;
-
-            }
-        }
-
         // An image conversation swaps the whole surface for the image
         // workspace: no chat drafts, model settings or panels to restore,
         // and the workspace loads its own generation history.
@@ -3592,7 +3999,7 @@ export function ChatPageClient({
             // A real switch, so a new workspace instance: the timeline and the
             // poll loop of the conversation being left must not follow.
             setImageWorkspaceKey(id);
-            currentChatIdRef.current = id;
+            commitConversationSelection();
             setCurrentChatId(id);
             setPromptPayload(null);
             setIsDeepResearchPending(false);
@@ -3618,7 +4025,7 @@ export function ChatPageClient({
           }
         }
 
-	  currentChatIdRef.current = id;
+      commitConversationSelection();
       setCurrentChatId(id);
 	  setPromptPayload(null);
       setIsDeepResearchPending(false);
@@ -3813,51 +4220,30 @@ export function ChatPageClient({
         // here instead, because that effect never runs twice.
         if (hasUrlSelectionPreset && !comparisonPresetAppliedRef.current) return;
 
-        if (
-            currentChatId ||
-            isInitialSelectedRef.current ||
-            comparisonPresetRequestedRef.current ||
-            hasUrlSelectionPreset
-        ) {
-            // A conversation is already open, an initial selection already
-            // ran, or the URL already decided the models. No restore will
-            // happen, so the selection is final and readiness must resolve.
-            queueMicrotask(() => setIsInitialConversationResolved(true));
-            return;
-        }
-
-        isInitialSelectedRef.current = true;
-
-        // A same-tab reload (F5, crash recovery) should return to whatever
-        // conversation was open, not send the user back through the welcome
-        // screen the way an actual new tab/session does. Only restore if the
-        // saved id still belongs to this user's just-loaded conversation
-        // list -- covers a deleted conversation, another user's leftover id
-        // after a sign-out/sign-in in the same tab, etc. -- and
-        // handleSelectConversation itself still re-prompts for a locked
-        // conversation's password rather than silently opening it.
         /*
-          A URL that names a conversation wins over the tab's last one.
-
-          `/continuations/[conversationId]` is the caller: the path already
-          says which row this mount is for, so restoring whatever was open
-          before would show a different conversation at that URL -- with the
-          imported prelude beside it describing neither.
-
-          Routed through `handleSelectConversation` like any other selection,
-          so the lock prompt and the surface check still run. An id that is not
-          in this account's just-loaded list is ignored: that list is what the
-          restore below already matches against, and "not yours" and "deleted"
-          are the same answer here as everywhere else.
+          A URL that names a conversation wins over both the open client state
+          and the tab's last conversation.
+
+          This must run before the `currentChatId` early return below. App
+          Router may retain this client tree when crossing Chat and Review, so
+          the state can still name B while the new URL explicitly hands Review
+          conversation A back to this workspace. Treating B as "already open"
+          would leave the URL handoff unspent and would also prevent A-bound
+          durable dispositions from being consumed.
+
+          The applied value is the id, not a component-lifetime boolean. A ->
+          B -> A is therefore two distinct handoffs even when React preserves
+          the component. Routed through `handleSelectConversation` like any
+          other selection, so ownership, lock and surface checks remain intact.
         */
         if (
             initialConversationId &&
-            !initialConversationAppliedRef.current &&
+            initialConversationAppliedRef.current !== initialConversationId &&
             conversations.some(
                 (conversation) => conversation.id === initialConversationId
             )
         ) {
-            initialConversationAppliedRef.current = true;
+            initialConversationAppliedRef.current = initialConversationId;
             /*
               The handoff parameter is spent the moment it is honoured.
 
@@ -3889,6 +4275,51 @@ export function ChatPageClient({
             return;
         }
 
+        if (
+            initialConversationId &&
+            initialConversationAppliedRef.current !== initialConversationId &&
+            !conversations.some(
+                (conversation) => conversation.id === initialConversationId
+            )
+        ) {
+            // The owned first-page list is authoritative for this bootstrap.
+            // A missing/unowned URL id cannot remain an eternal in-flight
+            // handoff: remember that it was handled and allow the user's
+            // fallback selection to consume its own future disposition.
+            initialConversationAppliedRef.current = initialConversationId;
+            settleInitialConversationHandoff(initialConversationId);
+        }
+
+        // A route without a named conversation re-arms a future handoff of the
+        // same id. This matters when the URL sequence is A -> unnamed -> A and
+        // the App Router retains the client component throughout.
+        if (!initialConversationId) {
+            initialConversationAppliedRef.current = null;
+        }
+
+        if (
+            currentChatId ||
+            isInitialSelectedRef.current ||
+            comparisonPresetRequestedRef.current ||
+            hasUrlSelectionPreset
+        ) {
+            // A conversation is already open, an initial selection already
+            // ran, or the URL already decided the models. No restore will
+            // happen, so the selection is final and readiness must resolve.
+            queueMicrotask(() => setIsInitialConversationResolved(true));
+            return;
+        }
+
+        isInitialSelectedRef.current = true;
+
+        // A same-tab reload (F5, crash recovery) should return to whatever
+        // conversation was open, not send the user back through the welcome
+        // screen the way an actual new tab/session does. Only restore if the
+        // saved id still belongs to this user's just-loaded conversation
+        // list -- covers a deleted conversation, another user's leftover id
+        // after a sign-out/sign-in in the same tab, etc. -- and
+        // handleSelectConversation itself still re-prompts for a locked
+        // conversation's password rather than silently opening it.
         const savedChatId = window.sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
         /*
           A restore reopens what was on screen; it never navigates.
@@ -3935,6 +4366,7 @@ export function ChatPageClient({
         isGuestMode,
         isUserSettingsLoaded,
         mountedSurface,
+        settleInitialConversationHandoff,
     ]);
 
     const handleLock = async (id: string, password: string) => {
@@ -4243,10 +4675,27 @@ export function ChatPageClient({
   // ChatApp retries, follow-ups and payload sends bypass handleGlobalSubmit,
   // but each crosses onBeforeModelSend. A fixture must refuse that barrier
   // before any Message write or provider-facing request can start.
-  const ensureModelSettingsReadyForChatApp = async (targetChatId: string) =>
-    promptRefinerMode === "e2e_fixture"
+  const ensureModelSettingsReadyForChatApp = async (targetChatId: string) => {
+    const loopbackGate = window as typeof window & {
+      __tomverseChatBeforeModelSendGate?: Promise<void>;
+      __tomverseChatBeforeModelSendStarted?: boolean;
+      __tomverseChatBeforeModelSendCallCount?: number;
+      __tomverseChatBeforeModelSendHoldOnCall?: number;
+    };
+    if (window.location.hostname === "127.0.0.1" &&
+        loopbackGate.__tomverseChatBeforeModelSendGate) {
+      const callCount = (loopbackGate.__tomverseChatBeforeModelSendCallCount ?? 0) + 1;
+      loopbackGate.__tomverseChatBeforeModelSendCallCount = callCount;
+      if (loopbackGate.__tomverseChatBeforeModelSendHoldOnCall === undefined ||
+          loopbackGate.__tomverseChatBeforeModelSendHoldOnCall === callCount) {
+        loopbackGate.__tomverseChatBeforeModelSendStarted = true;
+        await loopbackGate.__tomverseChatBeforeModelSendGate;
+      }
+    }
+    return promptRefinerMode === "e2e_fixture"
       ? false
       : ensureModelSettingsReady(targetChatId);
+  };
 
   useEffect(() => {
     if (
@@ -4428,7 +4877,9 @@ export function ChatPageClient({
     const submitOwnerIsCurrent = () => {
       const current = submitIdentityFenceRef.current;
       const ownerKey = submitOwner.identityKey ?? "unresolved";
-      return current.identityKey === submitOwner.identityKey &&
+      return Boolean(submitOwner.identityKey) &&
+        activeChatIdentityIs(submitOwner.identityKey!, submitOwner.identityEpoch) &&
+        current.identityKey === submitOwner.identityKey &&
         current.epoch === submitOwner.identityEpoch &&
         pendingSubmissionOwnersRef.current.get(ownerKey)?.token ===
           submitOwner.token;
@@ -4736,13 +5187,30 @@ export function ChatPageClient({
       // all: the preflight would price an empty set and the turn would sit
       // unanswered. Abandon instead, leaving the answers already on screen.
       if (!activeModelIds.length) return;
-      const chatSendIsCurrent = (requireLoaded = true) => {
+      const chatSendIsCurrent = (requireLoaded = true, notifyChanged = true) => {
         if (!submitOwnerIsCurrent()) return false;
-        if (mountedSurface !== "chat") return true;
         const currentIdentityKey = identityNamespaceKey(identityNamespaceRef.current);
+        const preparedConversationId = pendingCreatedConversationAdoption
+          ? originScopeId
+          : activeChatId!;
+        const preparedSelectionIsCurrent = Boolean(identityKey) &&
+          identityKey === currentIdentityKey &&
+          preparedSelectionTicket === conversationSelectionTicketRef.current &&
+          preparedConversationId === currentChatIdRef.current;
+        if (!preparedSelectionIsCurrent) {
+          if (notifyChanged && identityKey === currentIdentityKey) {
+            showToast(t("chat.sendPreparationChanged"), "info");
+          }
+          return false;
+        }
+        // Review and every other surface still share the global composer.
+        // They must honour the captured conversation and committed selection
+        // ticket, but their multi-model selection is not Chat's single-model
+        // contract and must not be rejected by the helper below.
+        if (mountedSurface !== "chat") return true;
         const current = chatPreparedSendIsCurrent({
           identityKey, currentIdentityKey,
-          conversationId: pendingCreatedConversationAdoption ? originScopeId : activeChatId!,
+          conversationId: preparedConversationId,
           currentConversationId: currentChatIdRef.current,
           selectionTicket: preparedSelectionTicket,
           currentSelectionTicket: conversationSelectionTicketRef.current,
@@ -5035,6 +5503,38 @@ export function ChatPageClient({
 
         if (saved) {
           messageWasSaved = true;
+          // A durable Message may settle after an A→B→A identity cycle.
+          // It remains a server fact, but the detached epoch has no authority
+          // to create a notice or a later provider-dispatch disposition in the
+          // returning A tree.
+          if (submitOwnerIsCurrent()) {
+            // The commit response can arrive after a same-identity navigation.
+            // There is then no pending entry for the departing selection to
+            // promote: record the opaque disposition immediately and wake the
+            // active tree. A newly-created Chat deliberately compares against
+            // its still-current `new` origin until the accepted Message adopts
+            // the server conversation; `chatSendIsCurrent(false)` preserves
+            // that pending-adoption contract.
+            // Bind the durable receipt to exactly one side-effect-free
+            // selection decision. A stale Review/global send must record its
+            // opaque origin disposition and stop without briefly replacing
+            // the saved notice with a preparation-changed toast on the final
+            // provider guard.
+            sendCurrentAfterMessageSave = chatSendIsCurrent(false, false);
+            if (sendCurrentAfterMessageSave) {
+              setBoundedMapEntry(pendingDurableUndispatchedTurnsRef.current, comparisonId, {
+                identityKey: submitOwner.identityKey ?? "unresolved",
+                identityEpoch: submitOwner.identityEpoch,
+                conversationId: activeChatId,
+                turnId: comparisonId,
+                selectionTicket: preparedSelectionTicket,
+              });
+            } else {
+              persistSavedQuestionNotSent(
+                `${submitOwner.identityKey}\0${activeChatId}\0${comparisonId}`
+              );
+            }
+          }
           /*
             Swap the composer's upload ids for the durable attachment ids the
             save just wrote, in place, so the cards already on screen are the
@@ -5076,7 +5576,7 @@ export function ChatPageClient({
             // The Message is durable. A viewport remount may now refresh its
             // history, but must not erase the accepted turn merely because
             // that GET is pending. The panel will wait for a complete view.
-            sendCurrentAfterMessageSave = chatSendIsCurrent(false);
+            sendCurrentAfterMessageSave = chatSendIsCurrent(false, false);
             const submittedDraftStillCurrent = commitDraftSend(
               preparedDraft,
               originScopeId,
@@ -5228,6 +5728,9 @@ export function ChatPageClient({
         text: trimmed,
         chatId: activeChatId,
         userMessageId: userMsgId,
+        messageWasDurablySaved: messageWasSaved,
+        conversationSelectionTicket: preparedSelectionTicket,
+        identityEpoch: submitOwner.identityEpoch,
         // Exactly the set this run was prepared for above: priced by the
         // preflight, given admission slots by it, and confirmed by the send
         // barrier. A panel whose model is not in here was not part of this
@@ -6298,7 +6801,7 @@ export function ChatPageClient({
         showToast(t("chat.singleModelRequired"), "info");
         return;
       }
-      conversationSelectionTicketRef.current += 1;
+      conversationSelectionTicketRef.current = allocateConversationSelectionTicket();
       const nextModels = clampSelectedModels(
         modelIds.filter(isEnabledModelId)
       ).slice(0, maxSelectableModels);
@@ -7641,6 +8144,12 @@ export function ChatPageClient({
           }
           onSubmit={handleGlobalSubmit}
           onBeforeModelSend={ensureModelSettingsReadyForChatApp}
+          // eslint-disable-next-line react-hooks/refs -- synchronous selection epoch snapshot; never rendered.
+          conversationSelectionTicket={conversationSelectionTicketRef.current}
+          identityEpoch={identityEpoch}
+          onSavedQuestionNotSent={handleSavedQuestionNotSent}
+          onDurableUndispatchedAccepted={handleDurableUndispatchedAccepted}
+          onProviderDispatchStarted={handleProviderDispatchStarted}
           onCompareSummary={handleCompareSummary}
           isCompareSummaryLoading={isCompareSummaryLoading}
           isQuickSummaryCached={isQuickSummaryCached}
@@ -7773,6 +8282,12 @@ export function ChatPageClient({
           onWebSearchSuggestionDismiss={handleWebSearchSuggestionDismiss}
           onSubmit={handleGlobalSubmit}
           onBeforeModelSend={ensureModelSettingsReadyForChatApp}
+          // eslint-disable-next-line react-hooks/refs -- synchronous selection epoch snapshot; never rendered.
+          conversationSelectionTicket={conversationSelectionTicketRef.current}
+          identityEpoch={identityEpoch}
+          onSavedQuestionNotSent={handleSavedQuestionNotSent}
+          onDurableUndispatchedAccepted={handleDurableUndispatchedAccepted}
+          onProviderDispatchStarted={handleProviderDispatchStarted}
           onChangePanelModel={changePanelModel}
           onTogglePanelDisable={togglePanelDisable}
           onRemoveModel={handleRemoveModel}
@@ -8621,7 +9136,10 @@ export function ChatPageClient({
           <div className="mt-5 flex justify-end gap-2">
             <button
               type="button"
-              onClick={() => setLockedSelectDialog(null)}
+              onClick={() => {
+                settleInitialConversationHandoff(lockedSelectDialog.id);
+                setLockedSelectDialog(null);
+              }}
               className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
             >
               {t("auth.cancel")}
diff --git a/components/chat/ChatApp.tsx b/components/chat/ChatApp.tsx
index 3ae119357..ac0895905 100644
--- a/components/chat/ChatApp.tsx
+++ b/components/chat/ChatApp.tsx
@@ -85,7 +85,6 @@ import {
   ownsChatRuntimeTranscript,
   releaseChatRuntimeLoad,
   restoreChatRuntimeCompleteViewForSend,
-  isChatRuntimeCompleteViewRecordCurrent,
   setChatRuntimeLastPrompt,
   settleChatRuntimeLoad,
   subscribeChatRuntime,
@@ -127,6 +126,12 @@ type ChatAppProps = {
     text: string;
     chatId: string;
     userMessageId: string;
+    /** True only after the account Message receipt/mapping was accepted. */
+    messageWasDurablySaved: boolean;
+    /** Conversation-selection epoch at acceptance; independent of identity. */
+    conversationSelectionTicket: number;
+    /** Identity/session epoch that owned the accepted send. */
+    identityEpoch: number;
     /**
      * The models this send was actually made for. A panel only auto-sends a
      * payload that names its own model: the payload outlives the send that
@@ -276,6 +281,36 @@ type ChatAppProps = {
   ) => void;
   onFollowupSent?: (modelId: string) => void;
   onBeforeSend?: (chatId: string) => Promise<boolean>;
+  conversationSelectionTicket: number;
+  identityEpoch: number;
+  /**
+   * Reports a durable user Message for which this panel did not start a
+   * provider request. The shell owns conversation selection, so it is the
+   * only layer that can show the notice on the conversation the Message
+   * belongs to instead of leaking it onto whichever conversation is open
+   * when an awaited save settles.
+   */
+  onSavedQuestionNotSent?: (
+    identityKey: string,
+    identityEpoch: number,
+    conversationId: string,
+    turnId: string,
+    conversationSelectionTicket: number,
+    reason: "terminal" | "conversation-left"
+  ) => void;
+  onDurableUndispatchedAccepted?: (
+    identityKey: string,
+    identityEpoch: number,
+    conversationId: string,
+    turnId: string,
+    conversationSelectionTicket: number
+  ) => boolean;
+  onProviderDispatchStarted?: (
+    identityKey: string,
+    identityEpoch: number,
+    conversationId: string,
+    promptId: string
+  ) => void;
   onRequestCloseModel?: MouseEventHandler<HTMLButtonElement>;
   hasMultipleActiveModels?: boolean;
   currentPlan?: string | null;
@@ -315,6 +350,11 @@ function ChatAppComponent({
   onTurnError,
   onFollowupSent,
   onBeforeSend,
+  conversationSelectionTicket,
+  identityEpoch,
+  onSavedQuestionNotSent,
+  onDurableUndispatchedAccepted,
+  onProviderDispatchStarted,
   onRequestCloseModel,
   hasMultipleActiveModels = false,
   currentPlan,
@@ -322,6 +362,11 @@ function ChatAppComponent({
 }: ChatAppProps) {
   const { data: session, status } = useSession();
   const sessionUserId = session?.user?.id || null;
+  const panelIdentityKey = chatRuntimeIdentityKey(
+    isGuestMode
+      ? { kind: "guest" }
+      : { kind: "account", userId: sessionUserId }
+  );
     const { t } = useLanguage();
     // UX-021. Only used to name this panel's follow-up field. Three panels
     // render three of these, so a name that does not say *which* model is the
@@ -341,11 +386,9 @@ function ChatAppComponent({
    * component, because both shells unmount every panel when the conversation
    * changes. Remounting on the same key adopts the run that is already going
    * instead of starting over with nothing.
-   */
+  */
   const runtimeKey = chatRuntimeKey({
-    identityKey: chatRuntimeIdentityKey(
-      isGuestMode ? { kind: "guest" } : { kind: "account", userId: sessionUserId }
-    ),
+    identityKey: panelIdentityKey,
     conversationId: initialConversationId,
     modelId,
     transcriptScope,
@@ -1265,7 +1308,9 @@ function ChatAppComponent({
     */
     acknowledgedUnavailableAttachmentIds: string[] = [],
     /** Persisted identity used by authenticated durable Chat verification. */
-    sourceUserMessageId: string = userMsgId
+    sourceUserMessageId: string = userMsgId,
+    /** Fires at the exact boundary where a provider-facing fetch is attempted. */
+    onDispatchStarted?: () => void
   ) => {
     // The key this run owns for its whole life. `targetChatId` is the
     // conversation the send was made in, and every write below names this key
@@ -1511,6 +1556,7 @@ function ChatAppComponent({
 
     try {
       const sendChatRequest = async (turnstileToken?: string) => {
+        onDispatchStarted?.();
         const res = await fetch("/api/chat", {
           method: "POST",
           headers: {
@@ -2412,7 +2458,28 @@ function ChatAppComponent({
     // models the send was made for may answer it -- a model swapped in
     // afterwards was not part of this run and has no answer to give here.
     if (!promptPayload.modelIds.includes(modelId)) return;
-    if (transcriptScope === "conversation" && !runtime.isLoaded) return;
+    if (transcriptScope === "conversation" && !runtime.isLoaded) {
+      // Only the explicit receipt provenance makes this a durable Message.
+      // Guest and legacy non-durable payloads must never receive "saved" copy.
+      if (!promptPayload.messageWasDurablySaved) return;
+      // If this
+      // incomplete panel is merely remounted (responsive shell change or a
+      // successful retry), the parent still points at the same conversation
+      // and ignores this cleanup. If the user actually leaves, the parent
+      // records one conversation-scoped disposition and shows it only when
+      // that originating conversation is selected again. Never retain the
+      // payload for an automatic provider call after navigation.
+      return () => {
+        onSavedQuestionNotSent?.(
+          panelIdentityKey,
+          promptPayload.identityEpoch,
+          promptPayload.chatId,
+          promptPayload.id,
+          promptPayload.conversationSelectionTicket,
+          "conversation-left"
+        );
+      };
+    }
 
     const promptKey = `${promptPayload.id}:${promptPayload.chatId}:${modelId}`;
     if (processedPromptKeys.has(promptKey)) return;
@@ -2420,6 +2487,21 @@ function ChatAppComponent({
     let cancelled = false;
     let claimed = false;
     let retainClaim = false;
+    let providerStarted = false;
+    let dispositionReported = false;
+    const reportDisposition = (reason: "terminal" | "conversation-left") => {
+      if (dispositionReported || transcriptScope !== "conversation" ||
+          !promptPayload.messageWasDurablySaved) return;
+      dispositionReported = true;
+      onSavedQuestionNotSent?.(
+        panelIdentityKey,
+        promptPayload.identityEpoch,
+        promptPayload.chatId,
+        promptPayload.id,
+        promptPayload.conversationSelectionTicket,
+        reason
+      );
+    };
     queueMicrotask(() => {
       if (cancelled || isPanelDisabled) return;
       if (processedPromptKeys.has(promptKey)) return;
@@ -2447,6 +2529,7 @@ function ChatAppComponent({
         // under a model the panel is no longer showing.
         if (!settingsReady || panelModelIdRef.current !== modelId) {
           retainClaim = true;
+          reportDisposition("terminal");
           return;
         }
         if (transcriptScope === "conversation" &&
@@ -2470,13 +2553,27 @@ function ChatAppComponent({
           promptPayload.admissionToken,
           promptPayload.contextBundle,
           promptPayload.contextLayout,
-          promptPayload.webSearchMode
-        );
+          promptPayload.webSearchMode,
+          [],
+          promptPayload.userMessageId,
+          () => {
+            providerStarted = true;
+            onProviderDispatchStarted?.(
+              panelIdentityKey,
+              promptPayload.identityEpoch,
+              promptPayload.chatId,
+              promptPayload.id
+            );
+          }
+        ).then(() => {
+          if (!providerStarted) reportDisposition("terminal");
+        });
       })();
     });
     return () => {
       cancelled = true;
       if (claimed && !retainClaim) processedPromptKeys.delete(promptKey);
+      if (!providerStarted) reportDisposition("conversation-left");
     };
   }, [
     handleSendPrompt,
@@ -2484,6 +2581,9 @@ function ChatAppComponent({
     isGuestMode,
     isPanelDisabled,
     modelId,
+    onSavedQuestionNotSent,
+    onProviderDispatchStarted,
+    panelIdentityKey,
     promptPayload,
     runtime.isLoaded,
     runtimeKey,
@@ -2498,6 +2598,8 @@ function ChatAppComponent({
             !getChatRuntimeSnapshot(runtimeKey).isLoaded) return;
         const preparationToken = beginSendPreparation(runtimeKey);
         if (!preparationToken) return;
+        const originSelectionTicket = conversationSelectionTicket;
+        const originIdentityEpoch = identityEpoch;
 
         try {
           const settingsReady = await onBeforeSend?.(initialConversationId) ?? true;
@@ -2531,6 +2633,14 @@ function ChatAppComponent({
                   throw new Error("Model-only user message save returned no valid id mapping.");
                 }
                 userMsgId = mapping.messageId;
+                const retainsDispatchAuthority = onDurableUndispatchedAccepted?.(
+                  panelIdentityKey,
+                  originIdentityEpoch,
+                  initialConversationId,
+                  userMsgId,
+                  originSelectionTicket
+                ) === true;
+                if (!retainsDispatchAuthority) return;
             } catch (error) {
                 console.error("model-only user message save failed:", error);
                 dispatchAppToast(t("chat.retryQuestionSaveFailed"), "error");
@@ -2543,14 +2653,38 @@ function ChatAppComponent({
             // but this stale continuation has no authority to dispatch it.
             // Do not ask for a blind resend: that could duplicate the saved
             // question. The provider was never contacted for this turn.
-            if (isChatRuntimeCompleteViewRecordCurrent(completeView)) {
-              dispatchAppToast(t("chat.savedQuestionNotSent"), "info");
-            }
+            onSavedQuestionNotSent?.(
+              panelIdentityKey,
+              originIdentityEpoch,
+              initialConversationId,
+              userMsgId,
+              originSelectionTicket,
+              "terminal"
+            );
             return;
           }
           setModelInput("");
           onFollowupSent?.(modelId);
-          await handleSendPrompt(trimmed, initialConversationId, userMsgId);
+          await handleSendPrompt(
+            trimmed,
+            initialConversationId,
+            userMsgId,
+            undefined,
+            undefined,
+            undefined,
+            undefined,
+            undefined,
+            undefined,
+            undefined,
+            [],
+            userMsgId,
+            () => onProviderDispatchStarted?.(
+              panelIdentityKey,
+              originIdentityEpoch,
+              initialConversationId,
+              userMsgId
+            )
+          );
         } finally {
           endSendPreparation(runtimeKey, preparationToken);
         }
diff --git a/components/chat/DesktopChatShell.tsx b/components/chat/DesktopChatShell.tsx
index 641528604..c71922e08 100644
--- a/components/chat/DesktopChatShell.tsx
+++ b/components/chat/DesktopChatShell.tsx
@@ -84,6 +84,9 @@ type PromptPayload = {
   text: string;
   chatId: string;
   userMessageId: string;
+  messageWasDurablySaved: boolean;
+  conversationSelectionTicket: number;
+  identityEpoch: number;
   /** The models this send was made for; other panels must not consume it. */
   modelIds: string[];
   attachments: ChatAttachment[];
@@ -329,6 +332,29 @@ type DesktopChatShellProps = {
   }) => void;
   onSubmit: () => void;
   onBeforeModelSend: (chatId: string) => Promise<boolean>;
+  conversationSelectionTicket: number;
+  identityEpoch: number;
+  onSavedQuestionNotSent: (
+    identityKey: string,
+    identityEpoch: number,
+    conversationId: string,
+    turnId: string,
+    conversationSelectionTicket: number,
+    reason: "terminal" | "conversation-left"
+  ) => void;
+  onDurableUndispatchedAccepted: (
+    identityKey: string,
+    identityEpoch: number,
+    conversationId: string,
+    turnId: string,
+    conversationSelectionTicket: number
+  ) => boolean;
+  onProviderDispatchStarted: (
+    identityKey: string,
+    identityEpoch: number,
+    conversationId: string,
+    promptId: string
+  ) => void;
   onChangePanelModel: (oldModelId: string, newModelId: string) => void;
   onTogglePanelDisable: (modelId: string) => void;
   onRemoveModel: (modelId: string) => void;
@@ -452,6 +478,11 @@ export function DesktopChatShell({
   onWebSearchSuggestionDismiss,
   onSubmit,
   onBeforeModelSend,
+  conversationSelectionTicket,
+  identityEpoch,
+  onSavedQuestionNotSent,
+  onDurableUndispatchedAccepted,
+  onProviderDispatchStarted,
   onChangePanelModel,
   onTogglePanelDisable,
   onRemoveModel,
@@ -1212,6 +1243,11 @@ export function DesktopChatShell({
                   isGuestMode={isGuestMode}
                   webSearchMode={webSearchMode}
                   onBeforeSend={onBeforeModelSend}
+                  conversationSelectionTicket={conversationSelectionTicket}
+                  identityEpoch={identityEpoch}
+                  onSavedQuestionNotSent={onSavedQuestionNotSent}
+                  onDurableUndispatchedAccepted={onDurableUndispatchedAccepted}
+                  onProviderDispatchStarted={onProviderDispatchStarted}
                   onResponseComplete={onResponseComplete}
                   onTurnError={onTurnError}
                   onFollowupSent={onFollowupSent}
diff --git a/components/chat/MobileChatShell.tsx b/components/chat/MobileChatShell.tsx
index 029b18b66..0969d914f 100644
--- a/components/chat/MobileChatShell.tsx
+++ b/components/chat/MobileChatShell.tsx
@@ -107,6 +107,9 @@ type PromptPayload = {
   text: string;
   chatId: string;
   userMessageId: string;
+  messageWasDurablySaved: boolean;
+  conversationSelectionTicket: number;
+  identityEpoch: number;
   /** The models this send was made for; other panels must not consume it. */
   modelIds: string[];
   attachments: ChatAttachment[];
@@ -373,6 +376,29 @@ type MobileChatShellProps = {
   onRequestUndoToast: (message: string, undo: () => void) => void;
   onSubmit: () => void;
   onBeforeModelSend: (chatId: string) => Promise<boolean>;
+  conversationSelectionTicket: number;
+  identityEpoch: number;
+  onSavedQuestionNotSent: (
+    identityKey: string,
+    identityEpoch: number,
+    conversationId: string,
+    turnId: string,
+    conversationSelectionTicket: number,
+    reason: "terminal" | "conversation-left"
+  ) => void;
+  onDurableUndispatchedAccepted: (
+    identityKey: string,
+    identityEpoch: number,
+    conversationId: string,
+    turnId: string,
+    conversationSelectionTicket: number
+  ) => boolean;
+  onProviderDispatchStarted: (
+    identityKey: string,
+    identityEpoch: number,
+    conversationId: string,
+    promptId: string
+  ) => void;
   onCompareSummary: () => void;
   isCompareSummaryLoading: boolean;
   isQuickSummaryCached?: boolean;
@@ -498,6 +524,11 @@ export function MobileChatShell({
   onRequestUndoToast,
   onSubmit,
   onBeforeModelSend,
+  conversationSelectionTicket,
+  identityEpoch,
+  onSavedQuestionNotSent,
+  onDurableUndispatchedAccepted,
+  onProviderDispatchStarted,
   onCompareSummary,
   isCompareSummaryLoading,
   isQuickSummaryCached = false,
@@ -1590,6 +1621,11 @@ export function MobileChatShell({
                   isGuestMode={isGuestMode}
                   webSearchMode={webSearchMode}
                   onBeforeSend={onBeforeModelSend}
+                  conversationSelectionTicket={conversationSelectionTicket}
+                  identityEpoch={identityEpoch}
+                  onSavedQuestionNotSent={onSavedQuestionNotSent}
+                  onDurableUndispatchedAccepted={onDurableUndispatchedAccepted}
+                  onProviderDispatchStarted={onProviderDispatchStarted}
                   hideModelOnlyInput
                   useCenteredWelcome
                   onContentStateChange={handleContentStateChange}
diff --git a/docs/ops/cross-review/packages/chat-saved-undispatched-disposition-followup-v2/authorization.md b/docs/ops/cross-review/packages/chat-saved-undispatched-disposition-followup-v2/authorization.md
new file mode 100644
index 000000000..1ab4445f2
--- /dev/null
+++ b/docs/ops/cross-review/packages/chat-saved-undispatched-disposition-followup-v2/authorization.md
@@ -0,0 +1,151 @@
+# Chat 저장 후 미전송 notice 후속 독립 검토 승인 기록
+
+- approvedBy: `mposition` (현재 대화의 권장 순서 자동 개발과 Cursor CLI 독립 검토 지시)
+- approvedAt: `2026-09-24` (Australia/Brisbane)
+- author: `codex`
+- independentReviewer: `cursor-cli`
+- task: [task.json](./task.json)
+
+원 `chat-history-pagination-recovery-v1` exchange는 round 2에서 `approve`와
+재현 가능한 지적 세 건을 남겼고 수정 round가 소진돼
+`on_hold(revisions_exhausted)`로 종료됐다. 이 후속 작업은 그 기록을 재개하거나
+변경하지 않는다. 원 exchange의 첫 두 제품 지적만 별도 successor로 상속하며,
+Linux visual base 대조 증거 지적은 제품 source 수정과 다른 검증 작업이므로 이
+package에서 제품 수정으로 소급하지 않는다. 다만 이후 확보된 canonical Linux
+증거는 이 successor에 그대로 기록한다: exact base
+`ad2b51622992c29056706c443d80bdba928336e1`의 run `35954859255`와 feature
+source head `93b18c8f37be46cbfce47658cc638e77aa008d63`의 run `35700992823`은 모두
+Loading 표본 9/9 통과, 전체 27 통과/54 실패로 동일했다. 따라서 그 54건은 이
+feature 이전에도 존재했으며 이 successor의 회귀 증거가 아니다.
+
+제품 source lineage는
+`93b18c8f37be46cbfce47658cc638e77aa008d63`이다. 이 successor의 package 비교
+base는 그 직계 후속 audit-only commit
+`bef622a565468fb9857639bc4ef24171c2c57a5f`이며, 해당 commit은 원 v1의
+`authorization.md`와 `records/`만 추가하고 제품 source는 변경하지 않는다. 따라서
+검토 변경 범위는 durable Message의 saved-but-undispatched notice를 identity와
+originating conversation에 결속하는 아홉 제품·테스트 파일, 이 successor의
+`task.json`과 `authorization.md`, 로컬 무과금 검증 및 Cursor CLI의 읽기 전용 독립
+검토다. prompt payload, attachment, admission token 또는 context bundle을 conversation
+전환 너머에 보관하지 않으며 provider 요청을 자동 재생하지 않는다.
+
+사용자는 독립 검토가 필요할 때 Cursor CLI를 사용하도록 지시했고
+`--skip-preflight` 예외도 승인했다. Reviewer는 repository와 package를 읽기
+전용으로 검토하고 package digest에 verdict를 결속한다. Cursor CLI 외의 유료
+provider API, 실제 Chat provider 호출, Railway staging/production 접근,
+feature flag 변경, 실제 사용자 traffic, push·PR 병합·배포는 승인 범위 밖이다.
+
+## 구현 결정
+
+- durable 저장 여부는 명시적인 save receipt 뒤에만 `true`가 된다. payload 존재만
+  보고 saved notice를 만들지 않으므로 guest 및 legacy save-failure 경로는 제외된다.
+- 대화 전환을 넘는 것은 identity, conversation id, opaque turn/message id,
+  selection ticket뿐이다. prompt와 실행 권한은 보관하지 않는다.
+- provider 시작 여부는 `processedPromptKeys`가 아니라 `/api/chat` fetch 직전의
+  callback으로 확인한다. 시작 callback은 pending receipt와 동일 opaque turn의
+  저장된 disposition을 제거해, 늦은 receipt 뒤 실제 dispatch가 시작된 경우의
+  false notice를 막는다. 이후 다른 sibling panel의 cleanup이 같은 turn을 보고해도
+  provider-start set을 먼저 확인하고 exact persisted key를 제거한 뒤 종료하므로,
+  이미 시작된 provider 요청이 다시 undispatched로 분류되지 않는다.
+- 대화 선택 epoch와 URL surface의 실제 target을 동기적으로 기록해 A→B→A 및
+  늦은 cleanup을 구분한다. notice는 origin conversation 선택 시 소비하고
+  sessionStorage에서도 제거한다.
+- identity epoch는 대화 선택 ticket과 별도이며 page tree 교체를 넘어 browser-realm에서
+  단조 증가한다. submit, prompt payload 및 model-only panel callback은 시작 epoch를
+  캡처하고, durable-accepted/disposition/provider-start callback은 active identity,
+  현재 namespace, submit fence의 identity key와 epoch가 모두 일치할 때만 상태를
+  바꾼다. loading/unresolved 경계에서 submit fence key가 null이 된 경우도 old A
+  callback을 승인하지 않는다. 따라서 account A로 돌아왔더라도 이전 A epoch의 늦은
+  Message 응답은 저장된 notice나 toast를 만들지 않는다.
+- browser identity fence는 React render가 아니라 layout commit에서만 채택한다. SSR은
+  module-global active fence를 읽거나 쓰지 않으므로 같은 worker의 순차·동시 A/B render가
+  다른 요청의 account namespace를 관측하거나 browser epoch를 소비하지 않는다.
+- sessionStorage의 bounded owner marker는 ChatPage가 완전히 unmount된 동안 일어난
+  identity 변경도 관측한다. 같은 identity의 새 tree는 opaque disposition을 복구하지만
+  다른 identity의 최초 mount는 이전 disposition을 fail-closed로 제거하고 marker를
+  새 identity로 다시 결속한다. marker에는 prompt나 실행 권한이 없다.
+- 비동기 conversation lookup을 무효화하는 navigation-attempt ticket과 실제 선택을
+  소유하는 committed ticket을 분리했다. committed ticket은 ownership, lock 및 surface
+  검증이 끝난 뒤 실제 currentChat/router transition 직전에만 증가하므로 locked row를
+  열었다 취소하는 행위는 A의 pending turn을 abandon하지 않는다.
+- disposition 변경은 매번 최신 sessionStorage를 기준으로 적용하고 memory set을 그
+  결과로 교체한다. 따라서 hydrate 전 add가 기존 key를 덮거나 stale closure가 이미
+  소비된 key를 되살리지 않는다. memory/storage/pending registry는 모두 64개로
+  제한하며 identity 전환 clear만 의도적으로 merge하지 않는다.
+- 같은 window에서는 `storage` event가 발생하지 않으므로 prompt-free change event가
+  활성 tree에 재확인을 요청한다. locked target의 취소는 실제 대화 전환이 아니므로
+  disposition 승격은 lock/ownership/surface 검증 뒤 route/selection 직전에만 한다.
+- global Message commit 응답이 같은 identity의 conversation/ticket 전환 뒤 도착하면
+  departing selection이 나중에 승격할 pending entry를 만들지 않고 즉시 opaque
+  disposition을 저장하고 change event를 보낸다. 새 conversation은 accepted Message가
+  server id를 채택할 때까지 `new` origin을 current로 보는 기존
+  `chatPreparedSendIsCurrent(false)` 계약을 그대로 사용한다.
+- URL에서 넘겨받은 최초 conversation id는 실제 client selection이 그 id에 도달할
+  때까지만 disposition 소비를 막는다. handoff가 settled된 뒤에는 보존된 초기 prop이
+  이후 B의 origin notice를 영구 차단하지 않는다. locked target의 unlock 취소,
+  owned 목록에 없는 target 및 사용자가 선택한 fallback도 handoff의 terminal
+  abandoned 결과로 기록해, 실패한 URL target이 이후 conversation notice를 영구
+  차단하지 않는다.
+- global composer의 durable Message 이후 current 판정은 Chat뿐 아니라 Review 등 모든
+  surface에서 캡처한 conversation id와 committed selection ticket을 먼저 비교한다.
+  Review의 multi-model 계약은 Chat 전용 single-model helper와 분리하지만 A→B→A 뒤의
+  늦은 commit이 provider payload를 발행할 권한은 주지 않는다.
+- `conversation-left` cleanup은 origin id와 committed ticket이 아직 같더라도 opaque
+  disposition을 먼저 저장한다. 단, 동일한 durable prompt payload가 이 tree에 계속
+  mount돼 있고 provider가 시작되지 않은 responsive remount에서는 그 exact key만
+  소비하지 않는다. payload가 full unmount 또는 active-row 재선택으로 사라지면 같은
+  conversation에서 notice를 한 번 소비한다.
+- continuation의 New Chat은 route를 떠나기 전에 current pending durable turns를
+  disposition으로 승격한다. loopback-only deterministic barrier로 durable commit 뒤
+  `onBeforeModelSend`가 대기하는 경계를 재현해, 새 Chat 이동 뒤 provider POST가 없고
+  continuation 재진입에서 notice가 한 번 표시됨을 확인한다.
+- App Router가 Chat/Review 사이에서 client tree를 보존할 수 있으므로 URL handoff는
+  이미 열린 client conversation보다 먼저 적용한다. 한 번 적용했다는 boolean 대신
+  적용한 conversation id를 기록하고 URL이 이름 없는 상태를 거치면 re-arm한다.
+  ownership, lock 및 surface 검사는 계속 `handleSelectConversation` 경로가 수행한다.
+
+## 검증 및 잔여 범위
+
+fresh production build 뒤 history/context response 경합, 전역 durable-undispatched와
+late commit response, Review model-only cross-surface, locked-selection 취소, rapid
+conversation A→B→A, identity A→B/A→B→A 및 full-unmount identity handoff 경합
+focused E2E는 desktop/mobile Chromium에서 38/38 통과했다. 여기에는 최초 URL A
+handoff가 settled된 뒤 B의 늦은 disposition을 B에서 한 번 소비하는 회귀와 Review
+전역 composer의 late commit 뒤 A→B→A에서 provider dispatch 0건·A notice 1건을
+확인하는 회귀, locked initial URL handoff 취소 및 missing/unowned initial URL
+handoff 뒤 B의 disposition이 B에서 한 번 소비되는 회귀, same-conversation full
+unmount 및 active-row 재선택 뒤 notice 1건, continuation New Chat 뒤 origin notice
+1건·provider dispatch 0건이 포함된다. Review와 continuation의 다중 panel 회귀는
+첫 panel의 실제 provider POST 뒤 둘째 panel의 cleanup을 실행해 provider POST 1건,
+savedQuestionNotSent notice 0건, persisted disposition 0건을 desktop/mobile에서
+각각 확인한다. 고정 200ms sleep은
+fixture의 context/Message response-settled 상태 poll로 교체했다. 각
+유형의 assertion은 다음과 같이 다르다. Chat/Review abandonment는 다른 conversation의
+notice 0건, origin notice 1건, saved question provider dispatch 0건과 해당 테스트가
+확인하는 durable Message 1건을 검증한다. late global commit은 B notice 0건,
+첫 origin 복귀 notice 1건, provider dispatch 0건과 durable Message 1건을 검증한다.
+lock 취소는 notice 0건과 current
+conversation 불변을 검증하며 durable count는 assertion하지 않는다. same-identity
+rapid conversation A→B→A는 origin notice 1건과 provider dispatch 0건을 검증한다.
+identity A→B/A→B→A는 old identity notice 0건과 old prompt provider dispatch
+0건을 검증한다. full-unmount A disposition→B mount→A mount는 persisted A
+disposition이 B mount에서 제거되고 돌아온 A에서 old notice/provider dispatch가
+0건임을 검증한다. Review 경합은 surface handoff가 언어 query를 보존하지 않는 기존
+동작 때문에 도착 locale의 동일 i18n copy를 검사하며, notice event와 화면 toast를
+함께 확인한다. `npm run
+typecheck`, 변경 아홉 파일 scoped ESLint, production build 및 `git diff --check`도
+통과했고 bounded storage/owner 및 SSR/unresolved identity unit은 13/13 통과했다. 독립 Cursor CLI 검토 결과는 source와
+package digest를 고정한 뒤 별도 record에 결속한다.
+
+이 successor는 sidebar/URL surface 선택과 responsive remount 경계를 다룬다.
+conversation 삭제 때 남은 opaque notice를 즉시 purge하는 별도 UX와 모든 guest
+negative path의 확대 행렬은 새 제품 동작을 요구하므로 이 task의 pass 조건으로
+간주하지 않는다. 삭제된 id는 다시 선택될 수 없어 notice가 노출되거나 provider
+호출로 바뀌지 않으며, 보관량은 64개로 제한된다.
+
+이 successor의 새 `records/`만 package 명령의 동일한 exact `--out` 및
+`--diff-exclude` 경로로 제외하고 `generatedPaths`에는 넣지 않는다. package round 0은
+audit-only base 이후의 아홉 제품·테스트 파일과 이 successor의 `task.json` 및
+`authorization.md`를 검토 diff로 포함해야 한다. 범위 밖 파일 변경이나 검사 실패는
+우회하지 않는다. 원 v1 package와 `records/`의 바이트 및 상태는 audit-only base에
+포함된 선행 기록으로 보존하며 successor 검토 diff나 out 경로로 다시 포함하지 않는다.
diff --git a/docs/ops/cross-review/packages/chat-saved-undispatched-disposition-followup-v2/task.json b/docs/ops/cross-review/packages/chat-saved-undispatched-disposition-followup-v2/task.json
new file mode 100644
index 000000000..ce91c9486
--- /dev/null
+++ b/docs/ops/cross-review/packages/chat-saved-undispatched-disposition-followup-v2/task.json
@@ -0,0 +1,30 @@
+{
+  "taskId": "chat-saved-undispatched-disposition-followup-v2",
+  "requirement": "종료된 chat-history-pagination-recovery-v1 exchange의 round 2 승인 verdict에 남은 대화 범위 notice 지적 두 건만 보완한다. Chat 전역 전송의 user Message가 durable 저장된 뒤 불완전한 history 때문에 provider dispatch 전 대화를 떠난 경우 prompt/admission/context를 보관하거나 자동 재전송하지 않고, 원래 identity와 conversation으로 돌아왔을 때만 saved-but-undispatched 안내를 표시한다. Review model-only 저장이 최신 run에 밀린 경우에도 같은 identity의 다른 conversation에는 안내를 노출하지 않고 원래 conversation에서만 표시한다. 기존 v1 exchange는 변경하지 않는다. 실제 provider 호출, 유료 실행, staging/production, flag 변경, push·merge·deploy는 범위 밖이다. author는 Codex, 독립 reviewer는 Cursor CLI다.",
+  "completionCriteria": [
+    "Chat 전역 prompt payload가 history failure 뒤 다른 conversation 선택으로 소멸하거나 durable Message commit 응답이 conversation/ticket 변경 뒤 늦게 도착해도, 답변 요청이 시작되지 않았다는 disposition을 identity와 originating conversation에만 결속한다. 다른 conversation에서는 toast를 표시하지 않고 원래 conversation 재선택 때 한 번 표시한다. same-conversation cleanup도 opaque disposition을 저장하되 exact durable payload가 mount된 responsive remount 동안만 소비를 보류하고, full unmount 또는 active-row 재선택으로 payload가 사라지면 한 번 소비한다. 최초 URL conversation handoff가 도달 성공, lock 취소, missing/unowned target 또는 fallback 선택으로 terminal된 뒤에는 frozen initial id가 이후 conversation의 disposition 소비를 막지 않으며 실제 in-flight handoff 동안만 transient conversation의 소비를 막는다. 새 conversation의 commit 응답은 기존 pending-adoption current 판정이 유지된다.",
+    "disposition에는 prompt text, attachment, admission token, context bundle 또는 provider 재실행 권한을 보관하지 않는다. conversation 전환 뒤 blind resend나 자동 provider POST를 만들지 않고 기존 savedQuestionNotSent의 reload 확인 문구를 사용한다.",
+    "Review model-only Message 저장이 최신 local run에 밀린 뒤 사용자가 같은 identity의 다른 conversation에 있어도 toast를 그 화면에 표시하지 않는다. Review 전역 composer의 durable commit도 모든 surface에서 캡처한 conversation과 committed selection ticket을 확인하므로 same-identity A→B→A 뒤 provider payload를 발행하지 않고 origin notice를 한 번 표시한다. 원래 conversation으로 돌아왔을 때만 한 번 표시하고, identity epoch가 바뀐 A→B 및 A→B→A의 늦은 durable callback은 같은 account key로 돌아왔더라도 notice 없이 폐기한다. callback authority는 active identity, namespace, submit-fence identity key 및 epoch를 모두 요구해 unresolved/loading 경계도 old identity를 승인하지 않는다. ChatPage가 완전히 unmount된 동안 identity가 바뀐 경우에도 sessionStorage owner marker가 mismatch disposition을 폐기하며 같은 identity remount만 복구한다. browser identity epoch는 layout commit에서만 채택하고 SSR에서는 module fence를 읽거나 쓰지 않는다.",
+    "desktop/mobile Chromium focused E2E가 유형별 계약을 검증한다. Chat/Review abandonment와 late global commit은 다른 conversation notice 0건, origin notice 1건, saved question provider POST 0건과 테스트가 확인하는 durable Message 1건을 검증한다. 같은 Chat의 full unmount와 active-row 재선택은 origin notice 1건·provider POST 0건을 검증하며, continuation New Chat은 loopback-only onBeforeModelSend barrier로 durable commit 이후 provider 전 경계를 고정해 재진입 notice 1건·provider POST 0건·durable Message 1건을 검증한다. Review와 continuation의 다중 panel은 첫 panel의 실제 provider POST 뒤 둘째 panel cleanup 순서를 고정해 provider POST 1건, savedQuestionNotSent notice 0건, persisted disposition 0건을 검증한다. lock 취소는 notice 0건, current conversation 불변 및 cleanup/remount 뒤 false notice 0건을 검증하고, locked initial URL 취소와 missing/unowned initial URL 뒤에는 다른 origin의 notice가 정상 소비됨을 검증한다. same-identity rapid conversation A→B→A는 origin notice 1건과 provider POST 0건을, identity A→B/A→B→A는 old identity notice 0건과 old prompt provider POST 0건을 검증한다. full-unmount A disposition→B mount→A mount는 old A notice와 provider POST 0건을 검증한다. async fixture는 고정 sleep 대신 response-settled 상태를 기다린다. bounded storage/identity unit, typecheck, 변경 범위 lint, production build 및 diff guard 결과를 정직하게 기록한다.",
+    "기존 chat-history-pagination-recovery-v1 exchange와 records는 on_hold(revisions_exhausted) 상태로 바이트 불변 보존하고 이 successor의 supersedes lineage가 그 exchange를 가리킨다.",
+    "새 package digest는 audit-only base bef622a565468fb9857639bc4ef24171c2c57a5f 이후 지정된 아홉 제품·테스트 파일과 이 task/authorization만 검토 변경으로 포함한다. 제품 source lineage는 그 base의 parent 93b18c8f37be46cbfce47658cc638e77aa008d63이며, audit-only base commit은 v1 authorization과 records만 추가한다. 이 successor의 생성 records 디렉터리만 동일한 exact out/diff-exclude로 제외하고 Cursor CLI verdict는 그 digest에 결속한다."
+  ],
+  "baseCommit": "bef622a565468fb9857639bc4ef24171c2c57a5f",
+  "writableScope": [
+    "app/(site)/(application)/chat/ChatPageClient.tsx",
+    "components/chat/ChatApp.tsx",
+    "components/chat/DesktopChatShell.tsx",
+    "components/chat/MobileChatShell.tsx",
+    "lib/chatIdentityEpoch.ts",
+    "lib/chatSavedQuestionDisposition.ts",
+    "tests/chatIdentityEpoch.test.mjs",
+    "tests/chatSavedQuestionDisposition.test.mjs",
+    "tests/e2e/chat-unified-workspace.spec.ts",
+    "docs/ops/cross-review/packages/chat-saved-undispatched-disposition-followup-v2"
+  ],
+  "generatedPaths": [],
+  "supersedes": {
+    "taskId": "chat-history-pagination-recovery-v1",
+    "exchange": "docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/records/exchange.json"
+  }
+}
diff --git a/lib/chatIdentityEpoch.ts b/lib/chatIdentityEpoch.ts
new file mode 100644
index 000000000..14e0f7676
--- /dev/null
+++ b/lib/chatIdentityEpoch.ts
@@ -0,0 +1,66 @@
+export type ChatIdentityFence = {
+  identityKey: string | null;
+  epoch: number;
+};
+
+const SERVER_IDENTITY_FENCE: ChatIdentityFence = {
+  identityKey: null,
+  epoch: 0,
+};
+
+let chatIdentityEpochSequence = 0;
+let activeChatIdentityFence: ChatIdentityFence = SERVER_IDENTITY_FENCE;
+
+const allocateChatIdentityEpoch = (): number => {
+  chatIdentityEpochSequence += 1;
+  return chatIdentityEpochSequence;
+};
+
+/**
+ * Adopts the browser realm's current Chat identity after React commits.
+ *
+ * Server rendering deliberately neither reads nor mutates the browser fence:
+ * two concurrent SSR requests share a module instance and must not be able to
+ * observe one another's account namespace.
+ */
+export const adoptActiveChatIdentity = (
+  identityKey: string | null
+): ChatIdentityFence => {
+  if (typeof window === "undefined") return SERVER_IDENTITY_FENCE;
+  // Session loading is not an identity transition. Retain the active epoch so
+  // a same-account cross-surface remount can adopt it once the session settles.
+  if (identityKey === null) return activeChatIdentityFence;
+  if (activeChatIdentityFence.identityKey === identityKey) {
+    return activeChatIdentityFence;
+  }
+  activeChatIdentityFence = {
+    identityKey,
+    epoch: allocateChatIdentityEpoch(),
+  };
+  return activeChatIdentityFence;
+};
+
+export const activeChatIdentityIs = (
+  identityKey: string,
+  epoch: number
+): boolean => {
+  if (typeof window === "undefined") return false;
+  return activeChatIdentityFence.identityKey === identityKey &&
+    activeChatIdentityFence.epoch === epoch;
+};
+
+export const chatIdentityCallbackIsCurrent = ({
+  originIdentityKey,
+  originIdentityEpoch,
+  currentNamespaceKey,
+  submitFence,
+}: {
+  originIdentityKey: string;
+  originIdentityEpoch: number;
+  currentNamespaceKey: string;
+  submitFence: ChatIdentityFence;
+}): boolean =>
+  activeChatIdentityIs(originIdentityKey, originIdentityEpoch) &&
+  currentNamespaceKey === originIdentityKey &&
+  submitFence.identityKey === originIdentityKey &&
+  submitFence.epoch === originIdentityEpoch;
diff --git a/lib/chatSavedQuestionDisposition.ts b/lib/chatSavedQuestionDisposition.ts
new file mode 100644
index 000000000..3bb56ec43
--- /dev/null
+++ b/lib/chatSavedQuestionDisposition.ts
@@ -0,0 +1,223 @@
+export const SAVED_QUESTION_NOT_SENT_LIMIT = 64;
+export const SAVED_QUESTION_NOT_SENT_STORAGE_KEY =
+  "tomverse_saved_question_not_sent_dispositions_v1";
+export const SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY =
+  "tomverse_saved_question_not_sent_owner_v1";
+export const SAVED_QUESTION_NOT_SENT_CHANGE_EVENT =
+  "tomverse:saved-question-not-sent-dispositions-change";
+
+type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
+
+type StoredKeys = {
+  available: boolean;
+  keys: Set<string>;
+};
+
+const MAX_OWNER_KEY_LENGTH = 256;
+
+const boundedKeys = (keys: Iterable<string>): Set<string> =>
+  new Set([...keys].slice(-SAVED_QUESTION_NOT_SENT_LIMIT));
+
+const replaceMemory = (memory: Set<string>, keys: Iterable<string>): void => {
+  memory.clear();
+  for (const key of boundedKeys(keys)) memory.add(key);
+};
+
+const readStoredKeys = (storage: StorageLike | null): StoredKeys => {
+  if (!storage) return { available: false, keys: new Set() };
+  let raw: string | null;
+  try {
+    raw = storage.getItem(SAVED_QUESTION_NOT_SENT_STORAGE_KEY);
+  } catch {
+    return { available: false, keys: new Set() };
+  }
+  try {
+    const parsed = JSON.parse(raw ?? "[]");
+    if (!Array.isArray(parsed)) return { available: true, keys: new Set() };
+    return {
+      available: true,
+      keys: boundedKeys(parsed.filter((item): item is string =>
+        typeof item === "string" && item.length > 0 && item.length <= 512
+      )),
+    };
+  } catch {
+    // A readable but malformed value is authoritative corruption, not a cue
+    // to merge an older memory snapshot back into storage.
+    return { available: true, keys: new Set() };
+  }
+};
+
+const persistKeys = (storage: StorageLike | null, keys: Set<string>): void => {
+  if (!storage) return;
+  try {
+    if (keys.size === 0) {
+      storage.removeItem(SAVED_QUESTION_NOT_SENT_STORAGE_KEY);
+    } else {
+      storage.setItem(
+        SAVED_QUESTION_NOT_SENT_STORAGE_KEY,
+        JSON.stringify([...keys])
+      );
+    }
+  } catch {
+    // The bounded in-memory set remains the tab's best available record.
+  }
+};
+
+/**
+ * Mutate the latest storage value and then replace, rather than merge, the
+ * caller's cached set. A late closure can therefore neither overwrite a key
+ * written by a newer tree nor resurrect a key that tree already consumed.
+ */
+const mutateKeys = (
+  memory: Set<string>,
+  storage: StorageLike | null,
+  mutation: (keys: Set<string>) => boolean
+): boolean => {
+  const stored = readStoredKeys(storage);
+  const next = stored.available ? stored.keys : boundedKeys(memory);
+  const changed = mutation(next);
+  const bounded = boundedKeys(next);
+  persistKeys(storage, bounded);
+  replaceMemory(memory, bounded);
+  return changed;
+};
+
+export const addSavedQuestionNotSentKey = (
+  memory: Set<string>,
+  storage: StorageLike | null,
+  key: string
+): boolean => mutateKeys(memory, storage, (keys) => {
+  const existed = keys.delete(key);
+  keys.add(key);
+  return !existed;
+});
+
+export const addSavedQuestionNotSentKeys = (
+  memory: Set<string>,
+  storage: StorageLike | null,
+  additions: Iterable<string>
+): boolean => mutateKeys(memory, storage, (keys) => {
+  let added = false;
+  for (const key of additions) {
+    const existed = keys.delete(key);
+    keys.add(key);
+    added ||= !existed;
+  }
+  return added;
+});
+
+export const removeSavedQuestionNotSentTurn = (
+  memory: Set<string>,
+  storage: StorageLike | null,
+  turnId: string
+): boolean => {
+  const suffix = `\0${turnId}`;
+  return mutateKeys(memory, storage, (keys) => {
+    let removed = false;
+    for (const key of keys) {
+      if (!key.endsWith(suffix)) continue;
+      keys.delete(key);
+      removed = true;
+    }
+    return removed;
+  });
+};
+
+export const removeSavedQuestionNotSentKey = (
+  memory: Set<string>,
+  storage: StorageLike | null,
+  key: string
+): boolean => mutateKeys(memory, storage, (keys) => keys.delete(key));
+
+export const consumeSavedQuestionNotSentPrefix = (
+  memory: Set<string>,
+  storage: StorageLike | null,
+  identityKey: string,
+  conversationId: string,
+  preserveKey: string | null = null
+): boolean => {
+  const prefix = `${identityKey}\0${conversationId}\0`;
+  return mutateKeys(memory, storage, (keys) => {
+    let consumed = false;
+    for (const key of keys) {
+      if (!key.startsWith(prefix)) continue;
+      if (key === preserveKey) continue;
+      keys.delete(key);
+      consumed = true;
+    }
+    return consumed;
+  });
+};
+
+/** Identity boundaries are an intentional full clear, never a merge. */
+export const clearSavedQuestionNotSentKeys = (
+  memory: Set<string>,
+  storage: StorageLike | null
+): void => {
+  memory.clear();
+  if (!storage) return;
+  try {
+    storage.removeItem(SAVED_QUESTION_NOT_SENT_STORAGE_KEY);
+  } catch {
+    // Memory is still cleared even when tab storage is unavailable.
+  }
+};
+
+export const readSavedQuestionNotSentKeySet = (
+  memory: Set<string>,
+  storage: StorageLike | null
+): Set<string> => {
+  const stored = readStoredKeys(storage);
+  if (stored.available) replaceMemory(memory, stored.keys);
+  return new Set(memory);
+};
+
+/**
+ * Bind persisted dispositions to the identity that owns this full page tree.
+ *
+ * sessionStorage survives a full reload while React refs do not. A fresh B
+ * tree must therefore clear A's opaque dispositions even though it has no
+ * in-memory transition to observe. A same-identity reload preserves them.
+ * The marker contains only the already-used identity namespace key, is
+ * bounded, and carries no prompt, attachment or execution authority.
+ */
+export const bindSavedQuestionNotSentOwner = (
+  memory: Set<string>,
+  storage: StorageLike | null,
+  identityKey: string
+): boolean => {
+  if (!storage || !identityKey || identityKey.length > MAX_OWNER_KEY_LENGTH) {
+    clearSavedQuestionNotSentKeys(memory, storage);
+    return false;
+  }
+  let owner: string | null;
+  try {
+    owner = storage.getItem(SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY);
+  } catch {
+    return false;
+  }
+  if (owner === identityKey) return true;
+
+  clearSavedQuestionNotSentKeys(memory, storage);
+  try {
+    storage.setItem(SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY, identityKey);
+  } catch {
+    // The in-memory clear still prevents this tree from exposing stale data.
+  }
+  return false;
+};
+
+export const setBoundedMapEntry = <K, V>(
+  map: Map<K, V>,
+  key: K,
+  value: V,
+  limit = SAVED_QUESTION_NOT_SENT_LIMIT
+): void => {
+  map.delete(key);
+  map.set(key, value);
+  while (map.size > limit) {
+    const oldest = map.keys().next().value as K | undefined;
+    if (oldest === undefined) break;
+    map.delete(oldest);
+  }
+};
diff --git a/tests/chatIdentityEpoch.test.mjs b/tests/chatIdentityEpoch.test.mjs
new file mode 100644
index 000000000..9c9ee5248
--- /dev/null
+++ b/tests/chatIdentityEpoch.test.mjs
@@ -0,0 +1,58 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+
+import {
+  activeChatIdentityIs,
+  adoptActiveChatIdentity,
+  chatIdentityCallbackIsCurrent,
+} from "../lib/chatIdentityEpoch.ts";
+
+test("SSR identity adoption is inert across sequential and concurrent requests", async () => {
+  assert.equal(typeof globalThis.window, "undefined");
+
+  assert.deepEqual(adoptActiveChatIdentity("account:ssr-a"), {
+    identityKey: null,
+    epoch: 0,
+  });
+  assert.deepEqual(
+    await Promise.all([
+      Promise.resolve().then(() => adoptActiveChatIdentity("account:ssr-a")),
+      Promise.resolve().then(() => adoptActiveChatIdentity("account:ssr-b")),
+    ]),
+    [
+      { identityKey: null, epoch: 0 },
+      { identityKey: null, epoch: 0 },
+    ]
+  );
+  assert.equal(activeChatIdentityIs("account:ssr-a", 1), false);
+
+  globalThis.window = {};
+  try {
+    const browserA = adoptActiveChatIdentity("account:browser-a");
+    assert.equal(browserA.epoch, 1, "SSR calls must not consume a browser epoch");
+    assert.equal(activeChatIdentityIs("account:browser-a", browserA.epoch), true);
+  } finally {
+    delete globalThis.window;
+  }
+});
+
+test("an unresolved submit fence cannot authorize an old identity callback", () => {
+  globalThis.window = {};
+  try {
+    const browserA = adoptActiveChatIdentity("account:callback-a");
+    assert.equal(chatIdentityCallbackIsCurrent({
+      originIdentityKey: "account:callback-a",
+      originIdentityEpoch: browserA.epoch,
+      currentNamespaceKey: "account:callback-a",
+      submitFence: { identityKey: null, epoch: browserA.epoch },
+    }), false);
+    assert.equal(chatIdentityCallbackIsCurrent({
+      originIdentityKey: "account:callback-a",
+      originIdentityEpoch: browserA.epoch,
+      currentNamespaceKey: "account:callback-a",
+      submitFence: browserA,
+    }), true);
+  } finally {
+    delete globalThis.window;
+  }
+});
diff --git a/tests/chatSavedQuestionDisposition.test.mjs b/tests/chatSavedQuestionDisposition.test.mjs
new file mode 100644
index 000000000..7fe62fd18
--- /dev/null
+++ b/tests/chatSavedQuestionDisposition.test.mjs
@@ -0,0 +1,185 @@
+import assert from "node:assert/strict";
+import { test } from "node:test";
+import {
+  SAVED_QUESTION_NOT_SENT_LIMIT,
+  SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY,
+  SAVED_QUESTION_NOT_SENT_STORAGE_KEY,
+  addSavedQuestionNotSentKey,
+  bindSavedQuestionNotSentOwner,
+  clearSavedQuestionNotSentKeys,
+  consumeSavedQuestionNotSentPrefix,
+  removeSavedQuestionNotSentKey,
+  setBoundedMapEntry,
+} from "../lib/chatSavedQuestionDisposition.ts";
+
+const storageFixture = (initial = [], owner = null) => {
+  const values = new Map();
+  if (initial.length > 0) {
+    values.set(SAVED_QUESTION_NOT_SENT_STORAGE_KEY, JSON.stringify(initial));
+  }
+  if (owner) values.set(SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY, owner);
+  return {
+    getItem: (key) => values.get(key) ?? null,
+    setItem: (key, value) => values.set(key, value),
+    removeItem: (key) => values.delete(key),
+    keys: () => JSON.parse(values.get(SAVED_QUESTION_NOT_SENT_STORAGE_KEY) ?? "[]"),
+    owner: () => values.get(SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY) ?? null,
+  };
+};
+
+test("adding before local hydration preserves dispositions already in storage", () => {
+  const a = "account:a\0conversation-a\0turn-a";
+  const b = "account:a\0conversation-b\0turn-b";
+  const storage = storageFixture([a]);
+  const memory = new Set();
+
+  addSavedQuestionNotSentKey(memory, storage, b);
+
+  assert.deepEqual(storage.keys(), [a, b]);
+  assert.deepEqual([...memory], [a, b]);
+});
+
+test("a stale memory snapshot cannot resurrect a consumed disposition", () => {
+  const consumed = "account:a\0conversation-a\0turn-a";
+  const current = "account:a\0conversation-b\0turn-b";
+  const late = "account:a\0conversation-c\0turn-c";
+  const storage = storageFixture([current]);
+  const staleMemory = new Set([consumed]);
+
+  addSavedQuestionNotSentKey(staleMemory, storage, late);
+
+  assert.deepEqual(storage.keys(), [current, late]);
+  assert.equal(staleMemory.has(consumed), false);
+});
+
+test("malformed readable storage does not revive stale memory", () => {
+  const values = new Map([[SAVED_QUESTION_NOT_SENT_STORAGE_KEY, "not-json"]]);
+  const storage = {
+    getItem: (key) => values.get(key) ?? null,
+    setItem: (key, value) => values.set(key, value),
+    removeItem: (key) => values.delete(key),
+  };
+  const memory = new Set(["account:a\0conversation-old\0turn-old"]);
+  const current = "account:a\0conversation-new\0turn-new";
+  addSavedQuestionNotSentKey(memory, storage, current);
+  assert.deepEqual(
+    JSON.parse(values.get(SAVED_QUESTION_NOT_SENT_STORAGE_KEY)),
+    [current]
+  );
+  assert.deepEqual([...memory], [current]);
+});
+
+test("storage and memory remain bounded to the newest 64 opaque keys", () => {
+  const storage = storageFixture();
+  const memory = new Set();
+  for (let index = 0; index < 80; index += 1) {
+    addSavedQuestionNotSentKey(
+      memory,
+      storage,
+      `account:a\0conversation-a\0turn-${index}`
+    );
+  }
+
+  assert.equal(memory.size, SAVED_QUESTION_NOT_SENT_LIMIT);
+  assert.equal(storage.keys().length, SAVED_QUESTION_NOT_SENT_LIMIT);
+  assert.equal(memory.has("account:a\0conversation-a\0turn-15"), false);
+  assert.equal(memory.has("account:a\0conversation-a\0turn-16"), true);
+});
+
+test("consume and provider-start removal apply to the exact latest storage set", () => {
+  const a1 = "account:a\0conversation-a\0turn-1";
+  const a2 = "account:a\0conversation-a\0turn-2";
+  const b1 = "account:a\0conversation-b\0turn-1";
+  const storage = storageFixture([a1, a2, b1]);
+  const memory = new Set(["stale"]);
+
+  assert.equal(
+    consumeSavedQuestionNotSentPrefix(memory, storage, "account:a", "conversation-a"),
+    true
+  );
+  assert.deepEqual(storage.keys(), [b1]);
+  assert.equal(removeSavedQuestionNotSentKey(memory, storage, b1), true);
+  assert.deepEqual(storage.keys(), []);
+  assert.deepEqual([...memory], []);
+});
+
+test("consume preserves the exact disposition for a still-mounted undispatched payload", () => {
+  const protectedKey = "account:a\0conversation-a\0turn-active";
+  const abandonedKey = "account:a\0conversation-a\0turn-abandoned";
+  const storage = storageFixture([protectedKey, abandonedKey]);
+  const memory = new Set();
+
+  assert.equal(
+    consumeSavedQuestionNotSentPrefix(
+      memory,
+      storage,
+      "account:a",
+      "conversation-a",
+      protectedKey
+    ),
+    true
+  );
+  assert.deepEqual(storage.keys(), [protectedKey]);
+  assert.deepEqual([...memory], [protectedKey]);
+  assert.equal(
+    consumeSavedQuestionNotSentPrefix(
+      memory,
+      storage,
+      "account:a",
+      "conversation-a",
+      protectedKey
+    ),
+    false
+  );
+});
+
+test("identity clear never merges a stale storage value", () => {
+  const storage = storageFixture(["account:a\0conversation-a\0turn-1"]);
+  const memory = new Set(["memory-only"]);
+  clearSavedQuestionNotSentKeys(memory, storage);
+  assert.deepEqual(storage.keys(), []);
+  assert.equal(memory.size, 0);
+});
+
+test("the pending registry evicts oldest entries deterministically", () => {
+  const pending = new Map();
+  for (let index = 0; index < 80; index += 1) {
+    setBoundedMapEntry(pending, `turn-${index}`, { index });
+  }
+  assert.equal(pending.size, SAVED_QUESTION_NOT_SENT_LIMIT);
+  assert.equal(pending.has("turn-15"), false);
+  assert.deepEqual(pending.get("turn-16"), { index: 16 });
+});
+
+test("a same-identity full reload preserves opaque dispositions", () => {
+  const key = "account:a\0conversation-a\0turn-a";
+  const storage = storageFixture([key], "account:a");
+  const memory = new Set();
+
+  assert.equal(bindSavedQuestionNotSentOwner(memory, storage, "account:a"), true);
+  assert.deepEqual(storage.keys(), [key]);
+  assert.equal(storage.owner(), "account:a");
+});
+
+test("a different-identity full mount clears dispositions and rebinds owner", () => {
+  const storage = storageFixture(
+    ["account:a\0conversation-a\0turn-a"],
+    "account:a"
+  );
+  const memory = new Set(["stale-memory"]);
+
+  assert.equal(bindSavedQuestionNotSentOwner(memory, storage, "account:b"), false);
+  assert.deepEqual(storage.keys(), []);
+  assert.equal(storage.owner(), "account:b");
+  assert.equal(memory.size, 0);
+});
+
+test("an unowned or oversized owner marker fails closed", () => {
+  const storage = storageFixture(["account:a\0conversation-a\0turn-a"]);
+  const memory = new Set(["stale-memory"]);
+
+  assert.equal(bindSavedQuestionNotSentOwner(memory, storage, "x".repeat(257)), false);
+  assert.deepEqual(storage.keys(), []);
+  assert.equal(storage.owner(), null);
+  assert.equal(memory.size, 0);
+});
diff --git a/tests/e2e/chat-unified-workspace.spec.ts b/tests/e2e/chat-unified-workspace.spec.ts
index 0babd23af..fdab753ca 100644
--- a/tests/e2e/chat-unified-workspace.spec.ts
+++ b/tests/e2e/chat-unified-workspace.spec.ts
@@ -66,7 +66,7 @@ type ConversationFixture = {
   selectedModels: string[];
   messages: QaConversationMessage[];
   productKey: "chat" | "review";
-  surface: "chat" | "workspace";
+  surface: "chat" | "workspace" | "continuation";
 };
 
 type DraftFixture = {
@@ -300,6 +300,7 @@ async function openChat(page: Page, options: {
   contextBundles?: Array<string | null>;
   sharedDrafts?: Map<string, DraftFixture>;
   legacyReview?: boolean;
+  continuation?: boolean;
   messageSaveFailure?: boolean;
   messageSaveFailureOnce?: boolean;
   messageSaveFailureStatus?: number;
@@ -308,6 +309,9 @@ async function openChat(page: Page, options: {
   messageSaveBodyStall?: boolean;
   holdMessageSaveBeforeTransaction?: boolean;
   holdFirstMessageSaveBeforeTransaction?: boolean;
+  holdMessageSaveResponseAfterCommit?: boolean;
+  holdBeforeModelSendAfterPayload?: boolean;
+  holdBeforeModelSendAfterPayloadOnCall?: number;
   messageReceiptUnavailable?: boolean;
   messageReceiptResponseBody?: unknown;
   messageReceiptBodyStall?: boolean;
@@ -322,6 +326,9 @@ async function openChat(page: Page, options: {
   malformedFirstHistoryPageOnRead?: number;
   malformedDraftRead?: boolean;
   invalidDraftAttachmentRead?: boolean;
+  lockedSecondConversation?: boolean;
+  lockedInitialConversation?: boolean;
+  initialConversationId?: string;
   draftFailurePlan?: Array<{ method: string; scopeKey: string }>;
 } = {}) {
   await prepareGuestPage(page, "en");
@@ -347,8 +354,12 @@ async function openChat(page: Page, options: {
   }]);
   const conversations: ConversationFixture[] = [{
     id: CONVERSATION, title: "QA unified Chat", selectedModels: options.selectedModels ?? [MODEL_A],
-    productKey: options.legacyReview ? "review" : "chat",
-    surface: options.legacyReview ? "workspace" : "chat",
+    productKey: options.legacyReview || options.continuation ? "review" : "chat",
+    surface: options.continuation
+      ? "continuation"
+      : options.legacyReview
+        ? "workspace"
+        : "chat",
     messages: options.messages ?? [
       { id: "seed-u", role: "user", content: "A prior question." },
       { id: "seed-a", role: "assistant", content: FIRST_ANSWER, modelId: MODEL_A, status: "normal" },
@@ -387,11 +398,14 @@ async function openChat(page: Page, options: {
   let draftFailuresReturned = 0;
   let draftMutationStarted = false;
   let messageSaveStarted = false;
+  let messageSaveCommitted = false;
+  let messageSaveResponseSettledCount = 0;
   let messageSaveCount = 0;
   let messageReceiptStarted = false;
   let releaseDraftHydrate = () => {};
   let releaseDraftMutation = () => {};
   let releaseMessageSave = () => {};
+  let releaseMessageSaveResponse = () => {};
   let releaseMessageReceipt = () => {};
   const draftHydrateGate = new Promise<void>((resolve) => {
     releaseDraftHydrate = resolve;
@@ -402,6 +416,9 @@ async function openChat(page: Page, options: {
   const messageSaveGate = new Promise<void>((resolve) => {
     releaseMessageSave = resolve;
   });
+  const messageSaveResponseGate = new Promise<void>((resolve) => {
+    releaseMessageSaveResponse = resolve;
+  });
   const messageReceiptGate = new Promise<void>((resolve) => {
     releaseMessageReceipt = resolve;
   });
@@ -414,6 +431,7 @@ async function openChat(page: Page, options: {
   let historyCursorReadCount = 0;
   let firstHistoryPageReadCount = 0;
   let historyPageFailureStarted = false;
+  let contextBundleResponseSettled = false;
   let releaseHistoryPageFailure = () => {};
   const historyPageFailureGate = new Promise<void>((resolve) => {
     releaseHistoryPageFailure = resolve;
@@ -421,9 +439,19 @@ async function openChat(page: Page, options: {
   const payload = (row: ConversationFixture) => ({
     ...row, disabledPanels: options.disabledPanels ?? [], webSearchMode: "off", memoryMode: "inherit",
     selectionMode: "manual", autoSelection: { offered: false },
-    assistantProfile: null, isLocked: false, shareEnabled: false, nextCursor: null,
+    assistantProfile: null,
+    isLocked: (options.lockedSecondConversation && row.id === SECOND_CONVERSATION) ||
+      (options.lockedInitialConversation && row.id === CONVERSATION),
+    shareEnabled: false, nextCursor: null,
     responseAttempts,
   });
+  const settleMessageSaveResponse = async (operation: Promise<void>) => {
+    try {
+      await operation;
+    } finally {
+      messageSaveResponseSettledCount += 1;
+    }
+  };
   await page.route(/\/api\/products\/chat\/attempts\/[^?]+(?:\?.*)?$/, async (route) => {
     attemptReadCount += 1;
     const forcedFailure = attemptPollFailures.shift();
@@ -657,10 +685,10 @@ async function openChat(page: Page, options: {
         (options.messageSaveFailureOnce && !messageSaveFailureReturned)
       ) {
         messageSaveFailureReturned = true;
-        return route.fulfill({
+        return settleMessageSaveResponse(route.fulfill({
           status: options.messageSaveFailureStatus ?? 500,
           json: { code: "QA_MESSAGE_SAVE_FAILED" },
-        });
+        }));
       }
       // A mock of the server's ordered restored-reference response, not proof
       // of object copying or DB atomicity. Those require the separate real-DB
@@ -719,10 +747,14 @@ async function openChat(page: Page, options: {
           draftConsumed = true;
         }
       }
+      messageSaveCommitted = true;
+      if (options.holdMessageSaveResponseAfterCommit) {
+        await messageSaveResponseGate;
+      }
       if (options.messageSaveResponseLostAfterCommit) {
-        return route.abort("failed");
+        return settleMessageSaveResponse(route.abort("failed"));
       }
-      return route.fulfill({ status: 201, json:
+      return settleMessageSaveResponse(route.fulfill({ status: 201, json:
         options.messageSaveResponseBody ?? {
           success: true,
           created: 1,
@@ -730,7 +762,7 @@ async function openChat(page: Page, options: {
           attachments: bound,
           draftConsumed,
         }
-      });
+      }));
     }
     if (method === "PATCH" && Array.isArray(body.selectedModels)) row.selectedModels = body.selectedModels as string[];
     if (method === "GET") historyReads.push(url.pathname + url.search);
@@ -762,6 +794,33 @@ async function openChat(page: Page, options: {
       ? { ...payload(row), messagePage: { hasMore: false, nextCursor: null } }
       : payload(row) });
   });
+  if (options.continuation) {
+    await page.route(
+      `**/api/conversations/${CONVERSATION}/continuation*`,
+      (route) => route.fulfill({ json: {
+        conversationId: CONVERSATION,
+        provider: "chatgpt",
+        importedAt: "2026-09-01T00:00:00.000Z",
+        contextSeedVersion: "qa-continuation-seed-v1",
+        seed: {
+          messageCount: 0,
+          truncatedMessageCount: 0,
+          omittedMessageCount: 0,
+          fromOrdinal: 0,
+          toOrdinal: 0,
+        },
+        source: {
+          status: "available",
+          externalConversationId: "qa-external-conversation",
+          title: "QA imported source",
+          messageTotal: 0,
+          offset: 0,
+          limit: 100,
+          messages: [],
+        },
+      } })
+    );
+  }
   // No title generation, provider operation or real ownership mutation escapes
   // the fabricated routes, even if a regression calls an unexpected endpoint.
   await page.route("**/api/conversations/*/generate-title", (route) => route.fulfill({ json: { title: "QA Chat" } }));
@@ -770,10 +829,11 @@ async function openChat(page: Page, options: {
   await page.route("**/api/chat/context", (route) => {
     if (options.holdContextBundleOnce && contextBundleRead === 0) {
       contextBundleStarted = true;
-      return contextBundleGate.then(() => {
+      return contextBundleGate.then(async () => {
         contextBundleRead += 1;
-        return route.fulfill({ json: { ok: true, contextBundle: options.contextBundle ?? null,
+        await route.fulfill({ json: { ok: true, contextBundle: options.contextBundle ?? null,
           memoryUsedCount: 0 } });
+        contextBundleResponseSettled = true;
       });
     }
     const bundles = options.contextBundles;
@@ -799,22 +859,47 @@ async function openChat(page: Page, options: {
       window.__tomverseChatMessageDeadlineMs = deadlineMs;
     }, options.messageDeadlineMs);
   }
+  if (options.holdBeforeModelSendAfterPayload ||
+      options.holdBeforeModelSendAfterPayloadOnCall !== undefined) {
+    await page.addInitScript((holdOnCall) => {
+      const target = window as unknown as {
+        __tomverseChatBeforeModelSendGate?: Promise<void>;
+        __tomverseReleaseChatBeforeModelSend?: () => void;
+        __tomverseChatBeforeModelSendStarted?: boolean;
+        __tomverseChatBeforeModelSendCallCount?: number;
+        __tomverseChatBeforeModelSendHoldOnCall?: number;
+      };
+      target.__tomverseChatBeforeModelSendGate = new Promise<void>((resolve) => {
+        target.__tomverseReleaseChatBeforeModelSend = resolve;
+      });
+      target.__tomverseChatBeforeModelSendStarted = false;
+      target.__tomverseChatBeforeModelSendCallCount = 0;
+      target.__tomverseChatBeforeModelSendHoldOnCall = holdOnCall;
+    }, options.holdBeforeModelSendAfterPayloadOnCall);
+  }
   await page.setViewportSize(options.viewport ?? DESKTOP_VIEWPORT);
-  const workspacePath = options.legacyReview ? "/chat" : "/chat/workspace";
-  await page.goto(`${workspacePath}?lang=en${options.fresh ? "" : `&conversation=${CONVERSATION}`}`);
+  const workspacePath = options.continuation
+    ? `/continuations/${CONVERSATION}`
+    : options.legacyReview
+      ? "/chat"
+      : "/chat/workspace";
+  const initialConversationId = options.initialConversationId ?? CONVERSATION;
+  await page.goto(`${workspacePath}?lang=en${options.fresh ? "" : `&conversation=${initialConversationId}`}`);
   await expect(page.getByTestId("chat-textarea")).toBeVisible();
-  if (!options.fresh) {
+  if (!options.fresh && !options.lockedInitialConversation &&
+      conversations.some((conversation) => conversation.id === initialConversationId)) {
     // The server-rendered panel can already show history one commit before
     // ChatPageClient finishes adopting the URL conversation as the composer
     // scope. Tests that start an upload in that gap would correctly bind it
     // to `new`, then accidentally assert behavior for the stored conversation.
     await expect.poll(() => page.evaluate(() =>
       window.sessionStorage.getItem("tomverse_active_chat_id")
-    )).toBe(CONVERSATION);
+    )).toBe(initialConversationId);
   }
   return {
     conversations, writes, historyReads, userSettingsWrites, drafts,
     contextBundleStarted: () => contextBundleStarted,
+    contextBundleResponseSettled: () => contextBundleResponseSettled,
     releaseContextBundle,
     historyPageFailureStarted: () => historyPageFailureStarted,
     releaseHistoryPageFailure,
@@ -843,11 +928,22 @@ async function openChat(page: Page, options: {
     draftHydrateStarted: () => draftHydrateStarted,
     draftMutationStarted: () => draftMutationStarted,
     messageSaveStarted: () => messageSaveStarted,
+    messageSaveCommitted: () => messageSaveCommitted,
+    messageSaveResponseSettledCount: () => messageSaveResponseSettledCount,
     messageReceiptStarted: () => messageReceiptStarted,
     releaseDraftHydrate,
     releaseDraftMutation,
     releaseMessageSave,
+    releaseMessageSaveResponse,
     releaseMessageReceipt,
+    beforeModelSendStarted: () => page.evaluate(() => Boolean(
+      (window as unknown as { __tomverseChatBeforeModelSendStarted?: boolean })
+        .__tomverseChatBeforeModelSendStarted
+    )),
+    releaseBeforeModelSend: () => page.evaluate(() => {
+      (window as unknown as { __tomverseReleaseChatBeforeModelSend?: () => void })
+        .__tomverseReleaseChatBeforeModelSend?.();
+    }),
   };
 }
 
@@ -871,6 +967,15 @@ async function chooseConversation(page: Page, conversationId: string) {
   ).click();
 }
 
+async function chooseNewChat(page: Page) {
+  const mobileShell = page.getByTestId("mobile-chat-shell");
+  if (await mobileShell.isVisible()) {
+    await page.getByTestId("mobile-sidebar-open").click();
+    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
+  }
+  await page.getByTestId("sidebar-new-chat").click();
+}
+
 async function switchToFixtureAccountB(
   page: Page,
   state: Awaited<ReturnType<typeof openChat>>
@@ -1876,7 +1981,7 @@ test.describe("Chat unified workspace", { tag: "@ui-risk" }, () => {
     await expect.poll(state.historyPageFailureStarted).toBe(true);
 
     state.releaseContextBundle();
-    await page.waitForTimeout(200);
+    await expect.poll(state.contextBundleResponseSettled).toBe(true);
     await expect(page.getByTestId("app-toast").filter({ hasText: "Your conversations are safe." }))
       .toHaveCount(0);
     expect(await persistentChatPostCount(page)).toBe(0);
@@ -1918,7 +2023,7 @@ test.describe("Chat unified workspace", { tag: "@ui-risk" }, () => {
     await expect.poll(state.historyPageFailureStarted).toBe(true);
 
     state.releaseMessageSave();
-    await page.waitForTimeout(200);
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
     expect(await persistentChatPostCount(page)).toBe(0);
     state.releaseHistoryPageFailure();
     await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
@@ -1934,6 +2039,502 @@ test.describe("Chat unified workspace", { tag: "@ui-risk" }, () => {
     await drive(page, 0, "finish");
   });
 
+  test("an undispatched saved Chat Message is reported only on its originating conversation", async ({ page }, testInfo) => {
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const remountViewport = testInfo.project.name.includes("mobile")
+      ? DESKTOP_VIEWPORT
+      : MOBILE_VIEWPORT;
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `abandoned-user-${index}`, role: "user", content: `Abandoned question ${index + 1}.` },
+      { id: `abandoned-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Abandoned answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const prompt = "Keep the accepted turn tied to this conversation.";
+    const state = await openChat(page, {
+      viewport,
+      messages: savedMessages,
+      holdMessageSaveBeforeTransaction: true,
+      historyPageFailureOnCursorRead: 2,
+      holdHistoryPageFailure: true,
+    });
+    await expect(message(page, "Abandoned answer 26.")).toBeVisible();
+    await submitComposer(page, prompt, viewport.width);
+    await expect.poll(state.messageSaveStarted).toBe(true);
+    await page.setViewportSize(remountViewport);
+    await page.setViewportSize(viewport);
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+
+    state.releaseMessageSave();
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    state.releaseHistoryPageFailure();
+    await expect(page.getByTestId("chat-history-load-error")).toBeVisible();
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: "Your question was saved, but no answer request was sent.",
+    })).toHaveCount(0);
+    expect(await persistentChatPostCount(page)).toBe(0);
+
+    await chooseConversation(page, CONVERSATION);
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: "Your question was saved, but no answer request was sent.",
+    })).toBeVisible();
+    await expect(message(page, prompt)).toHaveCount(1);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(1);
+    await page.reload();
+    await expect(message(page, prompt)).toHaveCount(1);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: "Your question was saved, but no answer request was sent.",
+    })).toHaveCount(0);
+  });
+
+  test("a full Chat unmount preserves one saved-undispatched notice for the same conversation", async ({ page }, testInfo) => {
+    const savedNoticeCopy = /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./;
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const remountViewport = testInfo.project.name.includes("mobile")
+      ? DESKTOP_VIEWPORT
+      : MOBILE_VIEWPORT;
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `unmount-user-${index}`, role: "user", content: `Unmount question ${index + 1}.` },
+      { id: `unmount-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Unmount answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const prompt = "Keep this durable turn across a full Chat unmount.";
+    const state = await openChat(page, {
+      viewport,
+      messages: savedMessages,
+      holdMessageSaveBeforeTransaction: true,
+      historyPageFailureOnCursorRead: 2,
+      holdHistoryPageFailure: true,
+    });
+    await expect(message(page, "Unmount answer 26.")).toBeVisible();
+    await submitComposer(page, prompt, viewport.width);
+    await expect.poll(state.messageSaveStarted).toBe(true);
+    await page.setViewportSize(remountViewport);
+    await page.setViewportSize(viewport);
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+    state.releaseMessageSave();
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+    expect(await persistentChatPostCount(page)).toBe(0);
+
+    if (await page.getByTestId("mobile-chat-shell").isVisible()) {
+      await page.getByTestId("mobile-sidebar-open").click();
+      await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
+    }
+    await page.getByTestId("account-menu-trigger").click();
+    await page.getByTestId("account-email-updates").click();
+    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/notifications");
+    state.releaseHistoryPageFailure();
+    await page.getByTestId("settings-return-to-chat").click();
+    await expect(page.getByTestId("chat-textarea")).toBeVisible();
+    await chooseConversation(page, CONVERSATION);
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toBeVisible();
+    await expect(message(page, prompt)).toHaveCount(1);
+    expect(await persistentChatPostCount(page)).toBe(0);
+  });
+
+  test("re-clicking the active Chat row preserves and consumes its saved-undispatched notice once", async ({ page }, testInfo) => {
+    const savedNoticeCopy = /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./;
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const remountViewport = testInfo.project.name.includes("mobile")
+      ? DESKTOP_VIEWPORT
+      : MOBILE_VIEWPORT;
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `reclick-user-${index}`, role: "user", content: `Re-click question ${index + 1}.` },
+      { id: `reclick-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Re-click answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const prompt = "Keep this durable turn when the active row is clicked again.";
+    const state = await openChat(page, {
+      viewport,
+      messages: savedMessages,
+      holdMessageSaveBeforeTransaction: true,
+      historyPageFailureOnCursorRead: 2,
+      holdHistoryPageFailure: true,
+    });
+    await expect(message(page, "Re-click answer 26.")).toBeVisible();
+    await page.evaluate(() => {
+      const tracker = window as unknown as { __qaSavedNoticeEvents: string[] };
+      tracker.__qaSavedNoticeEvents = [];
+      window.addEventListener("tomverse:toast", (event) => {
+        const text = (event as CustomEvent<{ message?: string }>).detail?.message;
+        if (text) tracker.__qaSavedNoticeEvents.push(text);
+      });
+    });
+    await submitComposer(page, prompt, viewport.width);
+    await expect.poll(state.messageSaveStarted).toBe(true);
+    await page.setViewportSize(remountViewport);
+    await page.setViewportSize(viewport);
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+    state.releaseMessageSave();
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+
+    await chooseConversation(page, CONVERSATION);
+    state.releaseHistoryPageFailure();
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toBeVisible();
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await chooseConversation(page, CONVERSATION);
+    await expect.poll(async () => (await page.evaluate(() =>
+      (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents
+    )).filter((item) => savedNoticeCopy.test(item)).length).toBe(1);
+    expect(await persistentChatPostCount(page)).toBe(0);
+  });
+
+  test("New Chat from a continuation preserves its armed saved-undispatched notice", async ({ page }, testInfo) => {
+    const savedNoticeCopy = /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./;
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `continuation-user-${index}`, role: "user", content: `Continuation question ${index + 1}.` },
+      { id: `continuation-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Continuation answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const prompt = "Keep this continuation turn after New Chat.";
+    const state = await openChat(page, {
+      viewport,
+      continuation: true,
+      selectedModels: [MODEL_A, MODEL_B],
+      messages: savedMessages,
+      holdBeforeModelSendAfterPayload: true,
+    });
+    await expect(message(page, "Continuation answer 26.")).toBeVisible();
+    await submitComposer(page, prompt, viewport.width);
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+    await expect.poll(state.beforeModelSendStarted).toBe(true);
+
+    await chooseNewChat(page);
+    await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
+    await state.releaseBeforeModelSend();
+    expect(await persistentChatPostCount(page)).toBe(0);
+    await page.goto(`/continuations/${CONVERSATION}?lang=en`);
+    await expect(page.getByTestId("chat-textarea")).toBeVisible();
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toBeVisible();
+    expect(state.conversations[0]!.messages.filter((item) => item.content === prompt))
+      .toHaveLength(1);
+    expect(await persistentChatPostCount(page)).toBe(0);
+  });
+
+  for (const surface of ["review", "continuation"] as const) {
+    test(`provider-start stays monotonic when a later ${surface} sibling panel cleans up`, async ({ page }, testInfo) => {
+      const savedNoticeCopy = /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./;
+      const viewport = testInfo.project.name.includes("mobile")
+        ? MOBILE_VIEWPORT
+        : DESKTOP_VIEWPORT;
+      const prompt = `One ${surface} panel starts this provider request before its sibling leaves.`;
+      const state = await openChat(page, {
+        viewport,
+        legacyReview: surface === "review",
+        continuation: surface === "continuation",
+        selectedModels: [MODEL_A, MODEL_B],
+        // A crosses provider-start; B is stopped at the shared preparation
+        // boundary until navigation has run B's cleanup.
+        holdBeforeModelSendAfterPayloadOnCall: 2,
+      });
+      await page.evaluate(() => {
+        const tracker = window as unknown as { __qaSavedNoticeEvents: string[] };
+        tracker.__qaSavedNoticeEvents = [];
+        window.addEventListener("tomverse:toast", (event) => {
+          const message = (event as CustomEvent<{ message?: string }>).detail?.message;
+          if (message) tracker.__qaSavedNoticeEvents.push(message);
+        });
+      });
+
+      await submitComposer(page, prompt, viewport.width);
+      await expect.poll(state.beforeModelSendStarted).toBe(true);
+      await expect.poll(() => persistentChatPostCount(page)).toBe(1);
+      const providerRequests = await requests(page);
+      expect(providerRequests).toHaveLength(1);
+      expect(providerRequests[0]).toMatchObject({
+        modelId: MODEL_A,
+        conversationId: CONVERSATION,
+      });
+      expect(providerRequests[0].messages?.at(-1)?.content).toBe(prompt);
+
+      if (surface === "continuation") {
+        await chooseNewChat(page);
+        await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
+      } else {
+        await chooseConversation(page, SECOND_CONVERSATION);
+        await expect(message(page, SECOND_ANSWER)).toBeVisible();
+      }
+      await state.releaseBeforeModelSend();
+
+      await expect.poll(() => page.evaluate(() =>
+        sessionStorage.getItem("tomverse_saved_question_not_sent_dispositions_v1")
+      )).toBeNull();
+      await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+        .toHaveCount(0);
+      expect((await page.evaluate(() =>
+        (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents
+      )).filter((item) => savedNoticeCopy.test(item))).toHaveLength(0);
+      expect(await persistentChatPostCount(page)).toBe(1);
+      await drive(page, 0, "finish");
+    });
+  }
+
+  test("a late global Message commit response reports on the first return to its origin", async ({ page }, testInfo) => {
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const prompt = "Keep this late durable turn with its original Chat.";
+    const state = await openChat(page, {
+      viewport,
+      holdMessageSaveResponseAfterCommit: true,
+    });
+
+    await submitComposer(page, prompt, viewport.width);
+    await expect.poll(state.messageSaveCommitted).toBe(true);
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+
+    state.releaseMessageSaveResponse();
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+    await expect.poll(() => page.evaluate(() =>
+      sessionStorage.getItem("tomverse_saved_question_not_sent_dispositions_v1")
+    )).not.toBeNull();
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: "Your question was saved, but no answer request was sent.",
+    })).toHaveCount(0);
+    expect(await persistentChatPostCount(page)).toBe(0);
+
+    await chooseConversation(page, CONVERSATION);
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: "Your question was saved, but no answer request was sent.",
+    })).toBeVisible();
+    await expect(message(page, prompt)).toHaveCount(1);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`)).toHaveLength(1);
+  });
+
+  test("a settled URL handoff does not suppress a later conversation's saved notice", async ({ page }, testInfo) => {
+    const savedNoticeCopy = /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./;
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const prompt = "Keep B's accepted turn after leaving for C.";
+    const state = await openChat(page, {
+      viewport,
+      unclassifiedThird: true,
+      holdMessageSaveResponseAfterCommit: true,
+    });
+    await page.evaluate(() => {
+      const tracker = window as unknown as { __qaSavedNoticeEvents: string[] };
+      tracker.__qaSavedNoticeEvents = [];
+      window.addEventListener("tomverse:toast", (event) => {
+        const message = (event as CustomEvent<{ message?: string }>).detail?.message;
+        if (message) tracker.__qaSavedNoticeEvents.push(message);
+      });
+    });
+
+    // The server-rendered handoff is A. Once it has settled, the retained
+    // client tree must not keep treating that frozen prop as a permanent
+    // restriction on B's later disposition.
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    await submitComposer(page, prompt, viewport.width);
+    await expect.poll(state.messageSaveCommitted).toBe(true);
+    await chooseConversation(page, UNCLASSIFIED_CONVERSATION);
+    await expect(message(page, UNCLASSIFIED_ANSWER)).toBeVisible();
+
+    state.releaseMessageSaveResponse();
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+    await expect.poll(() => page.evaluate(() =>
+      sessionStorage.getItem("tomverse_saved_question_not_sent_dispositions_v1")
+    )).not.toBeNull();
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toHaveCount(0);
+    expect(await persistentChatPostCount(page)).toBe(0);
+
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toBeVisible();
+    await expect.poll(async () => (await page.evaluate(() =>
+      (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents
+    )).filter((item) => savedNoticeCopy.test(item)).length).toBe(1);
+    await expect.poll(() => page.evaluate(() =>
+      sessionStorage.getItem("tomverse_saved_question_not_sent_dispositions_v1")
+    )).toBeNull();
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.conversations[1]!.messages.filter((item) => item.content === prompt))
+      .toHaveLength(1);
+  });
+
+  test("cancelling a locked initial URL handoff releases later conversation notices", async ({ page }, testInfo) => {
+    const savedNoticeCopy = /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./;
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const prompt = "B remains eligible after the locked A handoff is cancelled.";
+    const state = await openChat(page, {
+      viewport,
+      lockedInitialConversation: true,
+      unclassifiedThird: true,
+      holdMessageSaveResponseAfterCommit: true,
+    });
+
+    await expect(page.getByRole("heading", { name: "Unlock" })).toBeVisible();
+    await page.getByRole("button", { name: "Cancel" }).click();
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    await submitComposer(page, prompt, viewport.width);
+    await expect.poll(state.messageSaveCommitted).toBe(true);
+    await chooseConversation(page, UNCLASSIFIED_CONVERSATION);
+    await expect(message(page, UNCLASSIFIED_ANSWER)).toBeVisible();
+
+    state.releaseMessageSaveResponse();
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toHaveCount(0);
+    expect(await persistentChatPostCount(page)).toBe(0);
+
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toBeVisible();
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.conversations[1]!.messages.filter((item) => item.content === prompt))
+      .toHaveLength(1);
+  });
+
+  test("a missing initial URL handoff releases later conversation notices", async ({ page }, testInfo) => {
+    const savedNoticeCopy = /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./;
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const prompt = "B remains eligible after the missing URL handoff ends.";
+    const state = await openChat(page, {
+      viewport,
+      initialConversationId: "qa-missing-or-unowned",
+      unclassifiedThird: true,
+      holdMessageSaveResponseAfterCommit: true,
+    });
+
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    await submitComposer(page, prompt, viewport.width);
+    await expect.poll(state.messageSaveCommitted).toBe(true);
+    await chooseConversation(page, UNCLASSIFIED_CONVERSATION);
+    await expect(message(page, UNCLASSIFIED_ANSWER)).toBeVisible();
+
+    state.releaseMessageSaveResponse();
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toHaveCount(0);
+    expect(await persistentChatPostCount(page)).toBe(0);
+
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toBeVisible();
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect(state.conversations[1]!.messages.filter((item) => item.content === prompt))
+      .toHaveLength(1);
+  });
+
+  test("a late Review global commit after A-to-B-to-A records one notice without dispatch", async ({ page }, testInfo) => {
+    const savedNoticeCopy = /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./;
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const prompt = "Keep this late Review composer turn undispatched.";
+    const state = await openChat(page, {
+      viewport,
+      legacyReview: true,
+      selectedModels: [MODEL_A, MODEL_B],
+      holdMessageSaveResponseAfterCommit: true,
+    });
+    await page.evaluate(() => {
+      const tracker = window as unknown as { __qaSavedNoticeEvents: string[] };
+      tracker.__qaSavedNoticeEvents = [];
+      window.addEventListener("tomverse:toast", (event) => {
+        const message = (event as CustomEvent<{ message?: string }>).detail?.message;
+        if (message) tracker.__qaSavedNoticeEvents.push(message);
+      });
+    });
+
+    await submitComposer(page, prompt, viewport.width);
+    await expect.poll(state.messageSaveCommitted).toBe(true);
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    await chooseConversation(page, CONVERSATION);
+    await expect(message(page, FIRST_ANSWER)).toBeVisible();
+
+    state.releaseMessageSaveResponse();
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+    await expect(page.getByTestId("app-toast").filter({ hasText: savedNoticeCopy }))
+      .toBeVisible();
+    await expect.poll(async () => (await page.evaluate(() =>
+      (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents
+    )).filter((item) => savedNoticeCopy.test(item)).length).toBe(1);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    expect((await requests(page)).every((request) =>
+      request.messages?.every((item) => item.content !== prompt) ?? true
+    )).toBe(true);
+    expect(state.conversations[0]!.messages.filter((item) => item.content === prompt))
+      .toHaveLength(1);
+  });
+
+  test("cancelling a locked conversation selection does not abandon the current saved turn", async ({ page }, testInfo) => {
+    const viewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const remountViewport = testInfo.project.name.includes("mobile")
+      ? DESKTOP_VIEWPORT
+      : MOBILE_VIEWPORT;
+    const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
+      { id: `locked-user-${index}`, role: "user", content: `Locked question ${index + 1}.` },
+      { id: `locked-answer-${index}`, role: "assistant", modelId: MODEL_A,
+        content: `Locked answer ${index + 1}.`, status: "normal" },
+    ] as QaConversationMessage[])).flat();
+    const state = await openChat(page, {
+      viewport,
+      messages: savedMessages,
+      lockedSecondConversation: true,
+      holdMessageSaveBeforeTransaction: true,
+      historyPageFailureOnCursorRead: 2,
+      holdHistoryPageFailure: true,
+    });
+    await submitComposer(page, "A saved turn remains owned by A.", viewport.width);
+    await expect.poll(state.messageSaveStarted).toBe(true);
+    await page.setViewportSize(remountViewport);
+    await page.setViewportSize(viewport);
+    await expect.poll(state.historyPageFailureStarted).toBe(true);
+    state.releaseMessageSave();
+    await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
+
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(page.getByRole("heading", { name: "Unlock" })).toBeVisible();
+    await page.getByRole("button", { name: "Cancel" }).click();
+    await expect.poll(() => page.evaluate(() =>
+      sessionStorage.getItem("tomverse_active_chat_id"))).toBe(CONVERSATION);
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: "Your question was saved, but no answer request was sent.",
+    })).toHaveCount(0);
+    // A refused lock prompt is a navigation attempt, not a committed
+    // selection. A responsive cleanup/remount must therefore keep A's
+    // selection ticket and must not manufacture an abandonment notice.
+    await page.setViewportSize(remountViewport);
+    await page.setViewportSize(viewport);
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: "Your question was saved, but no answer request was sent.",
+    })).toHaveCount(0);
+    expect(await persistentChatPostCount(page)).toBe(0);
+    state.releaseHistoryPageFailure();
+  });
+
   test("a remounted panel learns that its inherited history request failed", async ({ page }) => {
     const savedMessages: QaConversationMessage[] = Array.from({ length: 26 }, (_, index) => ([
       { id: `history-user-${index}`, role: "user", content: `Saved question ${index + 1}.` },
@@ -2093,6 +2694,103 @@ test.describe("Chat unified workspace", { tag: "@ui-risk" }, () => {
     expect(await persistentChatPostCount(page)).toBe(dispatchedBeforeReload);
   });
 
+  test("a saved Review notice follows its conversation instead of the active workspace", async ({ page }, testInfo) => {
+    const savedNoticeCopy = /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./;
+    const noticeViewport = testInfo.project.name.includes("mobile")
+      ? MOBILE_VIEWPORT
+      : DESKTOP_VIEWPORT;
+    const state = await openChat(page, {
+      viewport: DESKTOP_VIEWPORT,
+      legacyReview: true,
+      selectedModels: [MODEL_A, MODEL_B],
+      holdFirstMessageSaveBeforeTransaction: true,
+    });
+    await page.evaluate(() => {
+      (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents = [];
+      window.addEventListener("tomverse:toast", (event) => {
+        const message = (event as CustomEvent<{ message?: string }>).detail?.message;
+        if (message) (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents.push(message);
+      });
+    });
+    await expect(message(page, FIRST_ANSWER)).toBeVisible();
+    await page.getByTestId("model-only-input").first().fill("Conversation-scoped Review question.");
+    await page.getByTestId("model-only-send").first().click();
+    await expect.poll(state.messageSaveStarted).toBe(true);
+
+    await submitComposer(page, "Newer Review turn owns the panel.", DESKTOP_VIEWPORT.width);
+    await expect.poll(async () => (await requests(page)).length).toBeGreaterThan(0);
+    await expect.poll(() => state.writes.filter((write) => write.method === "POST" &&
+      write.path === `/api/conversations/${CONVERSATION}/messages`).length).toBe(2);
+    await page.setViewportSize(noticeViewport);
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+
+    state.releaseMessageSave();
+    await expect.poll(() => state.conversations[0]!.messages.some((item) =>
+      item.content === "Conversation-scoped Review question.")).toBe(true);
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: savedNoticeCopy,
+    })).toHaveCount(0);
+    expect((await page.evaluate(() =>
+      (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents
+    )).filter((item) => savedNoticeCopy.test(item))).toHaveLength(0);
+
+    await chooseConversation(page, CONVERSATION);
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: savedNoticeCopy,
+    })).toBeVisible();
+    await expect.poll(async () => (await page.evaluate(() =>
+      (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents
+    )).filter((item) => savedNoticeCopy.test(item)).length).toBe(1);
+    await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
+    await expect.poll(() => page.evaluate(() =>
+      sessionStorage.getItem("tomverse_active_chat_id"))).toBe(CONVERSATION);
+    await expect(message(page, FIRST_ANSWER)).toBeVisible();
+    expect((await requests(page)).every((request) =>
+      request.messages?.every((item) =>
+        item.content !== "Conversation-scoped Review question.") ?? true)).toBe(true);
+    expect(state.conversations[0]!.messages.filter((item) =>
+      item.content === "Conversation-scoped Review question.")).toHaveLength(1);
+    await drive(page, 0, "finish");
+    await page.waitForTimeout(3_300);
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await chooseConversation(page, CONVERSATION);
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: savedNoticeCopy,
+    })).toHaveCount(0);
+    expect((await page.evaluate(() =>
+      (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents
+    )).filter((item) => savedNoticeCopy.test(item))).toHaveLength(1);
+  });
+
+  test("a late Review receipt wakes the active A tree after a rapid A-to-B-to-A switch", async ({ page }) => {
+    const prompt = "A late durable receipt must wake the current A tree.";
+    const state = await openChat(page, {
+      viewport: DESKTOP_VIEWPORT,
+      legacyReview: true,
+      selectedModels: [MODEL_A, MODEL_B],
+      holdFirstMessageSaveBeforeTransaction: true,
+    });
+    await page.getByTestId("model-only-input").first().fill(prompt);
+    await page.getByTestId("model-only-send").first().click();
+    await expect.poll(state.messageSaveStarted).toBe(true);
+
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    await chooseConversation(page, CONVERSATION);
+    await expect(message(page, FIRST_ANSWER)).toBeVisible();
+
+    state.releaseMessageSave();
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./,
+    })).toBeVisible();
+    expect((await requests(page)).every((request) =>
+      request.messages?.every((item) => item.content !== prompt) ?? true
+    )).toBe(true);
+    expect(state.conversations[0]!.messages.filter((item) =>
+      item.content === prompt)).toHaveLength(1);
+  });
+
   for (const returnToA of [false, true]) {
     test(`a saved Review question from an old identity raises no notice after ${returnToA ? "A-to-B-to-A" : "A-to-B"}`, async ({ page }) => {
       const state = await openChat(page, {
@@ -2122,7 +2820,7 @@ test.describe("Chat unified workspace", { tag: "@ui-risk" }, () => {
       state.releaseMessageSave();
       await expect.poll(() => state.conversations[0]!.messages.some((item) =>
         item.content === "Account A saved question.")).toBe(true);
-      await page.waitForTimeout(200);
+      await expect.poll(state.messageSaveResponseSettledCount).toBe(1);
       const notices = await page.evaluate(() =>
         (window as unknown as { __qaSavedNoticeEvents: string[] }).__qaSavedNoticeEvents);
       expect(notices).not.toContain(
@@ -2132,6 +2830,70 @@ test.describe("Chat unified workspace", { tag: "@ui-risk" }, () => {
     });
   }
 
+  test("a persisted A disposition is cleared across full-unmount B and A mounts", async ({ page }) => {
+    const prompt = "A full reload must not carry this old account notice.";
+    const state = await openChat(page, {
+      legacyReview: true,
+      selectedModels: [MODEL_A, MODEL_B],
+      holdFirstMessageSaveBeforeTransaction: true,
+    });
+    await page.getByTestId("model-only-input").first().fill(prompt);
+    await page.getByTestId("model-only-send").first().click();
+    await expect.poll(state.messageSaveStarted).toBe(true);
+    await chooseConversation(page, SECOND_CONVERSATION);
+    await expect(message(page, SECOND_ANSWER)).toBeVisible();
+    state.releaseMessageSave();
+    await expect.poll(() => state.conversations[0]!.messages.some((item) =>
+      item.content === prompt)).toBe(true);
+    await expect.poll(() => page.evaluate(() => {
+      const raw = sessionStorage.getItem(
+        "tomverse_saved_question_not_sent_dispositions_v1"
+      );
+      return raw ? JSON.parse(raw).length : 0;
+    })).toBe(1);
+
+    // Fully unmount ChatPageClient first. The application session provider
+    // remains alive on the settings route, so B can become current while no
+    // Chat identity effect exists to clear A's persisted disposition.
+    await page.getByTestId("account-menu-trigger").click();
+    await page.getByTestId("account-email-updates").click();
+    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/notifications");
+    state.hidePreviousAccount();
+    await page.route("**/api/auth/session**", (route) => route.fulfill({ json: {
+      user: { id: "qa-user-b", name: "QA B", email: "qa-b@example.test" },
+      expires: "2099-01-01T00:00:00.000Z",
+    } }));
+    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
+    await page.getByTestId("settings-return-to-chat").click();
+    await expect(page.getByTestId("chat-textarea")).toBeVisible();
+    await expect.poll(() => page.evaluate(() =>
+      sessionStorage.getItem("tomverse_saved_question_not_sent_dispositions_v1")
+    )).toBeNull();
+
+    // Unmount the B Chat tree as well, restore A in the shared provider, then
+    // mount a fresh A Chat tree. The A disposition was already destroyed by
+    // B's owner binding and must not reappear.
+    await page.getByTestId("account-menu-trigger").click();
+    await page.getByTestId("account-email-updates").click();
+    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/notifications");
+    state.showPreviousAccount();
+    await page.route("**/api/auth/session**", (route) => route.fulfill({ json: {
+      user: { id: "qa-user", name: "QA User", email: "qa@example.test" },
+      expires: "2099-01-01T00:00:00.000Z",
+    } }));
+    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
+    await page.getByTestId("settings-return-to-chat").click();
+    await expect(page.getByTestId("chat-textarea")).toBeVisible();
+    await chooseConversation(page, CONVERSATION);
+    await expect(message(page, FIRST_ANSWER)).toBeVisible();
+    await expect(page.getByTestId("app-toast").filter({
+      hasText: /Your question was saved, but no answer request was sent\.|질문은 저장되었지만 답변 요청은 전송되지 않았습니다\./,
+    })).toHaveCount(0);
+    expect((await requests(page)).every((request) =>
+      request.messages?.every((item) => item.content !== prompt) ?? true
+    )).toBe(true);
+  });
+
   test("a malformed first history page remains retryable without a send", async ({ page }) => {
     const state = await openChat(page, { malformedFirstHistoryPageOnRead: 2 });
     await expect(page.getByTestId("chat-history-load-error")).toBeVisible();

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test tests/chatIdentityEpoch.test.mjs tests/chatSavedQuestionDisposition.test.mjs` (439ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 338.5376

## Guard results (run by the control program)

- PASS `git diff --check bef622a565468fb9857639bc4ef24171c2c57a5f` (131ms)
- PASS `npm run typecheck` (60165ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npm exec eslint -- 'app/(site)/(application)/chat/ChatPageClient.tsx' components/chat/ChatApp.tsx components/chat/DesktopChatShell.tsx components/chat/MobileChatShell.tsx lib/chatIdentityEpoch.ts lib/chatSavedQuestionDisposition.ts tests/chatIdentityEpoch.test.mjs tests/chatSavedQuestionDisposition.test.mjs tests/e2e/chat-unified-workspace.spec.ts` (52933ms)

## Findings from the previous round (check each was addressed)

- [error/evidence] app/(site)/(application)/chat/ChatPageClient.tsx:2429: A durably saved Chat turn that is still waiting on history is dropped when this page unmounts or the open row is clicked again, so returning to that conversation shows no saved-question notice and sends no provider request.
- [error/evidence] app/(site)/(application)/chat/ChatPageClient.tsx:3550: New Chat on a continuation, after the global payload is armed, deletes the origin disposition and toasts on the tree that is leaving, so the continuation shows no notice when opened again.

## Author's account (read last; a claim, not a finding)

Summary: Make provider-start monotonic across later sibling cleanup; add deterministic Review and continuation desktop/mobile regressions.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "chat-saved-undispatched-disposition-followup-v2",
  "round": 2,
  "reviewedDigest": "sha256:5ad307d081c9c6746f18e526c2aefb8e61b1012009143df52baef066d7ae8980",
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
