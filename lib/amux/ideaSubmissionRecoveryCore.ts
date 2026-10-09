const PREFIX = "amux-v4-idea-unresolved-request:";
const CONFIRMED_PREFIX = "amux-v4-idea-confirmed-request:";
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type ReceiptStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const keyFor = (operatorId: string) => `${PREFIX}${encodeURIComponent(operatorId)}`;
const confirmedKeyFor = (operatorId: string) => `${CONFIRMED_PREFIX}${encodeURIComponent(operatorId)}`;

/** Only an opaque request id is kept in the browser; never the idea or model
 * payload. An inaccessible or corrupted store fails closed. */
export function readPendingIdeaRequest(store: ReceiptStore | null, operatorId: string):
  { kind: "none" } | { kind: "pending"; requestId: string } | { kind: "unavailable" } {
  try {
    if (!store) return { kind: "unavailable" };
    const requestId = store.getItem(keyFor(operatorId));
    if (requestId === null) return { kind: "none" };
    return REQUEST_ID.test(requestId) ? { kind: "pending", requestId } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Persist before POST. Never replace an unresolved request with a fresh id. */
export function reservePendingIdeaRequest(store: ReceiptStore | null, operatorId: string, requestId: string): boolean {
  if (!REQUEST_ID.test(requestId)) return false;
  const key = keyFor(operatorId);
  try {
    if (!store) return false;
    if (store.getItem(key) !== null) return false;
    store.setItem(key, requestId);
    return store.getItem(key) === requestId;
  } catch {
    return false;
  }
}

/** Clear only the receipt that was definitively committed or refused before
 * the transaction. An independently replaced receipt must not be discarded. */
export function clearPendingIdeaRequest(store: ReceiptStore | null, operatorId: string, requestId: string): void {
  try {
    if (!store) return;
    const key = keyFor(operatorId);
    if (store.getItem(key) === requestId) store.removeItem(key);
  } catch {
    // A leftover receipt prompts a safe read-back on the next mount.
  }
}

/** A confirmed opaque request ID lets the owner resume the next Admin step
 * after reload. The idea body and server-issued idea ID never enter storage. */
export function readConfirmedIdeaRequest(store: ReceiptStore | null, operatorId: string):
  { kind: "none" } | { kind: "confirmed"; requestId: string } | { kind: "unavailable" } {
  try {
    if (!store) return { kind: "unavailable" };
    const requestId = store.getItem(confirmedKeyFor(operatorId));
    if (requestId === null) return { kind: "none" };
    return REQUEST_ID.test(requestId) ? { kind: "confirmed", requestId } : { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}

/** Persist the confirmed receipt before clearing the unresolved receipt.
 * Failure leaves the old recovery path intact. */
export function rememberConfirmedIdeaRequest(store: ReceiptStore | null,
  operatorId: string, requestId: string): boolean {
  if (!REQUEST_ID.test(requestId)) return false;
  try {
    if (!store) return false;
    store.setItem(confirmedKeyFor(operatorId), requestId);
    if (store.getItem(confirmedKeyFor(operatorId)) !== requestId) return false;
    clearPendingIdeaRequest(store, operatorId, requestId);
    return true;
  } catch { return false; }
}

export function clearConfirmedIdeaRequest(store: ReceiptStore | null,
  operatorId: string, requestId: string): void {
  try {
    if (store?.getItem(confirmedKeyFor(operatorId)) === requestId) {
      store.removeItem(confirmedKeyFor(operatorId));
    }
  } catch { /* A stale opaque receipt is reverified on the next mount. */ }
}
