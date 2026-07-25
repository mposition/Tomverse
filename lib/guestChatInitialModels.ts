import {
  APP_DEFAULTS,
  resolveGuestDefaultSelectedModels,
} from "@/lib/appDefaults";

// Same keys app/(application)/chat/ChatPageClient.tsx persists guest state
// under. Exported from here so the "what should the composer show on its very
// first render" decision and the effects that later write these keys can
// never drift apart.
export const GUEST_ACTIVE_CHAT_STORAGE_KEY = "tomverse_active_chat_id";
export const GUEST_CONVERSATIONS_STORAGE_KEY = "guest_conversations";

/** Which rule produced the selection -- surfaced for tests and diagnostics. */
export type GuestInitialModelSource =
  | "url_models_param"
  | "restored_conversation"
  | "guest_default";

export type GuestInitialModelSelection = {
  models: string[];
  source: GuestInitialModelSource;
};

type StorageReader = Pick<Storage, "getItem">;

/**
 * Everything about the browser this decision may depend on. All fields are
 * optional and absent during server rendering, which is exactly what makes
 * the same call safe on both sides of hydration: with no browser there is
 * nothing to restore, so the guest default is the answer.
 */
export type GuestInitialModelEnvironment = {
  /** `location.search`, including the leading "?". */
  search?: string | null;
  sessionStorage?: StorageReader | null;
  localStorage?: StorageReader | null;
};

export type GuestCatalogueAccess = {
  /** Enabled and not catalogue-deleted, per the catalogue in hand. */
  isEnabledModelId: (modelId: string) => boolean;
  /** Additionally guest-plan and Standard-tier, per lib/appDefaults. */
  isGuestEligible: (modelId: string) => boolean;
};

export const readGuestInitialModelEnvironment =
  (): GuestInitialModelEnvironment => {
    if (typeof window === "undefined") return {};
    // Storage access throws outright in some locked-down/privacy modes, and a
    // throw here would take down the first render. Losing the restore is the
    // correct degradation: the guest default is still a valid answer.
    const readable = (read: () => StorageReader | null) => {
      try {
        return read();
      } catch {
        return null;
      }
    };
    return {
      search: window.location.search,
      sessionStorage: readable(() => window.sessionStorage),
      localStorage: readable(() => window.localStorage),
    };
  };

const readItem = (storage: StorageReader | null | undefined, key: string) => {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

// Mirrors ChatPageClient's normalizeStringArray: guest conversation records
// have been written by older builds that double-encoded selectedModels, so
// tolerate one extra JSON layer before giving up.
const normalizeStringArray = (value: unknown): string[] | null => {
  let parsed = value;
  for (let i = 0; i < 2 && typeof parsed === "string"; i += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : null;
};

/**
 * The clamp both the first render and every later guest update go through.
 * Order matters and matches the account-side clamp: dedupe, drop anything the
 * catalogue does not serve, cap at the shared model limit, then drop what a
 * guest may not use.
 */
export const createGuestSelectionClamp =
  ({ isEnabledModelId, isGuestEligible }: GuestCatalogueAccess) =>
  (models: string[]) =>
    Array.from(new Set(models))
      .filter(isEnabledModelId)
      .slice(0, APP_DEFAULTS.maxSelectedModels)
      .filter(isGuestEligible)
      .slice(0, APP_DEFAULTS.maxGuestSelectedModels);

/**
 * The guest model selection to render *before anything else runs* -- no
 * effects, no fetches, no post-mount corrections.
 *
 * Priority, highest first:
 *  1. An explicit `?models=` request (a shared comparison link).
 *  2. The guest conversation this tab had open (F5 / crash recovery).
 *  3. The guest brand-trio default for `leadModelId`.
 *  4. Whatever of the trio + fallback pool the catalogue can still serve --
 *     `resolveGuestDefaultSelectedModels` degrades to fewer models rather
 *     than to an invalid one, and to `[]` if the catalogue serves nothing.
 *
 * Estimated credits are never part of this: they are summed from the returned
 * models' metadata by the composer, so a selection and its price can't
 * disagree.
 */
export const resolveGuestInitialSelectedModels = ({
  catalogue,
  leadModelId = APP_DEFAULTS.guestDefaultModelId,
  environment = {},
}: {
  catalogue: GuestCatalogueAccess;
  leadModelId?: string;
  environment?: GuestInitialModelEnvironment;
}): GuestInitialModelSelection => {
  const clamp = createGuestSelectionClamp(catalogue);
  const guestDefault = clamp(
    resolveGuestDefaultSelectedModels({
      isEligible: catalogue.isGuestEligible,
      leadModelId,
    })
  );

  const requestedModels = clamp(
    Array.from(
      new Set(
        (new URLSearchParams(environment.search || "").get("models") || "")
          .split(",")
          .map((modelId) => modelId.trim())
          .filter(catalogue.isEnabledModelId)
      )
    ).slice(0, APP_DEFAULTS.maxSelectedModels)
  );
  if (requestedModels.length > 0) {
    return { models: requestedModels, source: "url_models_param" };
  }

  const activeChatId = readItem(
    environment.sessionStorage,
    GUEST_ACTIVE_CHAT_STORAGE_KEY
  );
  const rawConversations = readItem(
    environment.localStorage,
    GUEST_CONVERSATIONS_STORAGE_KEY
  );
  if (activeChatId && rawConversations) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawConversations);
    } catch {
      parsed = null;
    }
    const restored = Array.isArray(parsed)
      ? (parsed.find(
          (conversation) =>
            conversation &&
            typeof conversation === "object" &&
            (conversation as { id?: unknown }).id === activeChatId
        ) as { selectedModels?: unknown } | undefined)
      : undefined;
    if (restored) {
      const restoredModels = clamp(
        normalizeStringArray(restored.selectedModels) ?? guestDefault
      );
      // An empty or fully invalid saved selection falls through to the guest
      // default rather than to an empty composer -- the same deterministic
      // answer the server would have produced, so there is still no change
      // between the first frame and the restore.
      if (restoredModels.length > 0) {
        return { models: restoredModels, source: "restored_conversation" };
      }
    }
  }

  return { models: guestDefault, source: "guest_default" };
};
