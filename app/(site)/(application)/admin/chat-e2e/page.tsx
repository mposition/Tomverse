import { getServerSession } from "next-auth/next";
import { notFound } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { chatE04StagingFixtureEligible } from "@/lib/chatE04StagingFixture";
import { ChatE04FixtureWorkspace } from "./ChatE04FixtureWorkspace";

export const dynamic = "force-dynamic";
export default async function ChatE04QaPage() {
  const session = await getServerSession(authOptions);
  if (!chatE04StagingFixtureEligible({ environment: process.env,
    authenticated: Boolean(session?.user?.id), administrator: isAdminSession(session) })) notFound();
  return <ChatE04FixtureWorkspace />;
}
