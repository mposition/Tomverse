import type { DefaultSession } from "next-auth";
import type { AddressProof } from "@/lib/emailPreferenceCore";

declare module "next-auth" {
    // 💡 기존 Session 인터페이스를 병합(Merge)하여 확장합니다.
    interface Session {
        user: {
            id: string;
            plan?: "Free" | "Pro" | "Max";
            createdAt?: string;
            authenticatedAt?: string;
            /**
             * When the Desktop device's token family was created by a real
             * sign-in. Read by account-sensitive routes only, never by the
             * admin console (lib/desktopSettingsSessionCore.ts).
             */
            desktopAuthenticatedAt?: string;
            /** This session's sign-in created the account (sign-up consent, S4). */
            accountCreatedBySignIn?: boolean;
            /** The login row an email sign-up spent; the consent choice binds to it. */
            signupEmailLoginAttemptId?: string;
            /** What this session's sign-in proved about the address (DOI §14.1). */
            addressProof?: AddressProof;
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
         * Epoch milliseconds a short-lived session ends at for good.
         * It survives NextAuth's re-encoding, which resets
         * `exp` to the normal session length (lib/sessionRevocationCore.ts).
         */
        absoluteExpiresAt?: number;
        desktopSettings?: { family: string; device: string; id: string; authenticatedAt?: string };
        /**
         * True only on the token of the sign-in that created the account. The
         * sign-up screen's choice is consumed by that session and no other: an
         * account another tab created is signed into here with this false.
         */
        accountCreatedBySignIn?: boolean;
        /**
         * The `EmailLoginAttempt` an email sign-up spent, on the token of the
         * sign-in that created the account only. Finalize binds the sign-up
         * choice to this row and no other
         * (docs/policy/email-product-news-redesign-draft.md section 5.2a).
         */
        signupEmailLoginAttemptId?: string;
        /**
         * What the sign-in that issued this token proved about the account's
         * address: this app's code or link, or Google's email_verified
         * (docs/policy/email-double-opt-in.md §14.1). Absent otherwise, and on
         * tokens issued before it existed; a consent from such a session takes
         * the confirmation mail.
         */
        addressProof?: AddressProof;
    }
}
