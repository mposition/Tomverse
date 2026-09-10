// components/auth/SessionProviderWrapper.tsx
"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { hasAuthenticatedSessionUser } from "@/lib/sessionIdentity";

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

    return <SessionProvider session={initialSession}>{children}</SessionProvider>;
}
