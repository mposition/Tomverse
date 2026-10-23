// components/auth/SessionProviderWrapper.tsx
"use client";

import { SessionProvider, useSession } from "next-auth/react";
import { useEffect } from "react";
import { bindOfflineChatDraftOwner, clearOfflineAccountDraft } from "@/lib/chatOfflineDraft";
import type { Session } from "next-auth";
import { hasAuthenticatedSessionUser } from "@/lib/sessionIdentity";

function OfflineDraftIdentityBoundary({ children }: { children: React.ReactNode }) {
    const { data, status } = useSession();
    const owner = status === "loading" ? undefined : data?.user?.id ? `account:${data.user.id}` : null;
    useEffect(() => { if (owner === undefined) return; if (owner) bindOfflineChatDraftOwner(owner); else clearOfflineAccountDraft(); }, [owner]);
    return children;
}

export default function SessionProviderWrapper({
    children,
    session,
}: {
        children: React.ReactNode;
        session?: Session | null;
}) {
    // `undefined` means the caller did not resolve a server session, so keep
    // NextAuth's client-side initial fetch. A resolved but identity-less
    // session is different: the server rejected that JWT and the client must
    // see the same unauthenticated state.
    const initialSession =
        session === undefined
            ? undefined
            : hasAuthenticatedSessionUser(session)
              ? session
              : null;

    return <SessionProvider session={initialSession}><OfflineDraftIdentityBoundary>{children}</OfflineDraftIdentityBoundary></SessionProvider>;
}
