export const SAVED_QUESTION_NOT_SENT_LIMIT = 64;
export const SAVED_QUESTION_NOT_SENT_STORAGE_KEY =
  "tomverse_saved_question_not_sent_dispositions_v1";
export const SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY =
  "tomverse_saved_question_not_sent_owner_v1";
export const SAVED_QUESTION_NOT_SENT_CHANGE_EVENT =
  "tomverse:saved-question-not-sent-dispositions-change";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type StoredKeys = {
  available: boolean;
  keys: Set<string>;
};

const MAX_OWNER_KEY_LENGTH = 256;

const boundedKeys = (keys: Iterable<string>): Set<string> =>
  new Set([...keys].slice(-SAVED_QUESTION_NOT_SENT_LIMIT));

const replaceMemory = (memory: Set<string>, keys: Iterable<string>): void => {
  memory.clear();
  for (const key of boundedKeys(keys)) memory.add(key);
};

const readStoredKeys = (storage: StorageLike | null): StoredKeys => {
  if (!storage) return { available: false, keys: new Set() };
  let raw: string | null;
  try {
    raw = storage.getItem(SAVED_QUESTION_NOT_SENT_STORAGE_KEY);
  } catch {
    return { available: false, keys: new Set() };
  }
  try {
    const parsed = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return { available: true, keys: new Set() };
    return {
      available: true,
      keys: boundedKeys(parsed.filter((item): item is string =>
        typeof item === "string" && item.length > 0 && item.length <= 512
      )),
    };
  } catch {
    // A readable but malformed value is authoritative corruption, not a cue
    // to merge an older memory snapshot back into storage.
    return { available: true, keys: new Set() };
  }
};

const persistKeys = (storage: StorageLike | null, keys: Set<string>): void => {
  if (!storage) return;
  try {
    if (keys.size === 0) {
      storage.removeItem(SAVED_QUESTION_NOT_SENT_STORAGE_KEY);
    } else {
      storage.setItem(
        SAVED_QUESTION_NOT_SENT_STORAGE_KEY,
        JSON.stringify([...keys])
      );
    }
  } catch {
    // The bounded in-memory set remains the tab's best available record.
  }
};

/**
 * Mutate the latest storage value and then replace, rather than merge, the
 * caller's cached set. A late closure can therefore neither overwrite a key
 * written by a newer tree nor resurrect a key that tree already consumed.
 */
const mutateKeys = (
  memory: Set<string>,
  storage: StorageLike | null,
  mutation: (keys: Set<string>) => boolean
): boolean => {
  const stored = readStoredKeys(storage);
  const next = stored.available ? stored.keys : boundedKeys(memory);
  const changed = mutation(next);
  const bounded = boundedKeys(next);
  persistKeys(storage, bounded);
  replaceMemory(memory, bounded);
  return changed;
};

export const addSavedQuestionNotSentKey = (
  memory: Set<string>,
  storage: StorageLike | null,
  key: string
): boolean => mutateKeys(memory, storage, (keys) => {
  const existed = keys.delete(key);
  keys.add(key);
  return !existed;
});

export const addSavedQuestionNotSentKeys = (
  memory: Set<string>,
  storage: StorageLike | null,
  additions: Iterable<string>
): boolean => mutateKeys(memory, storage, (keys) => {
  let added = false;
  for (const key of additions) {
    const existed = keys.delete(key);
    keys.add(key);
    added ||= !existed;
  }
  return added;
});

export const removeSavedQuestionNotSentTurn = (
  memory: Set<string>,
  storage: StorageLike | null,
  turnId: string
): boolean => {
  const suffix = `\0${turnId}`;
  return mutateKeys(memory, storage, (keys) => {
    let removed = false;
    for (const key of keys) {
      if (!key.endsWith(suffix)) continue;
      keys.delete(key);
      removed = true;
    }
    return removed;
  });
};

export const removeSavedQuestionNotSentKey = (
  memory: Set<string>,
  storage: StorageLike | null,
  key: string
): boolean => mutateKeys(memory, storage, (keys) => keys.delete(key));

export const consumeSavedQuestionNotSentPrefix = (
  memory: Set<string>,
  storage: StorageLike | null,
  identityKey: string,
  conversationId: string,
  preserveKey: string | null = null
): boolean => {
  const prefix = `${identityKey}\0${conversationId}\0`;
  return mutateKeys(memory, storage, (keys) => {
    let consumed = false;
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      if (key === preserveKey) continue;
      keys.delete(key);
      consumed = true;
    }
    return consumed;
  });
};

/** Identity boundaries are an intentional full clear, never a merge. */
export const clearSavedQuestionNotSentKeys = (
  memory: Set<string>,
  storage: StorageLike | null
): void => {
  memory.clear();
  if (!storage) return;
  try {
    storage.removeItem(SAVED_QUESTION_NOT_SENT_STORAGE_KEY);
  } catch {
    // Memory is still cleared even when tab storage is unavailable.
  }
};

export const readSavedQuestionNotSentKeySet = (
  memory: Set<string>,
  storage: StorageLike | null
): Set<string> => {
  const stored = readStoredKeys(storage);
  if (stored.available) replaceMemory(memory, stored.keys);
  return new Set(memory);
};

/**
 * Bind persisted dispositions to the identity that owns this full page tree.
 *
 * sessionStorage survives a full reload while React refs do not. A fresh B
 * tree must therefore clear A's opaque dispositions even though it has no
 * in-memory transition to observe. A same-identity reload preserves them.
 * The marker contains only the already-used identity namespace key, is
 * bounded, and carries no prompt, attachment or execution authority.
 */
export const bindSavedQuestionNotSentOwner = (
  memory: Set<string>,
  storage: StorageLike | null,
  identityKey: string
): boolean => {
  if (!storage || !identityKey || identityKey.length > MAX_OWNER_KEY_LENGTH) {
    clearSavedQuestionNotSentKeys(memory, storage);
    return false;
  }
  let owner: string | null;
  try {
    owner = storage.getItem(SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY);
  } catch {
    return false;
  }
  if (owner === identityKey) return true;

  clearSavedQuestionNotSentKeys(memory, storage);
  try {
    storage.setItem(SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY, identityKey);
  } catch {
    // The in-memory clear still prevents this tree from exposing stale data.
  }
  return false;
};

export const setBoundedMapEntry = <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit = SAVED_QUESTION_NOT_SENT_LIMIT
): void => {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
};
