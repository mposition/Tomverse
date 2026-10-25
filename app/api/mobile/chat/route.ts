export const dynamic = "force-dynamic";

import { POST as postChat } from "@/app/api/chat/route";
import { resolveChatRequestSession } from "@/lib/chatRequestSession";

/** Native and web share the provider, budget, safety, and location execution. */
export const POST = postChat;

export async function GET(request: Request) {
  const auth = await resolveChatRequestSession(request);
  if (!auth.ok) return auth.response;
  return Response.json({ userId: auth.session!.user!.id }, {
    headers: { "Cache-Control": "no-store" },
  });
}
