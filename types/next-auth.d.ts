import type { DefaultSession } from "next-auth";

declare module "next-auth" {
    // 💡 기존 Session 인터페이스를 병합(Merge)하여 확장합니다.
    interface Session {
        user: {
            id: string;
            plan?: "Free" | "Pro" | "Max";
            createdAt?: string;
            authenticatedAt?: string;
            /** This session's sign-in created the account (sign-up consent, S4). */
            accountCreatedBySignIn?: boolean;
        } & DefaultSession["user"];
    }
}

declare module "next-auth/jwt" {
    interface JWT {
        id?: string;
        plan?: "Free" | "Pro" | "Max";
        createdAt?: string;
        authenticatedAt?: string;
        /**
         * Epoch milliseconds at which this token was issued. Compared against
         * `User.sessionsRevokedAt` so revocation works without a session table.
         */
        sessionIssuedAt?: number;
        /**
         * True only on the token of the sign-in that created the account. The
         * sign-up screen's choice is consumed by that session and no other: an
         * account another tab created is signed into here with this false.
         */
        accountCreatedBySignIn?: boolean;
    }
}
