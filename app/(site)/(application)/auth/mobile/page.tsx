import { getServerSession } from "next-auth/next";
import { notFound, redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { MobileLoginContent } from "./MobileLoginContent";

export const dynamic = "force-dynamic";
export default async function MobileLoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.TOMVERSE_NATIVE_CHAT_ENABLED !== "true") notFound();
  const params = await searchParams;
  const challenge = params.code_challenge; const state = params.state;
  if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) notFound();
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    const callback = `/auth/mobile?${new URLSearchParams({ code_challenge: challenge, state })}`;
    redirect(`/auth/signin?${new URLSearchParams({ callbackUrl: callback })}`);
  }
  return <MobileLoginContent challenge={challenge} state={state} />;
}
