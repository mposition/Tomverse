/**
 * Conversation pinning, as one store outside the sidebar.
 *
 * ## Why none of this lives in the component
 *
 * The mobile drawer unmounts `ChatSidebar` every time it closes, and the
 * desktop shell can have its own copy mounted at the same time. Anything a pin
 * knows that is held per instance goes out of step with the writes that outlive
 * it, and every version of that split produced the same class of defect: the
 * screen and the column disagreeing, with nothing on screen looking wrong.
 *
 * ## Why the order belongs to the tap
 *
 * A client cannot order its own requests, and it cannot learn their outcome
 * reliably either: a request whose connection dropped may still be applied by
 * the server afterwards. Review took apart every client-side answer to that --
 * queues, timeouts, and a compare-and-set on the version the client last *saw*,
 * which fails when two taps in a row both fail: neither teaches the client
 * anything, both name the same version, and whichever the server runs first wins.
 *
 * So each tap carries its own sequence, and the server applies a write only
 * when its sequence is greater than the one the column holds
 * (`app/api/conversations/[conversationId]/pin/route.ts`). The column therefore
 * ends on the highest sequence in whatever order requests arrive, including two
 * that both failed on the wire. Nothing here has to put requests in order, so
 * there is no queue, and a request that never answers holds nothing up.
 *
 * The contract this gives is written down in
 * `docs/ui-contracts/mobile-sidebar-drawer.md` (decided 2026-09-16): on one
 * client the last tap is the last write; a tap made after seeing a state beats
 * it; every device converges. Taps from two devices that have not seen each
 * other are concurrent, so their clocks decide -- no design can know which was
 * really pressed later.
 *
 * An unknown outcome is resolved by sending the same write again. A write is
 * idempotent by its sequence: if the first attempt landed, the column already
 * holds that sequence and the answer says so; if it did not, the retry lands.
 *
 * ## One rule for what the row shows
 *
 * Every event -- a tap, an answer, a list -- ends in `resolveRow`, which derives
 * the row from the state rather than patching it per event. Patching per event
 * is what produced the last several defects: each condition ("only the newest
 * answer draws", "a pending tap blocks the list") had a gap, and each gap was a
 * row showing something the store itself knew to be wrong.
 *
 *   1. The newest tap has not settled, and nothing the server said is at least
 *      as new as it -> show what that tap asked for.
 *   2. Otherwise, the store knows a server state newer than the list on screen
 *      -> show that state.
 *   3. Otherwise -> show the list.
 *
 * ## What the store holds
 *
 * - `overrides` -- what the row shows where it differs from the list.
 * - `known` -- the newest server state seen per conversation, with its sequence,
 *   from a list or a write's answer. It only ever moves forward.
 * - `listed` -- the sequence the list currently on screen carries.
 * - `claims` -- the newest tap per conversation, while its request is out.
 * - `latest` -- the last sequence issued per conversation, which decides whether
 *   a request is still the newest tap and so worth resending.
 * - `outstanding` -- sequences whose requests have not settled yet. Bounded by
 *   how many taps are in the air at once.
 * - `landable` -- one number per conversation: the highest sequence of a
 *   settled write whose outcome stayed unknown, so it may still land. Settled
 *   unknowns are folded into this single value rather than kept one by one --
 *   kept as a list, every unanswered write made it one entry longer for the life
 *   of the tab, and every tap spread all of them into `Math.max`. A refused or
 *   404 write never lands, so it is folded into nothing.
 * - Together these set the floor for the next sequence. Neither is swept by list
 *   membership: a list says which conversations the *current* account has,
 *   while these are facts about writes that may still land whoever is signed
 *   in. Swept by another account's list, a landable write lost its floor and the
 *   next tap back on the first account could be issued below it.
 * - `inFlight` -- how many requests are out per conversation.
 * - `answered` -- conversations the server answered for while requests were out.
 * - `legacyPins` / `legacyDropped` -- pins this browser made before the column
 *   existed, and which of them a tap has taken in hand.
 *
 * The protocol takes its transport, clock and wait as arguments or test seams,
 * so the cases that matter run against a fake server instead of being argued.
 */

export const LEGACY_PIN_STORAGE_KEY = "tomverse_pinned_conversations";

/**
 * How many times one tap re-sends after an answer that proves nothing. Each
 * retry either lands, reports that the first attempt already landed, or reports
 * a later tap -- any of which settles it.
 */
export const PIN_UNKNOWN_RETRIES = 2;

const EMPTY_OVERRIDES: Readonly<Record<string, boolean>> = Object.freeze({});
const EMPTY_LEGACY: readonly string[] = Object.freeze([]);

/**
 * Where the legacy pins are read from and written back to.
 *
 * `read` returns `null` when storage could not be reached at all, which is a
 * different answer from an empty list: the store falls back to what this tab
 * already holds instead of treating a blocked browser as "nothing pinned".
 */
export type LegacyPinStorage = {
  read: () => string[] | null;
  write: (ids: string[]) => void;
};

/** What one pin write came back with. */
export type PinWriteOutcome =
  /** The server wrote it. */
  | { kind: "applied"; pinned: boolean; seq: number }
  /**
   * Nothing was written now, because the column already holds this sequence or
   * a greater one. This is what it holds.
   */
  | { kind: "superseded"; pinned: boolean; seq: number }
  /**
   * Not there for this account. Deliberately ambiguous: the route answers the
   * same for a deleted conversation and for someone else's, so this proves
   * only that nothing was written -- never that the conversation is gone.
   */
  | { kind: "gone" }
  /** Refused before any write -- signed out, rate limited, clock out of range. */
  | { kind: "refused" }
  /** No usable answer. The write may or may not have happened. */
  | { kind: "failed" };

export type PinWriteRequest = {
  id: string;
  pinned: boolean;
  seq: number;
  ownerId: string | null;
};

export type PinTransport = (request: PinWriteRequest) => Promise<PinWriteOutcome>;

export type PinServerRow = { id: string; pinned?: boolean; pinSeq?: number };

const browserLegacyStorage: LegacyPinStorage = {
  read: () => {
    let raw: string | null;
    try {
      raw = localStorage.getItem(LEGACY_PIN_STORAGE_KEY);
    } catch {
      // Storage refused -- a private window with site data blocked. Not empty:
      // unreachable.
      return null;
    }
    try {
      const stored = JSON.parse(raw || "[]");
      return Array.isArray(stored)
        ? stored.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      // Reachable but corrupt, which genuinely holds nothing usable.
      return [];
    }
  },
  write: (ids) => {
    try {
      localStorage.setItem(LEGACY_PIN_STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // The in-memory list still carries it for this session.
    }
  },
};

type PinState = { pinned: boolean; seq: number };

type PinStore = {
  identity: string;
  generation: number;
  overrides: Record<string, boolean>;
  known: Map<string, PinState>;
  listed: Map<string, number>;
  claims: Map<string, PinState>;
  latest: Map<string, number>;
  outstanding: Map<string, number[]>;
  landable: Map<string, number>;
  inFlight: Map<string, number>;
  answered: Set<string>;
  legacyPins: readonly string[];
  legacyLoaded: boolean;
  legacyDropped: Set<string>;
  presentIds: Set<string>;
  /** Whether anything has said which conversations exist yet. */
  presentKnown: boolean;
  listeners: Set<() => void>;
  storage: LegacyPinStorage;
  clock: () => number;
  wait: (attempt: number) => Promise<void>;
};

const defaultWait = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 400 * 2 ** attempt));

const freshStore = (storage: LegacyPinStorage): PinStore => ({
  identity: "",
  generation: 0,
  overrides: EMPTY_OVERRIDES as Record<string, boolean>,
  known: new Map(),
  listed: new Map(),
  claims: new Map(),
  latest: new Map(),
  outstanding: new Map(),
  landable: new Map(),
  inFlight: new Map(),
  answered: new Set(),
  legacyPins: EMPTY_LEGACY,
  legacyLoaded: false,
  legacyDropped: new Set(),
  presentIds: new Set(),
  presentKnown: false,
  listeners: new Set(),
  storage,
  clock: () => Date.now(),
  wait: defaultWait,
});

let store: PinStore = freshStore(browserLegacyStorage);

const notify = () => {
  for (const listener of store.listeners) listener();
};

// ---------------------------------------------------------------------------
// Subscription and snapshots
// ---------------------------------------------------------------------------

/*
  Another tab's change to the shared key. Reading fresh at every write keeps
  this tab from overwriting one; this keeps it from showing the stale one until
  somebody taps. Attached once, for the life of the page.
*/
let storageListenerAttached = false;
const attachStorageListener = () => {
  if (storageListenerAttached || typeof window === "undefined") return;
  storageListenerAttached = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== LEGACY_PIN_STORAGE_KEY) return;
    const incoming = readStorage();
    if (incoming === null) return;
    const believed = store.legacyPins;
    if (
      incoming.length === believed.length &&
      incoming.every((id, index) => id === believed[index])
    ) {
      return;
    }
    store.legacyLoaded = true;
    store.legacyPins = Object.freeze(incoming);
    notify();
  });
};

export const subscribePinStore = (onStoreChange: () => void) => {
  attachStorageListener();
  store.listeners.add(onStoreChange);
  return () => {
    store.listeners.delete(onStoreChange);
  };
};

/* A new object on every change: `useSyncExternalStore` compares by identity. */
export const getPinOverrides = () => store.overrides;
export const getServerPinOverrides = () => EMPTY_OVERRIDES;

export const getLegacyPins = (): readonly string[] => {
  if (!store.legacyLoaded) {
    store.legacyLoaded = true;
    const loaded = readStorage();
    if (loaded && loaded.length > 0) store.legacyPins = Object.freeze(loaded);
  }
  return store.legacyPins;
};
export const getServerLegacyPins = () => EMPTY_LEGACY;

const setOverride = (id: string, pinned: boolean) => {
  if (store.overrides[id] === pinned) return;
  store.overrides = { ...store.overrides, [id]: pinned };
  notify();
};

const clearOverride = (id: string) => {
  if (!(id in store.overrides)) return;
  const next = { ...store.overrides };
  delete next[id];
  store.overrides = next;
  notify();
};

// ---------------------------------------------------------------------------
// Legacy pins
// ---------------------------------------------------------------------------

const readStorage = (): string[] | null => {
  try {
    return store.storage.read();
  } catch {
    return null;
  }
};

/**
 * What storage holds right now: the base every change is applied to.
 *
 * Writing this tab's cached array back erases what another tab pinned since;
 * union-merging it back resurrects what another tab unpinned since. Read, apply
 * one change, write. Two tabs writing at the same instant can still lose one
 * change -- `localStorage` has no lock and the HTML standard says not to assume
 * one -- which is last-write-wins, bounded to pins made before the column.
 *
 * When storage cannot be read at all, this tab's own list is the base.
 */
const currentLegacy = (): string[] => readStorage() ?? [...store.legacyPins];

const writeLegacy = (ids: readonly string[]) => {
  store.legacyPins = Object.freeze([...ids]);
  try {
    store.storage.write([...ids]);
  } catch {
    // Loses the pin on reload, not the tap.
  }
  notify();
};

/** Take this conversation's legacy pin in hand, if it has one. */
const dropLegacyPin = (id: string) => {
  getLegacyPins();
  const current = currentLegacy();
  if (!current.includes(id)) return;
  store.legacyDropped.add(id);
  writeLegacy(current.filter((item) => item !== id));
};

/**
 * Once nothing is out for a conversation: if the server answered for it, its
 * column is the truth and the browser's pre-column pin is spent; if nothing got
 * through, the pin is owed back. Not gated on the session -- the pin belongs to
 * this browser.
 */
const settleLegacyPin = (id: string) => {
  const answered = store.answered.delete(id);
  if (!store.legacyDropped.delete(id)) return;
  if (answered) return;
  const current = currentLegacy();
  if (current.includes(id)) return;
  writeLegacy([id, ...current]);
};

/** A guest's pins are the browser's, so the toggle is the whole operation. */
export const toggleLegacyPin = (id: string) => {
  getLegacyPins();
  const current = currentLegacy();
  writeLegacy(
    current.includes(id) ? current.filter((item) => item !== id) : [id, ...current]
  );
};

// ---------------------------------------------------------------------------
// What the row shows
// ---------------------------------------------------------------------------

/** Record a server state if it is newer than anything known. */
const learn = (id: string, pinned: boolean, seq: number) => {
  const known = store.known.get(id);
  if (known && known.seq >= seq) return;
  store.known.set(id, { pinned, seq });
  // Sequences at or below what the server now holds are settled history: the
  // next tap starts above `known` anyway, so they no longer need a floor.
  // A landable write at or below what the server now holds is settled history;
  // `known` sets that floor now.
  if ((store.landable.get(id) ?? Number.POSITIVE_INFINITY) <= seq) store.landable.delete(id);
};

/**
 * The one rule. Derived from the state after every event, never patched per
 * event -- see the module comment.
 */
const resolveRow = (id: string) => {
  const claim = store.claims.get(id);
  const known = store.known.get(id);
  if (claim && (!known || known.seq < claim.seq)) {
    setOverride(id, claim.pinned);
    return;
  }
  const listed = store.listed.get(id);
  if (known && (listed === undefined || known.seq > listed)) {
    setOverride(id, known.pinned);
    return;
  }
  clearOverride(id);
};

/**
 * Take in what a list says about each conversation. Compared by sequence: a
 * stale list -- the parent does not refetch after a pin -- carries a sequence at
 * or below what a write already taught this tab and so shows nothing new, while
 * a newer one wins over anything short of a tap newer still.
 */
export const observeServerPins = (rows: Iterable<PinServerRow>) => {
  for (const row of rows) {
    if (typeof row.pinSeq !== "number") continue;
    store.listed.set(row.id, row.pinSeq);
    learn(row.id, row.pinned === true, row.pinSeq);
    resolveRow(row.id);
  }
};

// ---------------------------------------------------------------------------
// Sessions and sweeping
// ---------------------------------------------------------------------------

/**
 * Claim the store for `identity`. Returns the generation a caller carries.
 *
 * Only this session's claims on screen are dropped. Known server state, issued
 * sequences and legacy bookkeeping are about conversations, not about who is
 * signed in, and a write already on the wire cannot be recalled.
 */
export const reconcilePinStore = (identity: string) => {
  if (store.identity === identity) return store.generation;
  store.identity = identity;
  store.generation += 1;
  store.presentIds = new Set();
  store.presentKnown = false;
  store.claims.clear();
  store.listed.clear();
  if (store.overrides !== EMPTY_OVERRIDES) {
    store.overrides = EMPTY_OVERRIDES as Record<string, boolean>;
    notify();
  }
  return store.generation;
};

/**
 * Forget what the store holds about conversations the account no longer has.
 * Run when the list changes and again whenever a conversation's last request
 * settles, because one deleted mid-write is skipped while it is out.
 */
export const forgetMissingPins = (presentIds?: Iterable<string>) => {
  if (presentIds) {
    store.presentIds = new Set(presentIds);
    store.presentKnown = true;
  }
  if (!store.presentKnown) return;
  const keep = (id: string) =>
    store.presentIds.has(id) || (store.inFlight.get(id) ?? 0) > 0;

  for (const map of [store.known, store.listed, store.claims, store.latest]) {
    for (const id of [...map.keys()]) if (!keep(id)) map.delete(id);
  }
  // `outstanding` and `landable` are deliberately not swept here -- see the
  // module comment. `outstanding` empties itself as requests settle.
  for (const id of [...store.answered]) if (!keep(id)) store.answered.delete(id);
  for (const id of [...store.legacyDropped]) if (!keep(id)) store.legacyDropped.delete(id);

  let overrides = store.overrides;
  for (const id of Object.keys(overrides)) {
    if (keep(id)) continue;
    if (overrides === store.overrides) overrides = { ...overrides };
    delete overrides[id];
  }
  if (overrides !== store.overrides) {
    store.overrides = overrides;
    notify();
  }
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The sequence for a new tap on `id`: above the newest server state known, above
 * every write that may still land, and never below the clock.
 */
const issueSeq = (id: string) => {
  const floor = Math.max(
    store.known.get(id)?.seq ?? 0,
    store.landable.get(id) ?? 0,
    ...(store.outstanding.get(id) ?? [])
  );
  const seq = Math.max(Math.floor(store.clock()), floor + 1);
  store.outstanding.set(id, [...(store.outstanding.get(id) ?? []), seq]);
  store.latest.set(id, seq);
  return seq;
};

/**
 * A request has settled. If its outcome stayed unknown it may still land, so its
 * sequence is folded into the single landable floor; otherwise it is simply
 * forgotten -- written and learned, or refused and never to land.
 */
const settleSeq = (id: string, seq: number, outcomeUnknown: boolean) => {
  const outstanding = (store.outstanding.get(id) ?? []).filter((value) => value !== seq);
  if (outstanding.length > 0) store.outstanding.set(id, outstanding);
  else store.outstanding.delete(id);
  if (!outcomeUnknown) return;
  if ((store.known.get(id)?.seq ?? -1) >= seq) return;
  store.landable.set(id, Math.max(store.landable.get(id) ?? 0, seq));
};

/**
 * Pin or unpin one conversation for a signed-in account.
 *
 * Optimistic: the row moves at once and the write follows. The write carries
 * this tap's sequence, so it can never land over a later tap, and it is sent
 * straight away -- there is nothing to wait behind.
 *
 * An answer that proves nothing is resolved by sending the same write again,
 * which is safe because a write is idempotent by its sequence. Resending stops
 * as soon as a later tap exists on this client, because that tap's own write
 * decides the column whatever this one does.
 *
 * Nothing is sent for a session that has ended.
 *
 * `seen` is the row as it was on screen when the reader tapped. The list's
 * sequence otherwise reaches the store in an effect, which React runs after
 * painting -- so a tap in that gap was made after *seeing* a state the store
 * had not learned yet, was issued below it, and lost to it. That is guarantee 2
 * broken by timing alone. Taking the rendered row at the click makes the tap's
 * floor exactly what the reader saw, whenever the effect happens to run.
 */
export const requestPin = ({
  id,
  pinned,
  identity,
  ownerId,
  transport,
  seen,
}: {
  id: string;
  pinned: boolean;
  identity: string;
  ownerId: string | null;
  transport: PinTransport;
  seen?: PinServerRow;
}) => {
  const generation = reconcilePinStore(identity);
  if (seen && seen.id === id) observeServerPins([seen]);
  const seq = issueSeq(id);
  const ownsSession = () => store.generation === generation;
  const isNewestTap = () => ownsSession() && store.latest.get(id) === seq;

  store.claims.set(id, { pinned, seq });
  store.inFlight.set(id, (store.inFlight.get(id) ?? 0) + 1);
  dropLegacyPin(id);
  resolveRow(id);

  // Whether the last thing this request learned was "no provable answer" --
  // true once an attempt has been sent and failed, false once any answer settles
  // it. A request that stops early, for a newer tap or an ended session, keeps
  // whatever it last had: a failed send may still land.
  let outcomeUnknown = false;

  const run = async () => {
    for (let attempt = 0; attempt <= PIN_UNKNOWN_RETRIES; attempt += 1) {
      if (!ownsSession()) return;
      if (attempt > 0) {
        if (!isNewestTap()) return;
        await store.wait(attempt - 1);
        if (!isNewestTap()) return;
      }

      let outcome: PinWriteOutcome;
      try {
        outcome = await transport({ id, pinned, seq, ownerId });
      } catch {
        outcome = { kind: "failed" };
      }

      switch (outcome.kind) {
        case "applied":
        case "superseded":
          // Either way the server has said what the column holds -- for a
          // superseded answer carrying this tap's own sequence, that the first
          // attempt landed after all.
          outcomeUnknown = false;
          learn(id, outcome.pinned, outcome.seq);
          store.answered.add(id);
          return;
        case "gone":
          /*
            Nothing was written, and that is all a 404 proves. The route answers
            the same for a deleted conversation and for someone else's -- so a
            conversation from the previous account, tapped in the moment before
            the new account's list arrived, answers exactly like a deleted one.

            Treating this as "gone for good" was tried twice. A tombstone fenced
            by sequence let a late answer carrying another device's larger
            sequence past it; an absorbing one blocked the rightful owner's own
            later writes after a session bounced back, and was swept before a
            slow list from before the deletion arrived. The server cannot prove
            deletion without saying whose a conversation is, so the store does
            not conclude it. Whether a row exists is the list's to say
            (docs/ui-contracts/mobile-sidebar-drawer.md).
          */
          outcomeUnknown = false;
          return;
        case "refused":
          // Refused before any write, so it will never land.
          outcomeUnknown = false;
          return;
        case "failed":
          outcomeUnknown = true;
          continue;
      }
    }
    // Still nothing provable; `settleSeq` keeps it as a floor, since it may land.
  };

  const settled = run().then(
    () => undefined,
    () => undefined
  );
  void settled.then(() => {
    // This tap's claim ends with its request, whatever the answer. A newer tap
    // has already replaced it if there is one.
    settleSeq(id, seq, outcomeUnknown);
    if (store.claims.get(id)?.seq === seq) store.claims.delete(id);
    resolveRow(id);

    const remaining = (store.inFlight.get(id) ?? 1) - 1;
    if (remaining > 0) {
      store.inFlight.set(id, remaining);
      return;
    }
    store.inFlight.delete(id);
    settleLegacyPin(id);
    forgetMissingPins();
  });
  return settled;
};

// ---------------------------------------------------------------------------
// Test seams. Not called by the app.
// ---------------------------------------------------------------------------

export const __resetPinStoreForTests = (
  storage?: LegacyPinStorage,
  timing?: { clock?: () => number; wait?: (attempt: number) => Promise<void> }
) => {
  store = freshStore(storage ?? browserLegacyStorage);
  store.clock = timing?.clock ?? (() => 0);
  store.wait = timing?.wait ?? (() => Promise.resolve());
};

export const __readPinStoreForTests = () => ({
  overrides: store.overrides,
  legacyPins: store.legacyPins,
  known: Object.fromEntries(store.known),
  listed: Object.fromEntries(store.listed),
  claims: Object.fromEntries(store.claims),
  latest: Object.fromEntries(store.latest),
  // The floor-setting sequences per conversation, outstanding and landable
  // together, under the name the tests have always used.
  live: Object.fromEntries(
    [...new Set([...store.outstanding.keys(), ...store.landable.keys()])].map((key) => [
      key,
      [
        ...(store.outstanding.get(key) ?? []),
        ...(store.landable.has(key) ? [store.landable.get(key) as number] : []),
      ],
    ])
  ),
  inFlight: Object.fromEntries(store.inFlight),
  answered: [...store.answered],
  legacyDropped: [...store.legacyDropped],
  generation: store.generation,
});
