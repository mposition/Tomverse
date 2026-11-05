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

/** Where the section lives, for a form submit to land back on. */
const SECTION_PATH = "/admin/agent-digests?tab=trust-safety";

const isFormSubmission = (request: Request) =>
  (request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded");

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Answers a form submit with a redirect back to the section, and anything else
 * with the JSON.
 *
 * A refusal travels as `?refused=<code>` so the panel can say what happened --
 * §6 wants the operator to see the reason, not a blank page -- and the code is
 * one of the closed sets, never free text.
 */
const answer = (
  request: Request,
  body: { error?: string; code?: string; ok?: true; result?: unknown },
  status: number,
): Response => {
  if (!isFormSubmission(request)) return json(body, status);
  const target =
    status >= 200 && status < 300
      ? SECTION_PATH
      : `${SECTION_PATH}&refused=${encodeURIComponent(body.code ?? "refused")}`;
  return new Response(null, {
    status: 303,
    headers: { Location: target, "Cache-Control": "no-store" },
  });
};

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return answer(request, { error: "Not found." }, 404);
    }
    if (!hasAdminPermission(session, "trust-safety:write")) {
      return answer(
        request,
        { error: "Trust-safety write access is required.", code: "TRUST_SAFETY_WRITE_REQUIRED" },
        403,
      );
    }
    await assertRecentAdminAuthentication(session);

    const raw = await request.text();
    if (raw.length > BODY_MAX_BYTES) {
      return answer(request, { error: "Refused.", code: "body_too_large" }, 413);
    }
    // Two shapes: the section's form, and JSON for anything calling this
    // directly. The form exists because §5.6 does not allow the panel's files
    // to name `fetch`, so the control is a plain submit.
    const submitted = isFormSubmission(request)
      ? { mode: new URLSearchParams(raw).get("mode") }
      : parseJson(raw);
    const parsed = bodySchema.safeParse(submitted);
    if (!parsed.success) {
      return answer(request, { error: "Refused.", code: "invalid_request" }, 400);
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
      return answer(request, { error: "Refused.", code: outcome.result }, 409);
    }
    return answer(request, { ok: true, result: outcome }, 200);
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      // The remedy, not a bare refusal: the panel needs a code it can turn
      // into the reauthentication link (§6).
      return answer(
        request,
        { error: "Recent sign-in required.", code: "reauthentication_required" },
        403,
      );
    }
    if (isBudgetInsufficient(error) || error instanceof TrustSafetyRoundRefused) {
      // The transaction refused to start, or refused a statement past the
      // budget §12 approved. Nothing was written (§5.5) and the switch is
      // where it was.
      return answer(request, { error: "Refused.", code: "late" }, 409);
    }
    console.error(
      JSON.stringify({
        event: "trust_safety_activation_failed",
        errorName: error instanceof Error ? error.name : "unknown",
      }),
    );
    return answer(request, { error: "Internal error.", code: "internal" }, 500);
  }
}
