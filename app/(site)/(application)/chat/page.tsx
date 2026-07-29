export const dynamic = "force-dynamic";

import { APP_DEFAULTS } from "@/lib/appDefaults";
import { getPublicAppSettings } from "@/lib/appSettings";
import { GuestVerificationProvider } from "@/components/chat/GuestVerificationProvider";
import { ChatPageClient } from "./ChatPageClient";

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
export default async function ChatPage() {
  let guestDefaultModelId: string = APP_DEFAULTS.guestDefaultModelId;
  try {
    guestDefaultModelId = (await getPublicAppSettings()).guestDefaultModelId;
  } catch (error) {
    // A settings read failure must not change what the guest sees: the
    // compiled-in default resolves to the same brand trio, so the count and
    // price are unchanged and only the lead model's ordering could differ.
    console.error("Failed to load public app settings for chat:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  // The verification coordinator wraps the page rather than living inside it,
  // so ChatPageClient itself can ask for a token for a user-initiated action
  // while both shells (and every model panel below them) share the one widget.
  return (
    <GuestVerificationProvider
      siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY}
    >
      <ChatPageClient guestDefaultModelId={guestDefaultModelId} />
    </GuestVerificationProvider>
  );
}
