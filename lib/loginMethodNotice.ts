import "server-only";

import type { Prisma } from "@prisma/client";

import {
  LOGIN_METHOD_LINKED_TEMPLATE,
  LOGIN_METHOD_UNLINKED_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import type { LoginMethodProvider } from "@/lib/loginMethodsCore";
import { prisma } from "@/lib/prisma";
import { ensureTemplateVersion } from "@/lib/emailTemplateRegistry";
import { enqueueStandardEmail } from "@/lib/standardEmailLane";

/**
 * The notice that a login method was added or removed.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.4 (C36,
 * C49), docs/policy/email-notifications.md section 9.4a.
 *
 * It used to be sent after the request, in an `after()` callback, and a failure
 * left an incident and nothing else. So a provider that was slow, or a lock
 * that could not be taken, made a **security notice disappear quietly**: the
 * login method changed, every other device was signed out, and the person it
 * happened to was told nothing.
 *
 * It is a queued message now. The row is written in the same transaction as the
 * change, so a change that rolls back sends nothing and a change that commits
 * has the notice in the queue -- and from there the standard lane's retries,
 * its address lock and its budgets all apply.
 *
 * **Not the credential lane.** That lane exists for messages that die in ten
 * minutes; this one still means what it says an hour later, and it has no
 * credential in it.
 */

/**
 * Registers the template version before the caller opens its transaction.
 *
 * The version has to be fixed first: `enqueueStandardEmail` resolves it, and
 * resolving it inside the caller's transaction would make a registry write part
 * of whether a login method may change. Called here, the enqueue below finds
 * the row already there and only reads it.
 */
export async function prepareLoginMethodNotice(input: {
  action: "linked" | "unlinked";
  language: string | null | undefined;
}) {
  await ensureTemplateVersion({
    templateKey:
      input.action === "linked"
        ? LOGIN_METHOD_LINKED_TEMPLATE
        : LOGIN_METHOD_UNLINKED_TEMPLATE,
    language: input.language ?? "en",
  });
}

/**
 * Queues the notice in the caller's transaction.
 *
 * The address is read here rather than passed in: it is the address the account
 * has at the moment the method changes, under the same transaction that changes
 * it, and a session's copy of it can be older than that.
 */
export async function enqueueLoginMethodNotice(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    action: "linked" | "unlinked";
    method: LoginMethodProvider;
    /**
     * The same value `prepareLoginMethodNotice()` was given.
     *
     * Passed rather than read again: reading it here would let the two
     * disagree -- somebody changing their language between the two reads would
     * leave the enqueue needing a version nobody prepared, and
     * `enqueueStandardEmail` would then register one inside the caller's
     * transaction, which is what preparing it beforehand exists to avoid
     * (independent review, 2026-09-18).
     */
    language: string | null;
  }
) {
  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  });
  // No address, nothing to queue. The change still stands: a login method is
  // not conditional on our being able to write about it.
  if (!user?.email) return;

  await enqueueStandardEmail({
    tx,
    templateKey:
      input.action === "linked"
        ? LOGIN_METHOD_LINKED_TEMPLATE
        : LOGIN_METHOD_UNLINKED_TEMPLATE,
    emailAddress: user.email,
    userId: input.userId,
    language: input.language,
    payload: { method: input.method },
  });
}

/**
 * The language the notice will be written in.
 *
 * Read once, before the transaction, and then handed to both
 * `prepareLoginMethodNotice()` and `enqueueLoginMethodNotice()` -- so the
 * version that was registered is the version the row asks for. Reading it
 * twice would let somebody changing their language in between leave the
 * enqueue needing a version nobody prepared.
 */
export async function loginMethodNoticeLanguage(userId: string) {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { language: true },
  });
  return settings?.language ?? null;
}
