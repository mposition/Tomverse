export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  drainDueMarketingApprovals,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z.object({}).strict();

/**
 * POST: expire a bounded batch of the approvals that came due while this
 * account was paused, without resuming it
 * (docs/policy/marketing-automation.md §8.2).
 *
 * A resume expires due approvals in its own transaction, and it can only do a
 * bounded amount of that: every expiry is a locked row, a conditional update
 * and an audit append, and the append holds the audit chain's advisory lock
 * that every other audit write in the process is queueing behind. An account
 * that accumulated more due posts than one transaction may touch could
 * therefore not resume at all -- each attempt did the same work again and
 * timed out, and the rollback meant the next attempt faced the identical set.
 *
 * So the backlog is cleared here instead, a batch at a time, with the account
 * staying exactly where it is. `paused` is the state that keeps the publisher
 * away from those posts, so nothing goes out while the drain runs, and every
 * post this expires gets its own system audit row naming both reasons it was
 * due. The response says whether more remain; the operator calls it again
 * until it does not.
 *
 * It is not gated on the kill switch. The only state it can put a post into is
 * `approval_expired`, so there is no reachable outcome in which something is
 * published -- and an account that could not be drained while the switch was
 * on could not be resumed after it came off.
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountDrainDueApprovals,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Expired a batch of due approvals on a paused brand account.",
    gate: "operator_restriction",
    bucket: "admin-marketing-account-drain",
    schema,
    metadata: () => ({}),
    run: async (tx) => {
      const { expiredPostIds, remaining } = await drainDueMarketingApprovals(tx, {
        id: channelId,
      });
      return { id: channelId, expiredPostIds, remaining };
    },
  });
}
