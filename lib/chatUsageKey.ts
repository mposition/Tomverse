import { createHash } from "node:crypto";

/**
 * How a chat subject is named in `ChatUsageBucket."key"`.
 *
 * This lives apart from `lib/chatSecurity.ts` for one reason: that module is
 * `server-only` and pulls in Prisma, so nothing outside a server bundle can
 * import it -- including the Admin Console E2E seeder, which has to write
 * usage rows under the same key the admin routes read them back with.
 *
 * It had been writing `user:<id>` while the application reads
 * `user:<sha256>`, so the seeded rows were simply never found. The E2E
 * customer detail page rendered zero usage and stayed green through a
 * production 500 that only fires when a usage row actually exists. Sharing the
 * derivation is what stops the fixture and the application drifting apart
 * again.
 *
 * The secret is a parameter rather than an ambient read so this module has no
 * environment of its own: `lib/chatSecurity.ts` supplies the running server's
 * `NEXTAUTH_SECRET` (and raises its own configuration error when there is
 * none), and the harness supplies the harness secret.
 */
export const hashChatSubject = (scope: string, value: string, secret: string) =>
  createHash("sha256").update(`${scope}:${value}:${secret}`).digest("hex");

/** The `ChatUsageBucket."key"` every usage and guardrail row for a user carries. */
export const userChatUsageKey = (userId: string, secret: string) =>
  `user:${hashChatSubject("user", userId, secret)}`;
