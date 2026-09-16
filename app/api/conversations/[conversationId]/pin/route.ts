import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

/**
 * Pin or unpin one conversation.
 *
 * ## Why this is not part of the conversation PATCH
 *
 * `Conversation.updatedAt` is `@updatedAt`, and the sidebar groups its rows by
 * it (`lib/conversationListGrouping.ts`). Any Prisma `update` would therefore
 * move the conversation into 오늘 and tell its owner it was answered today --
 * from an action that answered nothing. So the columns are written with raw
 * SQL, which touches exactly the columns named here.
 *
 * The write is also scoped by `userId` in the statement itself rather than
 * after a read: somebody else's conversation is "not found", and there is no
 * branch that could report the difference.
 *
 * ## Why every write carries a sequence
 *
 * A client cannot put its own writes in order. A request whose connection
 * dropped may still be applied here afterwards: the browser saw a failure, the
 * database saw a write.
 *
 * A compare-and-set on the version the client last *saw* does not fix that.
 * Two taps that both fail on the wire teach the client nothing, so both name
 * the same version, and whichever the server happens to run first wins -- which
 * need not be the last tap.
 *
 * So the order belongs to the tap. `seq` is issued by the client when the tap is
 * made, above every write that client made which may still land, whether or not
 * anything came back; this statement applies only a sequence greater than the
 * one the column holds.
 * Whatever order the requests arrive in, the column ends on the highest
 * sequence -- the last tap -- and an older one landing late matches no row.
 */

/**
 * `ownerId` is the account the caller believed it was acting as. A pin can be
 * queued behind a slower one and go out after a sign-out, and no client-side
 * check can know that before the request is answered -- the session cookie has
 * already changed by then. It is the session's own id, so it grants nothing: a
 * wrong one can only cause a refusal.
 */
const pinSchema = z
  .object({
    pinned: z.boolean(),
    // A millisecond-scale integer. Bounded to what a double stores exactly,
    // which is also what the column is.
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ownerId: z.string().nullable().optional(),
  })
  .strict();

type PinRow = { pinned: boolean; pinSeq: number };

/**
 * How far ahead of this server's clock a sequence may be.
 *
 * A sequence is a client's clock reading, and a write applies only over a
 * smaller one -- so a single value far in the future would hold the row against
 * every later tap until the real clock caught up. `Number.MAX_SAFE_INTEGER`
 * would hold it for good: the next sequence would not even be representable.
 * An hour covers any device whose clock is merely wrong in the ordinary way; a
 * device further ahead than that has its pin writes refused, which is the
 * smaller harm than letting it lock everyone else out of the row.
 */
const MAX_SEQUENCE_LEAD_MS = 60 * 60 * 1000;

export async function PUT(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]/pin">
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "conversation-pin", {
      minute: 60,
      day: 1000,
    });

    const { conversationId } = await context.params;
    if (!conversationId) {
      return NextResponse.json({ error: "Conversation ID is required." }, { status: 400 });
    }

    const { pinned, seq, ownerId } = await readLimitedJson(req, 1024, pinSchema);

    if (seq > Date.now() + MAX_SEQUENCE_LEAD_MS) {
      return NextResponse.json(
        {
          code: "PIN_SEQUENCE_OUT_OF_RANGE",
          error: "This device's clock is too far ahead to order the change.",
        },
        { status: 400 }
      );
    }

    if (ownerId != null && ownerId !== userId) {
      // The account changed between queueing this write and sending it. The
      // `userId` condition below would match no row anyway; answering here says
      // why, and keeps a stale intent from reading as "conversation gone" to
      // whoever is signed in now.
      return NextResponse.json(
        {
          code: "PIN_OWNER_CHANGED",
          error: "The signed-in account changed before this change was sent.",
        },
        { status: 409 }
      );
    }

    // `COALESCE` keeps the original moment on a re-pin rather than resetting
    // it: pinning something already pinned is not a new decision about when.
    const applied = await prisma.$queryRaw<PinRow[]>`
      UPDATE "Conversation"
      SET "pinnedAt" = CASE WHEN ${pinned} THEN COALESCE("pinnedAt", NOW()) ELSE NULL END,
          "pinSeq" = ${seq}::double precision
      WHERE "id" = ${conversationId}
        AND "userId" = ${userId}
        AND "pinSeq" < ${seq}::double precision
      RETURNING ("pinnedAt" IS NOT NULL) AS "pinned", "pinSeq"
    `;

    if (applied.length === 1) {
      return NextResponse.json({
        pinned: applied[0].pinned,
        pinSeq: Number(applied[0].pinSeq),
      });
    }

    // No row: either it is not this account's, or a later tap already landed.
    const current = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { pinnedAt: true, pinSeq: true },
    });
    if (!current) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    // A tap made later than this one has already been written. Nothing was
    // written now; the caller gets what the column holds and follows it.
    return NextResponse.json(
      {
        code: "PIN_SUPERSEDED",
        error: "A later change to this conversation's pin has already been saved.",
        pinned: current.pinnedAt !== null,
        pinSeq: current.pinSeq,
      },
      { status: 409 }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    console.error("Failed to update conversation pin:", error);
    return NextResponse.json({ error: "Failed to update the pin." }, { status: 500 });
  }
}
