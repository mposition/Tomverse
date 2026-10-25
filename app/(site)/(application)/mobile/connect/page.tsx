export const dynamic = "force-dynamic";

import { redirect, notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isPkceChallenge } from "@/lib/mobileLoginGrant";
import { mobileAuthReady } from "@/lib/mobileAccessToken";
import { mobileChatEnabled } from "@/lib/mobileChatContract";
import { MobileConnectGrant } from "@/components/auth/MobileConnectGrant";
import { mobileAppLinkOrigin, mobileAppLinks } from "@/lib/mobileAppLinks";

export const metadata = { title: "Connect your Tomverse app", robots: { index: false, follow: false } };

export default async function MobileConnectPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!mobileChatEnabled() || !mobileAuthReady()) notFound();
  const query = await searchParams;
  const challenge = query.codeChallenge;
  if (typeof challenge !== "string" || !isPkceChallenge(challenge)) notFound();
  const session = await getServerSession(authOptions);
  const links = mobileAppLinks();
  const returnToApp = query.returnTo === "app" && (links.android.length > 0 || links.ios.length > 0);
  if (!session?.user?.id) {
    const callback = `/mobile/connect?codeChallenge=${encodeURIComponent(challenge)}${returnToApp ? "&returnTo=app" : ""}`;
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(callback)}`);
  }
  return <MobileConnectGrant challenge={challenge} returnToApp={returnToApp} returnOrigin={mobileAppLinkOrigin() ?? ""} />;
}
