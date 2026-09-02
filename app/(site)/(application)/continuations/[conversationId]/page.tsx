export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";

import { WebSearchBackendReadinessProvider } from "@/components/chat/WebSearchBackendReadinessProvider";
import { ContinuedConversationWorkspace } from "@/components/continuations/ContinuedConversationWorkspace";
import { authOptions } from "@/lib/auth";
import {
    effectivePlanModelLimit,
    getUserBillingPlan,
} from "@/lib/billingEntitlements";
import { getDefaultBillingPlan } from "@/lib/billingPlanDefaults";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";

/**
 * `/continuations/[conversationId]` — where a conversation continued from an
 * imported chat is read and continued.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8, and
 * `lib/continuationRoutes.ts` for why this is its own path rather than
 * `/review`. A continuation is `productKey = "review"` (§3.1); it opens here
 * because the Review workspace knows nothing about imported transcripts, not
 * because it belongs to a different product.
 *
 * Nothing is gated here. The rollout flag governs *creating* a continuation
 * and *seeding* a turn from one; opening a conversation that already exists,
 * and the messages the owner wrote in it, are never behind it — a rollback
 * must not take away work somebody already did (§7).
 *
 * ## Why the plan limit is resolved here
 *
 * §8.3: the model cap reaches the composer as a prop resolved on the server,
 * from the same `effectivePlanModelLimit()` that
 * `PATCH /api/conversations/[conversationId]` applies. A client that worked
 * the number out for itself would ask the owner to choose a replacement they
 * did not need, or send a change the server then refuses.
 *
 * The signed-out case still renders: the workspace's own load answers 401 and
 * shows the sign-in notice, and the numbers below are the Free plan's, which
 * nothing acts on until there is a session.
 *
 * And a plan that cannot be read does not blank the screen. The number decides
 * only *when the screen asks which model to replace*; the PATCH route is what
 * actually enforces the cap, so falling back to the Free plan's is a
 * conservative answer rather than a wrong one — and a conversation the owner
 * has already paid for must stay readable when a lookup fails, exactly as §7
 * requires of a rollback.
 */
const readPlanOrFreeFallback = async () => {
    try {
        const session = await getServerSession(authOptions);
        return await getUserBillingPlan(session?.user?.id ?? "");
    } catch {
        // The compiled defaults, not another database read: this branch exists
        // precisely because the database did not answer.
        return getDefaultBillingPlan("free");
    }
};

export default async function ContinuedConversationPage({
    params,
}: {
    params: Promise<{ conversationId: string }>;
}) {
    const { conversationId } = await params;
    const plan = await readPlanOrFreeFallback();
    // Which application-managed search backends this deployment can reach.
    // Booleans only -- no credential and no environment variable name crosses
    // the boundary (components/chat/WebSearchBackendReadinessProvider.tsx).
    const webSearchBackendReadiness = resolveWebSearchBackendReadiness();

    return (
        <main>
            <WebSearchBackendReadinessProvider
                readiness={webSearchBackendReadiness}
            >
                <ContinuedConversationWorkspace
                    conversationId={conversationId}
                    maxModels={effectivePlanModelLimit(plan)}
                    planTier={plan.tier}
                />
            </WebSearchBackendReadinessProvider>
        </main>
    );
}
