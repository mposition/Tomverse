import "server-only";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireMobileBearer } from "@/lib/mobileAuthRoute";
import { MOBILE_CHAT_PATH, mobileChatEnabled } from "@/lib/mobileChatContract";

export const resolveChatRequestSession = async (request: Request): Promise<
  { ok: true; session: Session | null } | { ok: false; response: Response }
> => {
  if (new URL(request.url).pathname !== MOBILE_CHAT_PATH) {
    return { ok: true, session: await getServerSession(authOptions) };
  }
  if (!mobileChatEnabled()) {
    return { ok: false, response: Response.json({ code: "MOBILE_CHAT_DISABLED" }, { status: 503 }) };
  }
  // Verify independently of Proxy. Cookie identities never enter this path.
  const auth = await requireMobileBearer(request);
  if (!auth.ok) return auth;
  const account = await prisma.user.findUnique({
    where: { id: auth.identity.userId }, select: { id: true, email: true, name: true },
  });
  if (!account) {
    return { ok: false, response: Response.json({ code: "MOBILE_REFRESH_REJECTED" }, { status: 401 }) };
  }
  return { ok: true, session: {
    user: { id: account.id, email: account.email, name: account.name },
    expires: new Date(Date.now() + 60_000).toISOString(),
  } };
};
