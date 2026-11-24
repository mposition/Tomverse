import { getServerSession } from "next-auth/next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { desktopAuthEnabled, desktopLoginContext } from "@/lib/desktopAuthServer";
import { DESKTOP_IDENTITY_PROVIDERS } from "@/lib/desktopAuthContract";
import { isPkceChallenge } from "@/lib/mobileLoginGrant";
import { DesktopLoginContent } from "./DesktopLoginContent";

const query = z.object({
  client_id: desktopLoginContext.clientId,
  redirect_uri: desktopLoginContext.redirectUri,
  state: desktopLoginContext.state,
  code_challenge: z.string().refine(isPkceChallenge),
  code_challenge_method: z.literal("S256"),
  provider: z.enum(DESKTOP_IDENTITY_PROVIDERS).optional(),
});

export const dynamic = "force-dynamic";

export default async function DesktopLoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!desktopAuthEnabled()) notFound();
  const parsed = query.safeParse(await searchParams);
  if (!parsed.success) notFound();
  const { provider, ...params } = parsed.data;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    // Only the login context goes into a new sign-in redirect. The original
    // landing URL still carries the web signup consent marker for its finalizer.
    const callback = `/auth/desktop?${new URLSearchParams(params)}`;
    const signIn = new URLSearchParams({ callbackUrl: callback });
    if (provider) signIn.set("desktopProvider", provider);
    redirect(`/auth/signin?${signIn}`);
  }
  return <DesktopLoginContent
    clientId={params.client_id}
    redirectUri={params.redirect_uri}
    state={params.state}
    codeChallenge={params.code_challenge}
    account={session.user.email ?? session.user.name}
  />;
}
