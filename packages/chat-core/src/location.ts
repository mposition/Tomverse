/** A foreground device fix. No address, identity, or background tracking. */
export type ChatLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
};

export const CHAT_LOCATION_MAX_AGE_MS = 120_000;
export const CHAT_LOCATION_TIMEOUT_MS = 10_000;

/** Strip unknown fields and reject forged, stale, or invalid measurements. */
export const parseChatLocation = (
  value: unknown,
  now = Date.now(),
): ChatLocation | null => {
  if (!value || typeof value !== "object") return null;
  const { latitude, longitude, accuracy, timestamp } = value as ChatLocation;
  if (![latitude, longitude, accuracy, timestamp].every(
    (item) => typeof item === "number" && Number.isFinite(item),
  ) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
    accuracy < 0 || accuracy > 40_000_000 || timestamp <= 0 ||
    now - timestamp > CHAT_LOCATION_MAX_AGE_MS || timestamp > now + 30_000) {
    return null;
  }
  return {
    // About 110m at the equator; do not send a precise GPS fix to providers.
    latitude: Math.round(latitude * 1_000) / 1_000,
    longitude: Math.round(longitude * 1_000) / 1_000,
    accuracy: Math.max(150, Math.ceil(accuracy)),
    timestamp: Math.round(timestamp),
  };
};

export type ChatLocationError = "denied" | "timeout" | "unavailable";
export type ChatLocationState = {
  enabled: boolean;
  pending: boolean;
  error: ChatLocationError | null;
};
export type ChatLocationReader = (requestPermission: boolean) => Promise<ChatLocation>;
export const CHAT_LOCATION_OFF: ChatLocationState = {
  enabled: false, pending: false, error: null,
};

/** Consent stays in memory and belongs to one identity. Never cache a fix. */
export const createChatLocationSession = (readPosition: ChatLocationReader) => {
  let state = CHAT_LOCATION_OFF;
  let identity: string | null = null;
  let generation = 0;
  let inFlight: Promise<ChatLocation | null> | null = null;
  const grants = new WeakMap<ChatLocation, number>();
  const listeners = new Set<() => void>();
  const update = (next: ChatLocationState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const disable = () => {
    generation++;
    inFlight = null;
    update(CHAT_LOCATION_OFF);
  };
  const setIdentity = (next: string | null) => {
    if (identity === next) return;
    identity = next;
    disable();
  };
  const isEnabled = (scope: string | null) =>
    scope !== null && scope === identity && state.enabled;
  const read = (requestPermission: boolean): Promise<ChatLocation | null> => {
    if (inFlight) return inFlight;
    const capturedGeneration = generation;
    update({ ...state, pending: true, error: null });
    const pending = Promise.resolve().then(() => readPosition(requestPermission))
      .then((fix) => {
        if (generation !== capturedGeneration) return null;
        const location = parseChatLocation(fix);
        if (!location) throw new Error("unavailable");
        grants.set(location, capturedGeneration);
        update({ enabled: true, pending: false, error: null });
        return location;
      }).catch((error: unknown) => {
        if (generation !== capturedGeneration) return null;
        const code = error instanceof Error ? error.message : "unavailable";
        update({ enabled: false, pending: false,
          error: code === "denied" || code === "timeout" ? code : "unavailable" });
        return null;
      }).finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setIdentity,
    isEnabled,
    canShare: (fix: ChatLocation, scope: string | null) =>
      isEnabled(scope) && grants.get(fix) === generation && parseChatLocation(fix) !== null,
    disable,
    enable: async (scope: string | null) => {
      setIdentity(scope);
      if (!scope) return;
      await read(true);
    },
    readForTurn: (scope: string | null) =>
      isEnabled(scope) ? read(false) : Promise.resolve(null),
  };
};
