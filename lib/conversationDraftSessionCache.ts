import type { ConversationDraftStore } from "@/lib/conversationDraftStore";

export type DraftSessionProduct = "chat" | "review";

export type DraftSessionFence = Readonly<{
  identityKey: string;
  epoch: number;
  product: DraftSessionProduct;
  lease: number;
}>;

type OwnerState = {
  identityKey: string;
  epoch: number;
  stores: Partial<Record<DraftSessionProduct, ConversationDraftStore>>;
  leases: Record<DraftSessionProduct, number>;
};

let owner: OwnerState | null = null;
let nextEpoch = 0;

const retireOwner = () => {
  const retired = owner ? Object.values(owner.stores) : [];
  owner = null;
  nextEpoch += 1;
  return retired;
};

/**
 * Opens one tab-local product draft scope for the currently resolved identity.
 *
 * Only one identity can own the cache. Moving to another identity (including
 * unresolved) retires every prior product store immediately. The epoch and
 * per-product lease reject late unmounts or debounced writers from a previous
 * owner/mount, so A -> B -> A never revives A's earlier unsent bytes.
 */
export const openConversationDraftSession = (
  identityKey: string | null,
  product: DraftSessionProduct | null
): {
  fence: DraftSessionFence | null;
  store: ConversationDraftStore;
  retired: ConversationDraftStore[];
} => {
  if (!identityKey || !product) {
    return { fence: null, store: {}, retired: retireOwner() };
  }

  let retired: ConversationDraftStore[] = [];
  if (owner?.identityKey !== identityKey) {
    retired = retireOwner();
    owner = {
      identityKey,
      epoch: nextEpoch,
      stores: {},
      leases: { chat: 0, review: 0 },
    };
  }

  const current = owner;
  current.leases[product] += 1;
  const store = current.stores[product] ?? {};
  return {
    fence: {
      identityKey,
      epoch: current.epoch,
      product,
      lease: current.leases[product],
    },
    store,
    retired,
  };
};

/**
 * Consumes the snapshot only after the opening mount proves it still owns the
 * product lease. React development remounts run layout effects twice; deleting
 * during `open` let the discarded first mount take the only snapshot before
 * the committed mount could restore it.
 */
export const consumeConversationDraftSession = (
  fence: DraftSessionFence,
  expectedStore: ConversationDraftStore
): boolean => {
  if (
    !owner ||
    owner.identityKey !== fence.identityKey ||
    owner.epoch !== fence.epoch ||
    owner.leases[fence.product] !== fence.lease
  ) {
    return false;
  }
  const staged = owner.stores[fence.product];
  if (staged && staged !== expectedStore) return false;
  delete owner.stores[fence.product];
  return true;
};

/** Publishes only from the still-current identity, epoch and product mount. */
export const publishConversationDraftSession = (
  fence: DraftSessionFence,
  store: ConversationDraftStore
): boolean => {
  if (
    !owner ||
    owner.identityKey !== fence.identityKey ||
    owner.epoch !== fence.epoch ||
    owner.leases[fence.product] !== fence.lease
  ) {
    return false;
  }
  owner.stores[fence.product] = store;
  return true;
};

/** Test-only reset for this module-local, non-durable cache. */
export const resetConversationDraftSessionCacheForTest = () => {
  owner = null;
  nextEpoch = 0;
};
