// Single source of truth for "does this conversation have anything in it yet".
//
// Both shells used to answer that question with a boolean, and a boolean has
// no room for the state the answer spends most of its first frames in: *not
// known yet*. The panels are what know -- ChatApp only reports once it has
// finished restoring the transcript for the exact (identity, conversation,
// model) view it is showing -- so before the first report the shells filled
// the gap with a default:
//
//     modelEmptyStates[key] ?? (isGuestMode || !currentChatId)
//
// That default reads "assume empty", and "assume empty" renders
// ChatWelcomeScreen. So restoring a guest conversation with a transcript in it
// painted the welcome screen over it until localStorage had been read, and
// every change of the conversation key -- including the one a send performs
// when it adopts a freshly created conversation id -- dropped the shell back
// to the same default and flashed the welcome screen again mid-send.
//
// The fix is to keep the third state instead of collapsing it: `unknown` is
// rendered as the chat structure it will turn out to be (panels, each showing
// its own loading state), never as the welcome screen. `empty` is the only
// state that shows the welcome screen, and it is only ever reached from
// evidence:
//
//   * every selected panel reported itself empty, or
//   * there is no conversation to load messages from at all, or
//   * a synchronous read of the guest's own stored transcripts found none.
//
// Nothing here hides anything with CSS, a timeout or a transition: the shells
// keep painting the same structure, and only the *claim* about what is in the
// conversation waits until it can be made honestly.

export type ChatContentState =
  /** Not established yet. Never renders the welcome screen. */
  | "unknown"
  /** Proven to hold no user turn. The only state the welcome screen renders in. */
  | "empty"
  /** Proven to hold at least one turn. */
  | "non-empty";

/**
 * Per (conversation, model) identity for a reported content state. A brand-new
 * chat has no conversation id yet, which is a state of its own rather than a
 * missing value -- hence the explicit "new".
 */
export function chatContentStateKey(
  conversationId: string | null,
  modelId: string
): string {
  return `${conversationId || "new"}:${modelId}`;
}

export type ChatContentStateInput = {
  /**
   * Whether the page has finished deciding *which* conversation is active.
   * Before that, no report can be trusted to describe the conversation the
   * user is about to see, so nothing may be claimed about it. This is
   * ChatPageClient's `isInitialConversationResolved`, not
   * `isModelSelectionReady` -- the latter is unconditionally true for guests,
   * whose conversation is restored asynchronously from localStorage.
   */
  isConversationSelectionResolved: boolean;
  /** The active conversation id, or null when no conversation exists yet. */
  conversationId: string | null;
  /** The models whose panels make up this conversation right now. */
  selectedModelIds: readonly string[];
  /** What each panel has reported, keyed by {@link chatContentStateKey}. */
  reported: Readonly<Record<string, ChatContentState | undefined>>;
  /**
   * True when a send has been accepted for this conversation. An accepted send
   * puts a user turn in the conversation, so it can never be empty again --
   * this is what stops the welcome screen coming back in the window between
   * the shell adopting a new conversation id and that conversation's panels
   * reporting on it.
   */
  hasAcceptedSubmission?: boolean;
  /**
   * An optional synchronously-established state for this conversation, used
   * only while no panel has reported. Guests can answer the question from
   * localStorage on the very first render (see
   * {@link readGuestChatContentState}); accounts cannot, and pass nothing.
   */
  storedSeed?: ChatContentState;
  /**
   * A send that has been started but not yet handed to the panels, and the
   * conversation it started from.
   *
   * The first send of a brand-new chat creates a conversation, and the shell
   * adopts that id while the send is still being prepared. The panels are then
   * loading a conversation the send has not reached yet: they legitimately
   * report it empty, and that report used to put the welcome screen back over
   * a chat the user had just sent in. While a send is pending, a panel with
   * nothing of its own to say about the new id keeps the answer it gave for
   * the id the send started from -- the same conversation, as the user sees it.
   */
  pendingSubmission?: { originConversationId: string | null } | null;
};

/**
 * Resolves the conversation's content state from every signal available,
 * strongest evidence first.
 */
export function resolveChatContentState({
  isConversationSelectionResolved,
  conversationId,
  selectedModelIds,
  reported,
  hasAcceptedSubmission = false,
  storedSeed = "unknown",
  pendingSubmission = null,
}: ChatContentStateInput): ChatContentState {
  if (!isConversationSelectionResolved) return "unknown";
  // No panels means no transcript is being shown at all. The shells render
  // their "choose a model" copy for this, not the welcome screen, so it must
  // not resolve to `empty`.
  if (selectedModelIds.length === 0) return "unknown";

  const carriesOverFromPendingSend =
    pendingSubmission !== null &&
    pendingSubmission.originConversationId !== conversationId;
  const stateFor = (modelId: string): ChatContentState => {
    const own = reported[chatContentStateKey(conversationId, modelId)] ?? "unknown";
    if (own !== "unknown") return own;
    if (!carriesOverFromPendingSend) return "unknown";
    return (
      reported[
        chatContentStateKey(pendingSubmission.originConversationId, modelId)
      ] ?? "unknown"
    );
  };
  const states = selectedModelIds.map(stateFor);

  // One panel with a turn in it is proof for the whole conversation: the other
  // panels may simply have been added later.
  if (states.some((state) => state === "non-empty")) return "non-empty";
  if (hasAcceptedSubmission) return "non-empty";
  if (states.every((state) => state === "empty")) return "empty";
  // No conversation id means there is no stored transcript anywhere to load,
  // so the conversation is empty by construction. Checked *after* the reports
  // above so an optimistic first turn -- which a panel renders before the
  // conversation it belongs to has been created -- still counts.
  if (!conversationId) return "empty";

  return storedSeed;
}

/**
 * Whether the shell should render the welcome surface.
 *
 * `empty` used to be the whole answer, because "no user turn yet" and "nothing
 * on this screen yet" were the same thing. A continuation broke that: it opens
 * with a read-only imported transcript above the timeline and no native
 * `Message` at all, so every panel reports `empty` — truthfully — and the
 * shell greeted the owner with "welcome back, how can I help?", offered them
 * other recent conversations, and floated the composer in the middle of a
 * screen that already had a conversation on it.
 *
 * So the two questions are separated rather than the state machine bent.
 * `empty` keeps meaning exactly what it says — no native turn — and stays what
 * the comparison rail reads, because a conversation with no answers has
 * nothing to compare whatever else is on screen. What the welcome surface
 * needs is narrower: no native turn **and** nothing else here either.
 *
 * `hasConversationPrelude` is the server's answer, not the client's: it comes
 * from the conversation row's own `surface`, which `conversationSurface()`
 * derives from the continuation bridge. Never from the title, the `kind` or
 * the selection mode.
 */
export function shouldRenderWelcomeSurface({
  contentState,
  hasConversationPrelude,
}: {
  contentState: ChatContentState;
  hasConversationPrelude: boolean;
}): boolean {
  return contentState === "empty" && !hasConversationPrelude;
}

/** Storage surface used by {@link readGuestChatContentState}. */
export type GuestTranscriptReader = {
  keys(): readonly string[];
  getItem(key: string): string | null;
};

/**
 * A guest's transcripts live in localStorage, so unlike an account's they can
 * be read synchronously -- during the shell's very first render, before any
 * panel effect has run. That is what lets a restored guest conversation reach
 * `non-empty` without passing through a frame of anything else, and a genuinely
 * new one reach `empty` without a frame of panel skeletons.
 *
 * Every transcript belonging to the conversation is read, not only the
 * currently selected panels': a guest who sent a turn and then changed the
 * model selection still has a conversation with a turn in it.
 *
 * Returns `unknown` when storage is unavailable or holds something unreadable;
 * the panels then settle the question the slower way, exactly as an account's
 * do.
 */
export function readGuestChatContentState(
  conversationId: string | null,
  storage: GuestTranscriptReader | null,
  transcriptKeysFor: (
    keys: readonly string[],
    conversationId: string
  ) => readonly string[]
): ChatContentState {
  if (!storage || !conversationId) return "unknown";
  let transcriptKeys: readonly string[];
  try {
    transcriptKeys = transcriptKeysFor(storage.keys(), conversationId);
  } catch {
    return "unknown";
  }
  for (const key of transcriptKeys) {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return "unknown";
    }
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt entry is not evidence either way.
      return "unknown";
    }
    if (!Array.isArray(parsed)) return "unknown";
    if (
      parsed.some(
        (message) =>
          message &&
          typeof message === "object" &&
          (message as { role?: unknown }).role === "user"
      )
    ) {
      return "non-empty";
    }
  }
  // Either nothing is stored for this conversation, or what is stored holds no
  // user turn (just the seeded welcome placeholder). Both mean the same thing:
  // the guest has not asked anything here yet.
  return "empty";
}
