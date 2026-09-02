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

import type { ReactNode } from "react";
import { cookies } from "next/headers";
import type { ConversationSurface } from "@/lib/continuationRoutes";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  getPublicAppSettings,
  isImageGenerationEnabled,
  isVoiceInputEnabled,
} from "@/lib/appSettings";
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
  conversationPrelude = null,
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
  /** The read-only imported half, rendered above the panel row. */
  conversationPrelude?: ReactNode;
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
  try {
    guestDefaultModelId = (await getPublicAppSettings()).guestDefaultModelId;
    imageGenerationEnabled = await isImageGenerationEnabled();
    if (await isVoiceInputEnabled()) {
      const session = await getServerSession(authOptions);
      voiceInputEnabled = Boolean(session?.user?.id);
    }
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
    if (!voiceInputEnabled) {
      voiceInputEnabled = jar.get("__tomverse_e2e_voice_input")?.value === "1";
    }
    // The limit comes from an environment variable read at boot, and the e2e
    // suite runs one server for every test, so a spec cannot restart it to
    // exercise both sides of the limit. The override goes through the same
    // parser rather than trusting the cookie's digits: a test must not be able
    // to reach a value a deployment could not.
    const overrideRaw = jar.get("__tomverse_e2e_image_group_max_models")?.value;
    if (overrideRaw) maxImageModels = resolveImageGroupMaxModels(overrideRaw);
  }

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
        initialConversationId={initialConversationId}
        mountedSurface={mountedSurface}
        conversationPrelude={conversationPrelude}
      />
    </GuestVerificationProvider>
  );
}
