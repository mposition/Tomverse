export type ChatIdentityFence = {
  identityKey: string | null;
  epoch: number;
};

const SERVER_IDENTITY_FENCE: ChatIdentityFence = {
  identityKey: null,
  epoch: 0,
};

let chatIdentityEpochSequence = 0;
let activeChatIdentityFence: ChatIdentityFence = SERVER_IDENTITY_FENCE;

const allocateChatIdentityEpoch = (): number => {
  chatIdentityEpochSequence += 1;
  return chatIdentityEpochSequence;
};

/**
 * Adopts the browser realm's current Chat identity after React commits.
 *
 * Server rendering deliberately neither reads nor mutates the browser fence:
 * two concurrent SSR requests share a module instance and must not be able to
 * observe one another's account namespace.
 */
export const adoptActiveChatIdentity = (
  identityKey: string | null
): ChatIdentityFence => {
  if (typeof window === "undefined") return SERVER_IDENTITY_FENCE;
  // Session loading is not an identity transition. Retain the active epoch so
  // a same-account cross-surface remount can adopt it once the session settles.
  if (identityKey === null) return activeChatIdentityFence;
  if (activeChatIdentityFence.identityKey === identityKey) {
    return activeChatIdentityFence;
  }
  activeChatIdentityFence = {
    identityKey,
    epoch: allocateChatIdentityEpoch(),
  };
  return activeChatIdentityFence;
};

export const activeChatIdentityIs = (
  identityKey: string,
  epoch: number
): boolean => {
  if (typeof window === "undefined") return false;
  return activeChatIdentityFence.identityKey === identityKey &&
    activeChatIdentityFence.epoch === epoch;
};

export const chatIdentityCallbackIsCurrent = ({
  originIdentityKey,
  originIdentityEpoch,
  currentNamespaceKey,
  submitFence,
}: {
  originIdentityKey: string;
  originIdentityEpoch: number;
  currentNamespaceKey: string;
  submitFence: ChatIdentityFence;
}): boolean =>
  activeChatIdentityIs(originIdentityKey, originIdentityEpoch) &&
  currentNamespaceKey === originIdentityKey &&
  submitFence.identityKey === originIdentityKey &&
  submitFence.epoch === originIdentityEpoch;
