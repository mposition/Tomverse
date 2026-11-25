import { desktopAuthResponse, requireDesktopBearer } from "@/lib/desktopAuthServer";
import { isLanguage } from "@/lib/language";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireDesktopBearer(request);
  if (!auth.ok) return auth.response;
  const account = await prisma.user.findUnique({
    where: { id: auth.identity.userId },
    select: { id: true, name: true, email: true, accountStatus: true, settings: { select: { language: true } } },
  });
  if (!account || account.accountStatus !== "active") return desktopAuthResponse({ ok: false, code: "UNAUTHORIZED" }, 401);
  const language = account.settings?.language;
  return desktopAuthResponse({ ok: true, account: {
    id: account.id, name: account.name, email: account.email, ...(isLanguage(language) ? { language } : {}),
  } });
}
