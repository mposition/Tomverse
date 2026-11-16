"use client";

// Undefined identity / null allowance means unresolved, not signed out.
let owner: string | null | undefined;
let lastOwner: string | null | undefined;
let allowed: boolean | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
export const journeyIdentity = () => ({ owner, allowed, epoch });
export const onJourneyIdentityInvalidated = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function syncJourneyIdentity(nextOwner: string | null | undefined, nextAllowed: boolean | null) {
  const signedOut = nextOwner === null && owner !== null;
  const changed = nextOwner !== undefined && lastOwner !== undefined && nextOwner !== lastOwner;
  const revoked = nextAllowed === false && allowed !== false;
  owner = nextOwner;
  if (nextOwner !== undefined) lastOwner = nextOwner;
  allowed = nextAllowed;
  if (changed || revoked || signedOut) {
    epoch++;
    for (const listener of listeners) listener();
  }
}
export const journeyOwnerDisposition = (binding: string | undefined): "send" | "hold" | "drop" => {
  if (!binding || allowed === false || owner === null) return "drop";
  if (owner === undefined || allowed === null) return "hold";
  return owner === binding ? "send" : "drop";
};
