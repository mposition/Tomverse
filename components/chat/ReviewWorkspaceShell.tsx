/**
 * The Tomverse Review workspace, rendered by two routes.
 *
 * Product boundary decision record v1.2 §7 and §8. `/review` is being prepared
 * as the canonical Review URL while `/chat` stays the compatibility path, and
 * "prepared" has to mean the *same* shell rather than a second one that drifts:
 * a duplicate would be a second place to fix every time the workspace changes,
 * and the parity job would be comparing two implementations rather than two
 * URLs.
 *
 * Neither route is public today. `/review` is a private alias, both are
 * `noindex`, and nothing about `/chat` has changed meaning: it is still the
 * Review-compatible path, and Tomverse Chat is still not exposed.
 *
 * The work this file does is server-side and per-request, which is why both
 * routes carry `dynamic = "force-dynamic"` rather than inheriting it -- a
 * route segment config export has to be in the route's own file.
 */

import { cookies } from "next/headers";
import type { ConversationSurface } from "@/lib/continuationRoutes";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import {
  getPublicAppSettings,
  isChatStarterEnabled,
  isImageGenerationEnabled,
  isVoiceInputEnabled,
} from "@/lib/appSettings";
import { IMAGE_GENERATION_FLAG_KEY } from "@/lib/imageGenerationAccess";
import {
  VOICE_INPUT_FLAG_KEY,
  voiceInputKillSwitchEngaged,
} from "@/lib/voiceInputAccess";
import { chatStarterEnabledWithFixtureOverride } from "@/lib/chatStarterAccess";
import { CHAT_STARTER_FLAG_KEYS } from "@/lib/chatStarterCatalog";
import { resolveChatStarterCapabilities } from "@/lib/chatStarterCapabilityResolution";
import {
  imageGroupMaxModels,
  resolveImageGroupMaxModels,
} from "@/lib/imageGroupLimits";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
import { GuestVerificationProvider } from "@/components/chat/GuestVerificationProvider";
import { ChatPageClient } from "@/app/(site)/(application)/chat/ChatPageClient";

// The chat UI itself is a Client Component (state, storage, streaming), so
// this Server Component exists for one reason: to hand it the guest default
// lead model as an initial prop.
//
// It used to be fetched from /api/app-settings after mount, which meant the
// composer's first painted frame had no idea a guest defaults to three models
// and rendered a single-model "1 credit" estimate that jumped to 3 credits
// once the response landed (STG-F006). Resolving it here puts the value in
// the initial RSC payload, so the client's first render already agrees with
// the server -- no extra request, and nothing left to correct afterwards.
export async function ReviewWorkspaceShell({
  initialConversationId = null,
  mountedSurface = "workspace",
}: {
  /**
   * The conversation this mount opens with, when the route named one.
   *
   * `/continuations/[conversationId]` is the caller. Everything else about the
   * shell is identical, which is the point: a continuation is an ordinary
   * Tomverse conversation with an imported transcript above it, so it gets the
   * ordinary workspace rather than a second, thinner one
   * (docs/policy/external-conversation-continuation.md §8.2).
   */
  initialConversationId?: string | null;
  /** Which surface this mount is, so selecting across surfaces navigates. */
  mountedSurface?: ConversationSurface;
} = {}) {
  let guestDefaultModelId: string = APP_DEFAULTS.guestDefaultModelId;
  // Default-off opt-in (lib/imageGenerationAccess.ts): a read failure keeps
  // the entry points hidden, exactly like a missing flag row.
  let imageGenerationEnabled = false;
  /*
    Voice input's one boolean (docs/policy/voice-input.md §3).

    Three facts folded here and nowhere else: the rollout flag, the kill switch
    (`isVoiceInputEnabled` consults it without a database round trip, so it
    still answers when the database is the thing that is unwell), and the
    signed-in requirement docs/policy/voice-input.md §4 records.

    Resolved on the server for the same reason `imageGroupMaxModels` is: a
    Client Component cannot read the process environment, so a client-side copy
    of the kill switch would keep rendering a microphone after an operator
    pulled it. A read failure leaves it false, exactly like a missing flag row.
  */
  let voiceInputEnabled = false;
  /*
    Whether the welcome screen offers the starter catalogue at all
    (docs/ui-contracts/chat-starter-catalog.md section 5).

    Default-off opt-in with a kill switch, read here rather than in the client
    for the reason `voiceInputEnabled` is: a Client Component cannot read the
    process environment, so a client-side copy would keep painting the gallery
    after an operator pulled the switch. A read failure leaves it false.
  */
  let chatStarterEnabled = false;
  try {
    guestDefaultModelId = (await getPublicAppSettings()).guestDefaultModelId;
    imageGenerationEnabled = await isImageGenerationEnabled();
    // Guests included since 2026-09-10 (docs/policy/voice-input.md §4), so the
    // flag and the kill switch are the whole answer and the session is not
    // consulted. The microphone is offered to whoever the endpoint would
    // serve -- a composer that offered it to a caller the route refuses is the
    // mismatch this prop exists to prevent.
    voiceInputEnabled = await isVoiceInputEnabled();
    chatStarterEnabled = await isChatStarterEnabled();
  } catch (error) {
    // A settings read failure must not change what the guest sees: the
    // compiled-in default resolves to the same brand trio, so the count and
    // price are unchanged and only the lead model's ordering could differ.
    console.error("Failed to load public app settings for chat:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  // The comparison limit this process is running with. Resolved here, per
  // request, from the same function `requestImageGeneration` enforces -- a
  // composer offering more models than admission accepts is a request the UI
  // presented as valid and the server can only refuse, which is what this
  // prop exists to prevent.
  let maxImageModels = imageGroupMaxModels();

  // Which application-managed search backends this process can reach, resolved
  // here for the same reason the image limit is: the client cannot answer it.
  // The only client-side signal would be a public environment variable, and a
  // public variable that says whether a search API key is set is a public
  // variable that says whether a search API key is set. What crosses is one
  // boolean per backend -- never the key, never its name, never the budget.
  const webSearchBackendReadiness = resolveWebSearchBackendReadiness();

  // Playwright override, mirroring the __tomverse_e2e_auth pattern in the
  // application layout: with the database disabled the opt-in flag can never
  // read true, so a test opts in per-context with a cookie. Only honoured in
  // fixture mode (loopback origin + both E2E env vars), and production
  // readiness fails outright if those vars are ever set there
  // (lib/securityEnvironment.ts e2eBypassDisabled).
  if (isE2EFixtureMode()) {
    const jar = await cookies();
    if (!imageGenerationEnabled) {
      imageGenerationEnabled =
        jar.get("__tomverse_e2e_image_generation")?.value === "1";
    }
    // Same shape, same guard. With the database disabled the voice flag can
    // never read true and there is no session to sign in to, so a spec opts in
    // per-context. The cookie stands in for *both* facts the shell folds
    // together above, which is why the composer specs can drive the microphone
    // without an account.
    //
    // The kill switch is asked here for the reason written out below the
    // starter override: `isVoiceInputEnabled()` folds the pulled switch and the
    // stored off into one false, and this cookie may only stand in for the
    // second. Pre-existing rather than introduced by this change, and included
    // because it is the same line three lines away -- left alone, this file
    // teaches the wrong pattern to whoever adds the fourth flag.
    // `isImageGenerationEnabled()` has no kill switch, so its override has
    // nothing to bypass and is unchanged.
    if (!voiceInputEnabled && !voiceInputKillSwitchEngaged(process.env)) {
      voiceInputEnabled = jar.get("__tomverse_e2e_voice_input")?.value === "1";
    }
    // The limit comes from an environment variable read at boot, and the e2e
    // suite runs one server for every test, so a spec cannot restart it to
    // exercise both sides of the limit. The override goes through the same
    // parser rather than trusting the cookie's digits: a test must not be able
    // to reach a value a deployment could not.
    const overrideRaw = jar.get("__tomverse_e2e_image_group_max_models")?.value;
    if (overrideRaw) maxImageModels = resolveImageGroupMaxModels(overrideRaw);
    /*
      Same shape as the two above, and the kill switch is asked again here.

      "The cookie stands in for the stored flag" is the whole of what this
      override may do, and `isChatStarterEnabled()` folds two different reasons
      for false into one boolean -- the row says off, or an operator pulled the
      switch. Testing `!chatStarterEnabled` cannot tell them apart, so the
      cookie turned the gallery back on against a pulled switch. The comment
      that used to sit here claimed the switch still won; it did not.

      Cross review round 1, 2026-09-15 found it. Fixture mode is loopback-only
      and production readiness refuses to boot with its variables set
      (lib/securityEnvironment.ts), so no deployment could serve this -- but a
      spec that passes while the switch is engaged is a spec that would not
      notice the switch breaking, and the switch is this surface's whole
      recovery path.
    */
    chatStarterEnabled = chatStarterEnabledWithFixtureOverride({
      enabledFromSettings: chatStarterEnabled,
      fixtureCookieValue: jar.get("__tomverse_e2e_chat_starter")?.value,
      env: process.env,
    });
  }

  /*
    What the starter catalogue is allowed to promise on this request.

    Two lists rather than one, because "this flag is off" and "nobody here
    reads that flag" are different answers and only the first is a rollout
    state (`StarterViewer.knownFlags`). `CHAT_STARTER_FLAG_KEYS` is derived
    from the catalogue itself, so a card that starts naming a third flag makes
    this resolver's omission visible as a hidden card rather than as a card
    that quietly stopped being gated.
  */
  const starterFlagAnswers: Record<string, boolean> = {
    [IMAGE_GENERATION_FLAG_KEY]: imageGenerationEnabled,
    [VOICE_INPUT_FLAG_KEY]: voiceInputEnabled,
  };
  const starterKnownFlagKeys = CHAT_STARTER_FLAG_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(starterFlagAnswers, key)
  );
  const starterEnabledFlagKeys = starterKnownFlagKeys.filter(
    (key) => starterFlagAnswers[key]
  );
  // Capabilities cross as ids only -- never a key, a backend name or a budget.
  const starterCapabilities = resolveChatStarterCapabilities({
    webSearchBackendReadiness,
  });

  // The verification coordinator wraps the page rather than living inside it,
  // so ChatPageClient itself can ask for a token for a user-initiated action
  // while both shells (and every model panel below them) share the one widget.
  return (
    <GuestVerificationProvider
      siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY}
    >
      <ChatPageClient
        guestDefaultModelId={guestDefaultModelId}
        imageGenerationEnabled={imageGenerationEnabled}
        voiceInputEnabled={voiceInputEnabled}
        // The composer cannot read this itself: `process.env` in a Client
        // Component is substituted at build time, so a client-side copy would
        // keep offering yesterday's limit after a deployment changed it. This
        // page is `force-dynamic`, so the value is the running process's.
        imageGroupMaxModels={maxImageModels}
        webSearchBackendReadiness={webSearchBackendReadiness}
        chatStarterEnabled={chatStarterEnabled}
        chatStarterKnownFlagKeys={starterKnownFlagKeys}
        chatStarterEnabledFlagKeys={starterEnabledFlagKeys}
        chatStarterCapabilities={starterCapabilities}
        initialConversationId={initialConversationId}
        mountedSurface={mountedSurface}
      />
    </GuestVerificationProvider>
  );
}
