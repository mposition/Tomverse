/**
 * E3: the owner turns the trust-safety observer's observation on or off
 * (docs/policy/trust-safety-compliance-agent.md §3, §5.6, §6).
 *
 * Owner only. §6 gives `trust-safety:write` to the owner alone and calls the
 * switch a person's action, not a capability of the agent: §3 lists activation
 * among the things that stay with a person because they are judgements.
 *
 * In order, and the order matters: who is calling, then whether their sign-in
 * is recent enough, then the body. A non-administrator is told nothing about
 * what is here (404), a wrong role is refused (403), and a stale step-up
 * answers `reauthentication_required` so the screen can draw the link
 * `docs/ui-contracts/admin-console-ia.md` requires -- §6 calls a toast on its
 * own a defect, and a bare 403 gives the panel nothing to draw with.
 *
 * **Why this route builds its own responses and reads its own body.** §5.6's
 * boundary is six shared modules and (ㄴ') closes the outside-repo specifiers
 * at eight. `next/server` is not among them, and `lib/apiSecurity.ts` and
 * `lib/adminApproval.ts` are not boundary modules -- calling them would pull
 * their own imports into this agent's files, where the section's rules apply
 * and reject them. So the familiar admin-route helpers are not available here:
 * the JSON is built with `Response`, and the body is read and capped below.
 *
 * What that costs, said plainly: no shared rate limit. The route is the
 * owner's alone behind a recent sign-in, the store refuses anything that is
 * not a transition without writing, and the row's trigger refuses a version
 * that does not move forward -- so a repeated request writes nothing. A limit
 * would still be better, and it is unavailable rather than unwanted.
 *
 * The write itself is `lib/trustSafetyActivationStore.ts`: one transaction
 * holding the config row and its audit entry, the only pair §5.6 allows here.
 */

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { authOptions } from "@/lib/auth";
import { TRUST_SAFETY_MODES } from "@/lib/trustSafetyActivationCore";
import { setTrustSafetyActivation } from "@/lib/trustSafetyActivationStore";
import { TrustSafetyRoundRefused, isBudgetInsufficient } from "@/lib/trustSafetyTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The request names the mode and nothing else (§6: the value is one of two). */
const bodySchema = z
  .object({ mode: z.enum(TRUST_SAFETY_MODES as unknown as [string, ...string[]]) })
  .strict();

/** Larger than any valid body for this route by a wide margin. */
const BODY_MAX_BYTES = 1024;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return json({ error: "Not found." }, 404);
    }
    if (!hasAdminPermission(session, "trust-safety:write")) {
      return json(
        { error: "Trust-safety write access is required.", code: "TRUST_SAFETY_WRITE_REQUIRED" },
        403,
      );
    }
    await assertRecentAdminAuthentication(session);

    const raw = await request.text();
    if (raw.length > BODY_MAX_BYTES) {
      return json({ error: "Refused.", code: "body_too_large" }, 413);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return json({ error: "Refused.", code: "invalid_request" }, 400);
    }
    const parsed = bodySchema.safeParse(parsedJson);
    if (!parsed.success) {
      return json({ error: "Refused.", code: "invalid_request" }, 400);
    }

    const outcome = await setTrustSafetyActivation({
      session,
      request,
      requested: parsed.data.mode,
    });

    // §6 answers 409 and writes nothing -- for a request that is not a
    // transition, for the same mode again (the double click), and for a
    // missing integrity key, which it refuses before opening the write
    // because an entry this build cannot sign is one the observer's own
    // checks will not verify.
    if (outcome.result !== "changed") {
      return json({ error: "Refused.", code: outcome.result }, 409);
    }
    return json({ ok: true, result: outcome }, 200);
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      // The remedy, not a bare refusal: the panel needs a code it can turn
      // into the reauthentication link (§6).
      return json(
        { error: "Recent sign-in required.", code: "reauthentication_required" },
        403,
      );
    }
    if (isBudgetInsufficient(error) || error instanceof TrustSafetyRoundRefused) {
      // The transaction refused to start, or refused a statement past the
      // budget §12 approved. Nothing was written (§5.5) and the switch is
      // where it was.
      return json({ error: "Refused.", code: "late" }, 409);
    }
    console.error(
      JSON.stringify({
        event: "trust_safety_activation_failed",
        errorName: error instanceof Error ? error.name : "unknown",
      }),
    );
    return json({ error: "Internal error." }, 500);
  }
}
