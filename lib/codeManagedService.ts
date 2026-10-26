import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { getAdminRole } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { recordChatLimitDecision } from "@/lib/chatLimitDecisions";
import { lockCreditAccount, offsetCreditDebt } from "@/lib/creditDebt";
import { AddOnCreditError, reserveAddOnCredits, settleAddOnCredits, type AddOnCreditReservationEntry } from "@/lib/creditLedger";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import { getUserDayWindow } from "@/lib/userDailyUsage";
import { assertUserOperationalAccess, getChatCostGuardrails, getUserChatUsageKey, holdChatUsageBucket, readUsageBucketCount, usagePeriodStart } from "@/lib/chatSecurity";
import { getBillingPlanByTier, getBillingPlansWithFieldSources, planIdForTier } from "@/lib/billingConfig";
import { effectivePlanForAccess, STORE_ENTITLEMENT_SELECT } from "@/lib/foundingTesterPassCore";
import { getProviderCostBudget } from "@/lib/providerCostBudget";
import { providerBucketKey } from "@/lib/chatProviderHolds";
import { COST_PER_CREDIT_CEILING_MICRO_USD } from "@/lib/chatCostGuardrails";
import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
import { loadCodingCatalog, servableCodingRows } from "@/lib/modelCatalog";
import { canonicalJson, codingProfileSchema, type CodingCatalogRow } from "@/lib/modelCatalogCore";
import { isAiProvider } from "@/lib/modelRegistryShared";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import { getModelPricingProfile, resolveModelPricing } from "@/lib/modelPricing";
import { getWeightedUsageCredits, getSettledUsageCredits, type AiModel, type ModelTier } from "@/lib/models";
import { prepareCodeProvider, codeProviderCredentialReady, type CodeProviderResult } from "@/lib/codeManagedProvider";
import { CODE_TASK_TTL_MS, CODE_HEARTBEAT_INTERVAL_MS, CODE_PROVIDER_TIMEOUT_MS, CODE_MAX_OUTPUT_TOKENS, codeBilling, codeCallCeiling, codeConcurrentCalls, codeManagedEnabled, codeSchemaAndPrompt, codeTaskLimit, validCodeUsage, codeManagedReconciliationSchema, type CodeManagedReconciliation, type CodeManagedRequest, type CompleteRequest, type CodeModelPair, type ReserveRequest } from "@/lib/codeManagedCore";
type Tx = Prisma.TransactionClient;
type Task = {
    id: string;
    userId: string | null;
    subjectKey: string;
    clientTaskId: string;
    requestDigest: string;
    status: string;
    catalogVersion: number;
    contentHash: string;
    modelPair: CodeModelPair;
    reservedCredits: number;
    settledCredits: number;
    releasedCredits: number;
    planHeldCredits: number;
    planDayHeld: boolean;
    addOnEntries: AddOnCreditReservationEntry[];
    reservedCostMicroUsd: bigint;
    settledCostMicroUsd: bigint;
    heldCostMicroUsd: bigint;
    planHeldCostMicroUsd: bigint;
    planFundingShare: number;
    dayStart: Date;
    monthStart: Date;
    leaseExpiresAt: Date;
    createdAt: Date;
};
type Call = {
    id: string;
    reservationId: string;
    requestDigest: string;
    role: string;
    modelId: string;
    provider: string;
    status: string;
    reservedCredits: number;
    settledCredits: number;
    reservedCostMicroUsd: bigint;
    settledCostMicroUsd: bigint | null;
    inputTokens: number | null;
    outputTokens: number | null;
    maxOutputTokens: number;
    pricingSnapshot: {
        input: number;
        output: number;
        cached: number;
        maxInput: number;
        cacheWrite?: number;
    };
    resolutionId: string | null;
    resolutionDigest: string | null;
    resolutionAuditId: string | null;
    createdAt: Date;
};
export class CodeManagedError extends ApiSecurityError {
    constructor(status: number, code: string, public readonly dispatchState: "not_dispatched" | "dispatched" = "not_dispatched", public readonly receipt?: unknown, public readonly metadata?: Pick<CodeProviderResult, "usage" | "latencyMs" | "providerReportedModelId">) {
        super(status, code, "The managed Code request could not be completed.");
    }
}
const fail = (status: number, code: string): never => { throw new CodeManagedError(status, code); };
const digest = (value: unknown) => {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret)
        return fail(503, "SECURITY_NOT_CONFIGURED");
    return createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
};
const tasks = (tx: Tx, id: string, userId: string) => tx.$queryRaw<Task[]> `SELECT * FROM "CodeTaskReservation" WHERE "id"=${id} AND "userId"=${userId}`;
const calls = (tx: Tx, id: string) => tx.$queryRaw<Call[]> `SELECT * FROM "CodeManagedCall" WHERE "reservationId"=${id} ORDER BY "createdAt","id"`;
const numeric = (value: bigint) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0)
        return fail(503, "CODE_ACCOUNTING_UNAVAILABLE");
    return n;
};
async function transaction<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await lockCreditAccount(tx, userId);
        // Settings moves current daily buckets under this same subject lock.
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${getUserChatUsageKey(userId)}))`;
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${`code-task:${userId}`}))`;
        return fn(tx);
    });
}
const receipt = (task: Task, records: Call[]) => ({ reservationId: task.id, state: records.some(c => c.status === "outcome_unknown") ? "outcome_unknown" : task.status === "active" ? "active" : records.some(c => c.status === "dispatched") ? "outcome_unknown" : task.status,
    localBudgetUsd: numeric(task.reservedCostMicroUsd) / 1000000, leaseExpiresAt: task.leaseExpiresAt.toISOString(),
    heartbeatIntervalMs: CODE_HEARTBEAT_INTERVAL_MS, modelPair: task.modelPair, billing: codeBilling(task, records) });
async function account(userId: string, tx?: Tx) {
    if (!tx)
        await assertUserOperationalAccess(userId);
    const user = await (tx ?? prisma).user.findUnique({ where: { id: userId }, select: { plan: true, ...STORE_ENTITLEMENT_SELECT, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true, billingRiskStatus: true,
            accountStatus: true, accountSuspendedUntil: true, aiUsageRestricted: true, aiUsageRestrictedUntil: true } });
    const now = new Date();
    if (!user || user.billingRiskStatus === "disputed_hold" || user.accountStatus === "pending_deletion" ||
        (user.accountStatus === "suspended" && (!user.accountSuspendedUntil || user.accountSuspendedUntil > now)) ||
        (user.aiUsageRestricted && (!user.aiUsageRestrictedUntil || user.aiUsageRestrictedUntil > now)))
        return fail(403, "CODE_ACCOUNT_UNAVAILABLE");
    const plan = effectivePlanForAccess(user) as ModelTier;
    const limits = tx ? (await getBillingPlansWithFieldSources(tx)).find(row => row.plan.id === planIdForTier(plan))?.plan : await getBillingPlanByTier(plan);
    if (!limits)
        return fail(503, "CODE_ACCOUNTING_UNAVAILABLE");
    return { plan, limits };
}
function assertPairPlan(pair: CodeModelPair, plan: ModelTier) {
    const rank = { Free: 0, Pro: 1, Max: 2 };
    if ([pair.executor, pair.reviewer].some(row => rank[plan] < rank[row.minimumPlan]))
        return fail(403, "CODE_MODEL_PLAN_FORBIDDEN");
}
async function modelPair(userId: string, request: Pick<ReserveRequest, "catalogVersion" | "contentHash" | "executorModelId" | "reviewerModelId">) {
    const { plan, limits } = await account(userId);
    const snapshot = await prisma.modelCatalogSnapshot.findUnique({ where: { version: request.catalogVersion } });
    if (!snapshot || snapshot.category !== "coding" || snapshot.contentHash !== request.contentHash)
        return fail(409, "CODE_CATALOG_CHANGED");
    if (snapshot.coverageUntil.getTime() <= Date.now())
        return fail(409, "CODE_CATALOG_STALE");
    const rows = (snapshot.payload as {
        models?: unknown[];
    })?.models;
    if (!Array.isArray(rows))
        return fail(503, "CODE_CATALOG_INVALID");
    const available = servableCodingRows(await loadCodingCatalog());
    const resolve = async (id: string) => {
        const raw = rows.find(r => r && typeof r === "object" && (r as {
            modelId?: unknown;
        }).modelId === id) as Record<string, unknown> | undefined;
        if (!raw)
            return fail(403, "CODE_MODEL_UNAVAILABLE");
        const profile = { ...raw };
        delete profile.modelId;
        const parsed = codingProfileSchema.safeParse(profile);
        if (!parsed.success)
            return fail(503, "CODE_CATALOG_INVALID");
        const row = { modelId: id, ...parsed.data } as CodingCatalogRow;
        const current = available.find(r => r.modelId === id);
        if (!current || canonicalJson(current) !== canonicalJson(row) || row.capabilities.structuredOutput === "none")
            return fail(403, "CODE_MODEL_UNAVAILABLE");
        const rank = { Free: 0, Pro: 1, Max: 2 };
        if (rank[plan] < rank[row.minimumPlan])
            return fail(403, "CODE_MODEL_PLAN_FORBIDDEN");
        if (!isAiProvider(row.provider))
            return fail(403, "CODE_PROVIDER_UNSUPPORTED");
        // Inference hosts/aggregators need their own destination pin, while
        // Perplexity's native search fees are not represented by token-only rows.
        if (["openrouter", "deepinfra", "together", "sail", "perplexity"].includes(row.provider))
            return fail(403, "CODE_PROVIDER_COST_UNBOUNDED");
        // The coding catalogue is independent of Chat's static model registry.
        // Endpoints and credential aliases still come solely from getActiveAiModel.
        const runtime: AiModel = { id, name: row.name, apiModel: row.apiModelId, provider: row.provider, icon: "", bestFor: "Coding",
            minimumPlan: row.minimumPlan === "Max" ? "Pro" : row.minimumPlan, usageClass: "standard", enabled: true, status: "enabled",
            creditWeight: row.pricing.creditWeight, contextWindowTokens: row.capabilities.maxContextTokens, maxOutputTokens: row.capabilities.maxOutputTokens };
        const staticProfile = getModelPricingProfile(id);
        const known = staticProfile?.provider === row.provider && staticProfile.apiModelId === row.apiModelId
            ? resolveModelPricing(runtime, { estimatedPromptTokens: row.capabilities.maxContextTokens }) : null;
        if (known?.reasoningTokenBilling === "billed_separately")
            return fail(403, "CODE_REASONING_COST_UNBOUNDED");
        if (known && (known.inputUsdPerMillionTokens > row.pricing.inputUsdPerMTok || known.outputUsdPerMillionTokens > row.pricing.outputUsdPerMTok))
            return fail(409, "CODE_CATALOG_PRICING_CHANGED");
        const price = { inputUsdPerMillionTokens: row.pricing.inputUsdPerMTok, outputUsdPerMillionTokens: row.pricing.outputUsdPerMTok,
            // An unverified cache discount is full input price. No cache markers are
            // requested; retain the existing Anthropic 5-minute premium upper bound.
            cachedInputPriceMultiplier: 1, cacheWriteUsdPerMillionTokens: row.provider === "anthropic"
                ? Math.max(known?.cacheWriteUsdPerMillionTokens ?? 0, row.pricing.inputUsdPerMTok * 1.25) : known?.cacheWriteUsdPerMillionTokens,
            maxOutputTokens: Math.min(row.capabilities.maxOutputTokens, CODE_MAX_OUTPUT_TOKENS, known?.providerMaxOutputTokens ?? Infinity),
            costSource: `coding_catalog_snapshot:${snapshot.version}:${snapshot.contentHash}`,
            cacheWriteBoundSource: known?.cacheWriteUsdPerMillionTokens !== undefined ? known?.pricingVersion :
                row.provider === "anthropic" ? "coding_credit_floor_anthropic_1.25" : "no_cache_write_requested" };
        return { row, runtime, price };
    };
    const executor = await resolve(request.executorModelId), reviewer = await resolve(request.reviewerModelId);
    if (executor.row.provider === reviewer.row.provider)
        return fail(400, "CODE_REVIEWER_PROVIDER_NOT_INDEPENDENT");
    return { executor, reviewer, plan, limits };
}
async function decrement(tx: Tx, key: string, period: string, start: Date, amount: number, currentStart?: Date) {
    if (amount <= 0)
        return;
    // Existing maintenance deletes old day/month buckets. An expired period
    // no longer grants allowance, so missing/pruned old counters need no refund.
    // Current-period underflow still signals a real accounting failure.
    const retired = start < (currentStart ?? usagePeriodStart(period.includes("month") ? "month" : "day", new Date()));
    const changed = await tx.$executeRaw `UPDATE "ChatUsageBucket" SET "count"=GREATEST(0,"count"-${amount}::bigint),"updatedAt"=NOW()
    WHERE "key"=${key} AND "period"=${period} AND "periodStart"=${start} AND (${retired} OR "count">=${amount}::bigint)`;
    if (changed !== 1 && !retired)
        return fail(503, "CODE_ACCOUNTING_UNAVAILABLE");
}
async function hold(tx: Tx, key: string, period: string, start: Date, limit: number, amount: number, code: string) {
    if (amount > 0 && !(await holdChatUsageBucket(tx, key, period, start, limit, amount)))
        return fail(429, code);
}
async function reserve(userId: string, request: ReserveRequest) {
    if (!codeManagedEnabled())
        return fail(503, "CODE_MANAGED_DISABLED");
    const pair = await modelPair(userId, request), hash = digest(request), now = new Date();
    return transaction(userId, async (tx) => {
        const { plan, limits } = await account(userId, tx);
        assertPairPlan({ executor: pair.executor.row, reviewer: pair.reviewer.row }, plan);
        const subject = getUserChatUsageKey(userId);
        const prior = await tx.$queryRaw<Task[]> `SELECT * FROM "CodeTaskReservation" WHERE "subjectKey"=${subject} AND "clientTaskId"=${request.taskId}`;
        if (prior[0]) {
            if (prior[0].requestDigest !== hash)
                return fail(409, "CODE_TASK_IDEMPOTENCY_CONFLICT");
            return receipt(prior[0], await calls(tx, prior[0].id));
        }
        const active = await tx.$queryRaw<{
            count: bigint;
        }[]> `SELECT COUNT(*) AS count FROM "CodeTaskReservation" WHERE "userId"=${userId} AND "status"='active' AND "leaseExpiresAt">${now}`;
        if (Number(active[0].count) >= codeTaskLimit())
            return fail(429, "CODE_TASK_CONCURRENCY_EXCEEDED");
        const day = await getUserDayWindow(tx, userId, now), month = usagePeriodStart("month", now);
        // Offset debt with plan entitlement first, using the same account lock and buckets as chat.
        const monthUsed = await readUsageBucketCount(tx, subject, "month", month);
        const debt = await offsetCreditDebt(tx, { userId, availableCredits: Math.max(0, limits.monthlyMessageLimit - monthUsed), availableFundedCostMicroUsd: BigInt(0), type: "plan_offset" });
        await hold(tx, subject, "month", month, limits.monthlyMessageLimit, debt.offsetCredits, "CREDIT_BALANCE_INSUFFICIENT");
        const dayUsed = await readUsageBucketCount(tx, subject, "day", day.start);
        const purchased = await tx.creditLot.aggregate({ where: { userId, status: "active", expiresAt: { gt: now } }, _sum: { remainingCredits: true } });
        const allocation = getChatCreditAllocation({ requiredCredits: request.approvedCredits, monthlyPlanCreditsRemaining: limits.monthlyMessageLimit - monthUsed - debt.offsetCredits,
            dailyPlanCreditsRemaining: limits.dailyMessageLimit > 0 ? limits.dailyMessageLimit - dayUsed : null, purchasedCreditsRemaining: purchased._sum.remainingCredits ?? 0 });
        if (allocation.balanceInsufficient)
            return fail(402, "CREDIT_BALANCE_INSUFFICIENT");
        if (allocation.dailyPlanGuardrailBlocked)
            return fail(429, "PLAN_DAILY_CREDIT_LIMIT_REACHED");
        if (limits.dailyMessageLimit > 0)
            await hold(tx, subject, "day", day.start, limits.dailyMessageLimit, allocation.planReservedCredits, "PLAN_DAILY_CREDIT_LIMIT_REACHED");
        await hold(tx, subject, "month", month, limits.monthlyMessageLimit, allocation.planReservedCredits, "CREDIT_BALANCE_INSUFFICIENT");
        const cost = request.approvedCredits * COST_PER_CREDIT_CEILING_MICRO_USD;
        const share = allocation.planReservedCredits / request.approvedCredits, planCost = Math.ceil(cost * share);
        const guard = getChatCostGuardrails(plan, limits);
        for (const window of [{ start: day.start, suffix: "day", planLimit: guard.planDay, totalLimit: guard.totalDay }, { start: month, suffix: "month", planLimit: guard.planMonth, totalLimit: guard.totalMonth }]) {
            await hold(tx, subject, `cost-${window.suffix}`, window.start, window.planLimit, planCost, "OPERATIONAL_COST_GUARDRAIL_TRIGGERED");
            await hold(tx, subject, `op-cost-${window.suffix}`, window.start, window.totalLimit, cost, "OPERATIONAL_COST_GUARDRAIL_TRIGGERED");
        }
        const id = randomUUID();
        const entries = await reserveAddOnCredits(tx, { userId, reservationId: id, credits: allocation.addOnCreditsRequired, fundedCostMicroUsd: cost - planCost, now });
        const publicPair = { executor: pair.executor.row, reviewer: pair.reviewer.row };
        await tx.$executeRaw `INSERT INTO "CodeTaskReservation" ("id","userId","subjectKey","clientTaskId","requestDigest","catalogVersion","contentHash","modelPair","reservedCredits","planHeldCredits","planDayHeld","addOnEntries","reservedCostMicroUsd","heldCostMicroUsd","planHeldCostMicroUsd","planFundingShare","dayStart","monthStart","leaseExpiresAt")
      VALUES (${id},${userId},${subject},${request.taskId},${hash},${request.catalogVersion},${request.contentHash},${JSON.stringify(publicPair)}::jsonb,${request.approvedCredits},${allocation.planReservedCredits},${limits.dailyMessageLimit > 0},${JSON.stringify(entries)}::jsonb,${BigInt(cost)},${BigInt(cost)},${BigInt(planCost)},${share},${day.start},${month},${new Date(now.getTime() + CODE_TASK_TTL_MS)})`;
        return receipt((await tasks(tx, id, userId))[0], []);
    });
}
/** Refund only proven-unused portions. Unknown and in-flight holds remain reserved. */
const spentAddOnCredits = (task: Task) => Math.max(0, task.settledCredits - task.planHeldCredits);
const spentAddOnCost = (task: Task) => numeric(task.settledCostMicroUsd) - Math.ceil(numeric(task.settledCostMicroUsd) * task.planFundingShare);
async function settleKnownAddOn(tx: Tx, task: Task, credits: number, cost: number, outcome: "completed" | "failed") {
    const after = { ...task, settledCredits: task.settledCredits + credits, settledCostMicroUsd: task.settledCostMicroUsd + BigInt(cost) };
    const usedCredits = spentAddOnCredits(after) - spentAddOnCredits(task), usedCost = spentAddOnCost(after) - spentAddOnCost(task);
    if (usedCredits === 0 && usedCost === 0)
        return;
    let creditsLeft = usedCredits, costLeft = usedCost;
    const used: AddOnCreditReservationEntry[] = [], remaining: AddOnCreditReservationEntry[] = [];
    for (const entry of task.addOnEntries) {
        const credits = Math.min(creditsLeft, entry.credits), fundedCostMicroUsd = Math.min(costLeft, entry.fundedCostMicroUsd);
        used.push({ ...entry, credits, fundedCostMicroUsd });
        remaining.push({ ...entry, credits: entry.credits - credits, fundedCostMicroUsd: entry.fundedCostMicroUsd - fundedCostMicroUsd });
        creditsLeft -= credits;
        costLeft -= fundedCostMicroUsd;
    }
    if (creditsLeft > 0 || costLeft > 0)
        return fail(503, "CODE_ACCOUNTING_UNAVAILABLE");
    // These slices were debited at reserve. Passing exactly their consumed
    // amount records the canonical settle audit without another debit/refund.
    await settleAddOnCredits(tx, { userId: task.userId!, reservationId: task.id,
        entries: used.filter(e => e.credits > 0 || e.fundedCostMicroUsd > 0), settledCredits: usedCredits, settledFundedCostMicroUsd: usedCost, outcome });
    await tx.$executeRaw `UPDATE "CodeTaskReservation" SET "addOnEntries"=${JSON.stringify(remaining)}::jsonb WHERE "id"=${task.id}`;
}
async function refundUnused(tx: Tx, task: Task, records: Call[]) {
    const held = records.filter(c => c.status === "dispatched" || c.status === "outcome_unknown");
    const keepCredits = task.settledCredits + held.reduce((sum, c) => sum + c.reservedCredits, 0);
    const released = task.reservedCredits - keepCredits;
    const keepCost = numeric(task.settledCostMicroUsd) + held.reduce((sum, c) => sum + numeric(c.reservedCostMicroUsd), 0);
    const planKeep = Math.min(task.planHeldCredits, keepCredits), planRefund = task.planHeldCredits - planKeep;
    const addOnKeep = keepCredits - planKeep - spentAddOnCredits(task);
    const planCostKeep = Math.min(numeric(task.planHeldCostMicroUsd), Math.ceil(keepCost * task.planFundingShare));
    const addOnCostKeep = keepCost - planCostKeep - spentAddOnCost(task);
    const kept: AddOnCreditReservationEntry[] = [], refunds: AddOnCreditReservationEntry[] = [];
    let creditsLeft = addOnKeep, costLeft = addOnCostKeep;
    for (const entry of task.addOnEntries) {
        const credits = Math.min(creditsLeft, entry.credits), fundedCostMicroUsd = Math.min(costLeft, entry.fundedCostMicroUsd);
        kept.push({ ...entry, credits, fundedCostMicroUsd });
        refunds.push({ ...entry, credits: entry.credits - credits, fundedCostMicroUsd: entry.fundedCostMicroUsd - fundedCostMicroUsd });
        creditsLeft -= credits;
        costLeft -= fundedCostMicroUsd;
    }
    if (creditsLeft > 0 || costLeft > 0 || released < task.releasedCredits)
        return fail(503, "CODE_ACCOUNTING_UNAVAILABLE");
    const now = new Date(), currentDay = await getUserDayWindow(tx, task.userId!, now);
    for (const [period, start, currentStart] of [["day", task.dayStart, currentDay.start], ["month", task.monthStart, usagePeriodStart("month", now)]] as const) {
        // A plan with no daily credit ceiling did not create a daily credit hold.
        if (period !== "day" || task.planDayHeld)
            await decrement(tx, task.subjectKey, period, start, planRefund, currentStart);
        await decrement(tx, task.subjectKey, `cost-${period}`, start, numeric(task.planHeldCostMicroUsd) - planCostKeep, currentStart);
        await decrement(tx, task.subjectKey, `op-cost-${period}`, start, numeric(task.heldCostMicroUsd) - keepCost, currentStart);
    }
    await settleAddOnCredits(tx, { userId: task.userId!, reservationId: task.id, entries: refunds.filter(e => e.credits > 0 || e.fundedCostMicroUsd > 0), settledCredits: 0, settledFundedCostMicroUsd: 0, outcome: "completed" });
    await tx.$executeRaw `UPDATE "CodeTaskReservation" SET "releasedCredits"=${released},"planHeldCredits"=${planKeep},"addOnEntries"=${JSON.stringify(kept)}::jsonb,"heldCostMicroUsd"=${BigInt(keepCost)},"planHeldCostMicroUsd"=${BigInt(planCostKeep)},"updatedAt"=NOW() WHERE "id"=${task.id}`;
}
async function expireCalls(tx: Tx, task: Task, now: Date) {
    await tx.$executeRaw `UPDATE "CodeManagedCall" SET "status"='outcome_unknown',"completedAt"=${now} WHERE "reservationId"=${task.id} AND "status"='dispatched' AND "createdAt"<${new Date(now.getTime() - CODE_PROVIDER_TIMEOUT_MS - 30000)}`;
    if (task.status === "active" && task.leaseExpiresAt <= now) {
        await tx.$executeRaw `UPDATE "CodeTaskReservation" SET "status"='interrupted',"updatedAt"=NOW() WHERE "id"=${task.id}`;
        task.status = "interrupted";
    }
    // Deleted accounts retain non-personal provider holds, but no wallet or lot
    // identity to refund. Expiry must still make their calls reconcilable.
    if (task.status !== "active" && task.userId)
        await refundUnused(tx, task, await calls(tx, task.id));
}
async function inspect(userId: string, request: Extract<CodeManagedRequest, {
    action: "status" | "heartbeat" | "release";
}>) {
    return transaction(userId, async (tx) => {
        let task = (await tasks(tx, request.reservationId, userId))[0];
        if (!task)
            return fail(404, "CODE_RESERVATION_NOT_FOUND");
        await expireCalls(tx, task, new Date());
        if (request.action === "heartbeat" && task.status === "active")
            await tx.$executeRaw `UPDATE "CodeTaskReservation" SET "leaseExpiresAt"=${new Date(Date.now() + CODE_TASK_TTL_MS)},"updatedAt"=NOW() WHERE "id"=${task.id}`;
        if (request.action === "release" && task.status === "active") {
            await tx.$executeRaw `UPDATE "CodeTaskReservation" SET "status"='closed',"updatedAt"=NOW() WHERE "id"=${task.id}`;
            task.status = "closed";
            await refundUnused(tx, task, await calls(tx, task.id));
        }
        task = (await tasks(tx, task.id, userId))[0];
        const records = await calls(tx, task.id);
        const call = request.action === "status" && request.callId ? records.find(c => c.id === request.callId) : undefined;
        return { ...receipt(task, records), ...(call ? { call: { callId: call.id, state: call.status, callCredits: call.settledCredits, dispatchState: "dispatched" } } : {}) };
    });
}
async function complete(userId: string, request: CompleteRequest) {
    if (!codeManagedEnabled())
        return fail(503, "CODE_MANAGED_DISABLED");
    const initial = (await tasks(prisma as unknown as Tx, request.reservationId, userId))[0];
    if (!initial)
        return fail(404, "CODE_RESERVATION_NOT_FOUND");
    const initialRecords = await calls(prisma as unknown as Tx, initial.id), existing = initialRecords.find(c => c.id === request.callId);
    if (existing)
        throw new CodeManagedError(409, existing.requestDigest === digest(request) ? "CODE_CALL_ALREADY_DISPATCHED" : "CODE_CALL_IDEMPOTENCY_CONFLICT", "dispatched", receipt(initial, initialRecords));
    const pair = await modelPair(userId, { catalogVersion: initial.catalogVersion, contentHash: initial.contentHash,
        executorModelId: initial.modelPair.executor.modelId, reviewerModelId: initial.modelPair.reviewer.modelId });
    const selected = pair[request.role];
    if (selected.row.modelId !== request.modelId)
        return fail(403, "CODE_MODEL_PIN_MISMATCH");
    if (request.maxOutputTokens > selected.price.maxOutputTokens)
        return fail(400, "CODE_REQUEST_BOUNDS_INVALID");
    let maxInput: number;
    try {
        maxInput = codeSchemaAndPrompt(request, selected.row);
    }
    catch {
        return fail(400, "CODE_REQUEST_BOUNDS_INVALID");
    }
    // Build the adapter before marking dispatch. Missing credentials/configuration
    // are pre-dispatch failures; SDK retries are disabled in the adapter.
    let dispatch: ReturnType<typeof prepareCodeProvider>;
    try {
        if (!codeProviderCredentialReady(selected.runtime.provider))
            return fail(503, "CODE_PROVIDER_UNAVAILABLE");
        dispatch = prepareCodeProvider(selected.runtime, request);
    }
    catch {
        return fail(503, "CODE_PROVIDER_UNAVAILABLE");
    }
    const hash = digest(request), now = new Date();
    const reservedCredits = getWeightedUsageCredits({ usageClass: selected.runtime.usageClass, creditWeight: selected.row.pricing.creditWeight }, maxInput);
    const price = { input: selected.price.inputUsdPerMillionTokens, output: selected.price.outputUsdPerMillionTokens, cached: selected.price.cachedInputPriceMultiplier, cacheWrite: selected.price.cacheWriteUsdPerMillionTokens, maxInput,
        costSource: selected.price.costSource, cacheWriteBoundSource: selected.price.cacheWriteBoundSource, catalogVersion: initial.catalogVersion, contentHash: initial.contentHash };
    // The existing calculator rounds up its three input components separately.
    const reservedCost = Math.ceil(maxInput * Math.max(price.input, price.cacheWrite ?? price.input)) +
        Math.ceil(request.maxOutputTokens * price.output) + 2;
    await transaction(userId, async (tx) => {
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${`code-call-id:${request.callId}`}))`;
        const { plan } = await account(userId, tx);
        assertPairPlan({ executor: pair.executor.row, reviewer: pair.reviewer.row }, plan);
        const task = (await tasks(tx, request.reservationId, userId))[0];
        if (!task)
            return fail(404, "CODE_RESERVATION_NOT_FOUND");
        const records = await calls(tx, task.id), prior = records.find(c => c.id === request.callId);
        if (prior)
            throw new CodeManagedError(409, prior.requestDigest === hash ? "CODE_CALL_ALREADY_DISPATCHED" : "CODE_CALL_IDEMPOTENCY_CONFLICT", "dispatched", receipt(task, records));
        if ((await tx.$queryRaw<{
            id: string;
        }[]> `SELECT "id" FROM "CodeManagedCall" WHERE "id"=${request.callId}`).length)
            return fail(409, "CODE_CALL_IDEMPOTENCY_CONFLICT");
        if (task.status !== "active" || task.leaseExpiresAt <= now)
            return fail(409, "CODE_TASK_NOT_ACTIVE");
        if (records.some(c => c.status === "outcome_unknown"))
            return fail(409, "CODE_TASK_OUTCOME_UNKNOWN");
        if (records.length >= codeCallCeiling())
            return fail(429, "CODE_TASK_CALL_CEILING_REACHED");
        const inFlight = await tx.$queryRaw<{
            count: bigint;
        }[]> `SELECT COUNT(*) AS count FROM "CodeManagedCall" c JOIN "CodeTaskReservation" t ON t."id"=c."reservationId" WHERE t."userId"=${userId} AND c."status"='dispatched'`;
        if (Number(inFlight[0].count) >= codeConcurrentCalls())
            return fail(429, "CODE_CALL_CONCURRENCY_EXCEEDED");
        const bill = codeBilling(task, records);
        const committedCost = numeric(task.settledCostMicroUsd) + records.filter(c => c.status === "dispatched" || c.status === "outcome_unknown").reduce((sum, c) => sum + numeric(c.reservedCostMicroUsd), 0);
        if (reservedCredits > bill.availableCredits || committedCost + reservedCost > numeric(task.reservedCostMicroUsd))
            return fail(402, "CODE_TASK_CAP_EXCEEDED");
        await hold(tx, task.subjectKey, "code_rate_minute", usagePeriodStart("minute", now), codeCallCeiling() * codeTaskLimit(), 1, "CODE_RATE_LIMITED");
        const provider = getProviderCostBudget(selected.row.provider);
        if (provider.problems.length)
            return fail(503, "CODE_PROVIDER_BUDGET_UNAVAILABLE");
        // Provider spend is the last bucket layer, shared with every other product.
        for (const [period, limit] of [["day", provider.day], ["month", provider.month]] as const)
            await hold(tx, providerBucketKey(selected.row.provider), `provider-cost-${period}`, usagePeriodStart(period, now), limit, reservedCost, "PROVIDER_COST_BUDGET_EXCEEDED");
        await tx.$executeRaw `INSERT INTO "CodeManagedCall" ("id","reservationId","requestDigest","role","modelId","provider","reservedCredits","reservedCostMicroUsd","maxOutputTokens","pricingSnapshot","createdAt")
      VALUES (${request.callId},${task.id},${hash},${request.role},${request.modelId},${selected.row.provider},${reservedCredits},${BigInt(reservedCost)},${request.maxOutputTokens},${JSON.stringify(price)}::jsonb,${now})`;
    });
    let result: CodeProviderResult;
    try {
        result = await dispatch(request);
    }
    catch {
        result = { validOutput: false, usage: null, latencyMs: 0 };
    }
    let final;
    try {
        final = await transaction(userId, async (tx) => {
            let task = (await tasks(tx, request.reservationId, userId))[0];
            const records = await calls(tx, task.id), call = records.find(c => c.id === request.callId)!;
            if (call.status !== "dispatched")
                return { ...receipt(task, records), callCredits: 0, state: "outcome_unknown" };
            const usage = result.usage;
            if (!usage || usage.inputTokens > maxInput || usage.outputTokens > request.maxOutputTokens) {
                await tx.$executeRaw `UPDATE "CodeManagedCall" SET "status"='outcome_unknown',"completedAt"=NOW() WHERE "id"=${call.id}`;
                if (task.status !== "active")
                    await refundUnused(tx, task, await calls(tx, task.id));
                task = (await tasks(tx, task.id, userId))[0];
                return { ...receipt(task, await calls(tx, task.id)), callCredits: 0, state: "outcome_unknown" };
            }
            const cost = calculateProviderUsageCost({ inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
                outputTokens: usage.outputTokens, inputUsdPerMillionTokens: price.input, outputUsdPerMillionTokens: price.output, cachedInputPriceMultiplier: price.cached, cacheWriteUsdPerMillionTokens: price.cacheWrite });
            if (cost.unpricedCacheWriteTokens > 0)
                return fail(503, "CODE_PROVIDER_USAGE_INVALID");
            const actualCost = cost.totalCostMicroUsd;
            if (actualCost > reservedCost)
                return fail(503, "CODE_PROVIDER_USAGE_INVALID");
            const charge = getSettledUsageCredits({ reservedCredits: Math.min(reservedCredits, getWeightedUsageCredits({ usageClass: selected.runtime.usageClass, creditWeight: selected.row.pricing.creditWeight }, usage.inputTokens)), reservedInputTokens: maxInput, reservedOutputTokens: request.maxOutputTokens, actualInputTokens: usage.inputTokens, actualOutputTokens: usage.outputTokens, outcome: result.validOutput ? "completed" : "failed" });
            for (const period of ["day", "month"] as const)
                await decrement(tx, providerBucketKey(selected.row.provider), `provider-cost-${period}`, usagePeriodStart(period, call.createdAt), reservedCost - actualCost);
            await settleKnownAddOn(tx, task, charge, actualCost, result.validOutput ? "completed" : "failed");
            await tx.$executeRaw `UPDATE "CodeManagedCall" SET "status"=${result.validOutput ? "completed" : "failed"},"settledCredits"=${charge},"settledCostMicroUsd"=${BigInt(actualCost)},"inputTokens"=${usage.inputTokens},"outputTokens"=${usage.outputTokens},"cachedInputTokens"=${usage.cachedInputTokens},"cacheWriteInputTokens"=${usage.cacheWriteInputTokens},"reasoningTokens"=${usage.reasoningTokens},"providerReportedModelId"=${result.providerReportedModelId ?? null},"latencyMs"=${result.latencyMs},"completedAt"=NOW() WHERE "id"=${call.id}`;
            await tx.$executeRaw `UPDATE "CodeTaskReservation" SET "settledCredits"="settledCredits"+${charge},"settledCostMicroUsd"="settledCostMicroUsd"+${BigInt(actualCost)},"updatedAt"=NOW() WHERE "id"=${task.id}`;
            task = (await tasks(tx, task.id, userId))[0];
            if (task.status !== "active")
                await refundUnused(tx, task, await calls(tx, task.id));
            task = (await tasks(tx, task.id, userId))[0];
            return { ...receipt(task, await calls(tx, task.id)), callCredits: charge };
        });
    }
    catch {
        throw new CodeManagedError(503, "CODE_SETTLEMENT_OUTCOME_UNKNOWN", "dispatched");
    }
    if (final.state === "outcome_unknown")
        throw new CodeManagedError(409, "CODE_CALL_OUTCOME_UNKNOWN", "dispatched", final);
    if (!result.validOutput)
        throw new CodeManagedError(422, "CODE_OUTPUT_INVALID", "dispatched", final, { usage: result.usage, latencyMs: result.latencyMs, ...(result.providerReportedModelId ? { providerReportedModelId: result.providerReportedModelId } : {}) });
    return { ...final, callId: request.callId, value: result.value, usage: result.usage, model: { modelId: selected.row.modelId, provider: selected.row.provider, apiModelId: selected.row.apiModelId }, latencyMs: result.latencyMs,
        ...(result.providerReportedModelId ? { providerReportedModelId: result.providerReportedModelId } : {}), dispatchState: "dispatched" };
}
export async function handleCodeManaged(userId: string, request: CodeManagedRequest) {
    try {
        if (request.action === "reserve")
            return await reserve(userId, request);
        if (request.action === "complete")
            return await complete(userId, request);
        return await inspect(userId, request);
    }
    catch (error) {
        if (error instanceof AddOnCreditError)
            error = new CodeManagedError(402, error.code);
        const limits: Record<string, [
            string,
            string
        ]> = {
            CREDIT_BALANCE_INSUFFICIENT: ["entitlement", "code_account_credits"],
            ADDON_CREDITS_INSUFFICIENT: ["entitlement", "code_purchased_credits"],
            ADDON_COST_ALLOWANCE_INSUFFICIENT: ["entitlement", "code_purchased_allowance"],
            PLAN_DAILY_CREDIT_LIMIT_REACHED: ["entitlement", "code_daily_plan_credits"],
            CODE_TASK_CAP_EXCEEDED: ["entitlement", "code_task_cap"],
            CODE_TASK_CALL_CEILING_REACHED: ["operational_guardrail", "code_task_calls"],
            OPERATIONAL_COST_GUARDRAIL_TRIGGERED: ["operational_guardrail", "user_total_cost"],
            PROVIDER_COST_BUDGET_EXCEEDED: ["operational_guardrail", "provider_cost"],
            CODE_TASK_CONCURRENCY_EXCEEDED: ["concurrency", "code_tasks"],
            CODE_CALL_CONCURRENCY_EXCEEDED: ["concurrency", "code_calls"],
            CODE_RATE_LIMITED: ["rate_limit", "code_rate_minute"],
        };
        const limit = error instanceof CodeManagedError ? limits[error.code] : undefined;
        if (limit)
            try {
                const user = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
                await recordChatLimitDecision({ traceId: randomUUID(), subjectKey: getUserChatUsageKey(userId), userId,
                    plan: user?.plan ?? "unknown", phase: "code_reservation", decision: "rejected", errorCode: (error as CodeManagedError).code,
                    limitLayer: limit[0], limitScope: limit[1], models: [], enabledTools: [], timeZone: "UTC" });
            }
            catch { /* Diagnostics must never change dispatch or monetary outcomes. */ }
        throw error;
    }
}
/** Existing 15-minute maintenance cadence; no provider calls or automatic resumption. */
export async function reconcileExpiredCodeTasks(now = new Date()) {
    let rows: {
        id: string;
        userId: string | null;
    }[];
    try {
        rows = await prisma.$queryRaw<{
            id: string;
            userId: string | null;
        }[]> `SELECT t."id",t."userId" FROM "CodeTaskReservation" t WHERE
    ((t."status"='active' AND t."leaseExpiresAt"<=${now}) OR EXISTS (SELECT 1 FROM "CodeManagedCall" c WHERE c."reservationId"=t."id" AND c."status"='dispatched' AND c."createdAt"<${new Date(now.getTime() - CODE_PROVIDER_TIMEOUT_MS - 30000)})) ORDER BY t."leaseExpiresAt" LIMIT 100`;
    }
    catch (error) {
        if (isMissingDatabaseSchemaError(error))
            return { interrupted: 0 };
        throw error;
    }
    let interrupted = 0, failed = 0;
    for (const row of rows)
        try {
            interrupted += await transaction(row.userId ?? `anonymous-code:${row.id}`, async (tx) => {
                const task = (await tx.$queryRaw<Task[]> `SELECT * FROM "CodeTaskReservation" WHERE "id"=${row.id} AND "userId" IS NOT DISTINCT FROM ${row.userId}`)[0];
                if (!task)
                    return 0;
                const expired = task.status === "active" && task.leaseExpiresAt <= now;
                await expireCalls(tx, task, now);
                return expired ? 1 : 0;
            });
        }
        catch {
            failed++;
            console.warn(JSON.stringify({ event: "code_lease_reconciliation_deferred" }));
        }
    return { examined: rows.length, interrupted, failed };
}
/** Manual provider-evidence resolution. This path never dispatches a provider
 * or charges a customer for output the original request did not deliver. */
export async function reconcileCodeManagedCall(session: Session, request: Request, input: CodeManagedReconciliation) {
    if (process.env.CODE_MANAGED_RECONCILIATION_ENABLED !== "true")
        return fail(503, "CODE_RECONCILIATION_DISABLED");
    if (!session.user?.id || getAdminRole(session) !== "owner")
        return fail(403, "CODE_RECONCILIATION_FORBIDDEN");
    await assertRecentAdminAuthentication(session);
    const body = codeManagedReconciliationSchema.parse(input), hash = digest(body);
    const initial = (await prisma.$queryRaw<{
        reservationId: string;
        userId: string | null;
    }[]> `SELECT c."reservationId",t."userId" FROM "CodeManagedCall" c
      JOIN "CodeTaskReservation" t ON t."id"=c."reservationId" WHERE c."id"=${body.callId}`)[0];
    if (!initial)
        return fail(404, "CODE_CALL_NOT_FOUND");
    return transaction(initial.userId ?? `anonymous-code:${initial.reservationId}`, async (tx) => {
        // Credit-account/workflow advisory locks already precede this. Take the
        // canonical chain lock before any row mutation, as its writer requires.
        await takeAuditChainLock(tx);
        const prior = (await tx.$queryRaw<Call[]> `SELECT * FROM "CodeManagedCall" WHERE "resolutionId"=${body.resolutionId}`)[0];
        if (prior) {
            if (prior.id !== body.callId || prior.resolutionDigest !== hash)
                return fail(409, "CODE_RESOLUTION_IDEMPOTENCY_CONFLICT");
            return { callId: prior.id, resolutionId: body.resolutionId, state: "resolved", auditLogId: prior.resolutionAuditId, customerChargeCredits: 0 };
        }
        let task = (await tx.$queryRaw<Task[]> `SELECT * FROM "CodeTaskReservation" WHERE "id"=${initial.reservationId}`)[0];
        const call = (await calls(tx, task.id)).find(c => c.id === body.callId)!;
        if (call.status !== "outcome_unknown")
            return fail(409, "CODE_CALL_NOT_UNKNOWN");
        const usage = body.mode === "known_usage" ? validCodeUsage(body.usage) : validCodeUsage({ inputTokens: 0, outputTokens: 0 });
        const price = call.pricingSnapshot;
        if (!usage || usage.inputTokens > price.maxInput || usage.outputTokens > call.maxOutputTokens)
            return fail(409, "CODE_RECONCILIATION_USAGE_OUT_OF_BOUNDS");
        const cost = calculateProviderUsageCost({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens, inputUsdPerMillionTokens: price.input, outputUsdPerMillionTokens: price.output, cachedInputPriceMultiplier: price.cached, cacheWriteUsdPerMillionTokens: price.cacheWrite });
        if (cost.unpricedCacheWriteTokens > 0 || cost.totalCostMicroUsd > numeric(call.reservedCostMicroUsd))
            return fail(409, "CODE_RECONCILIATION_USAGE_OUT_OF_BOUNDS");
        for (const period of ["day", "month"] as const)
            await decrement(tx, providerBucketKey(call.provider), `provider-cost-${period}`, usagePeriodStart(period, call.createdAt), numeric(call.reservedCostMicroUsd) - cost.totalCostMicroUsd);
        if (task.userId)
            await settleKnownAddOn(tx, task, 0, cost.totalCostMicroUsd, "failed");
        await tx.$executeRaw `UPDATE "CodeManagedCall" SET "status"='failed',"settledCredits"=0,"settledCostMicroUsd"=${BigInt(cost.totalCostMicroUsd)},
          "inputTokens"=${usage.inputTokens},"outputTokens"=${usage.outputTokens},"cachedInputTokens"=${usage.cachedInputTokens},"cacheWriteInputTokens"=${usage.cacheWriteInputTokens},"reasoningTokens"=${usage.reasoningTokens},
          "resolutionId"=${body.resolutionId},"resolutionDigest"=${hash},"resolvedAt"=NOW(),"completedAt"=NOW() WHERE "id"=${call.id}`;
        await tx.$executeRaw `UPDATE "CodeTaskReservation" SET "status"='closed',"settledCostMicroUsd"="settledCostMicroUsd"+${BigInt(cost.totalCostMicroUsd)},"updatedAt"=NOW() WHERE "id"=${task.id}`;
        task = (await tx.$queryRaw<Task[]> `SELECT * FROM "CodeTaskReservation" WHERE "id"=${task.id}`)[0];
        if (task.userId)
            await refundUnused(tx, task, await calls(tx, task.id));
        else {
            // Deletion removed the wallet and account usage identity. Keep the
            // non-personal funding snapshot; adjust only this call's global
            // provider hold and the retained financial totals, never a new wallet.
            const heldCost = numeric(task.heldCostMicroUsd) - numeric(call.reservedCostMicroUsd) + cost.totalCostMicroUsd;
            await tx.$executeRaw `UPDATE "CodeTaskReservation" SET "releasedCredits"="releasedCredits"+${call.reservedCredits},"heldCostMicroUsd"=${BigInt(heldCost)},
              "planHeldCredits"=${Math.min(task.planHeldCredits, task.reservedCredits - task.releasedCredits - call.reservedCredits)},
              "planHeldCostMicroUsd"=${BigInt(Math.min(numeric(task.planHeldCostMicroUsd), Math.ceil(heldCost * task.planFundingShare)))} WHERE "id"=${task.id}`;
        }
        const auditLogId = await writeAdminAuditLog({ session, request, tx, action: "code.managed_call_reconciled", targetType: "CodeManagedCall", targetId: call.id,
            summary: "Resolved one unknown Code provider call from operator-reviewed evidence; no customer charge.",
            metadata: { resolutionId: body.resolutionId, mode: body.mode, evidenceRef: body.evidenceRef, customerChargeCredits: 0, actualCostMicroUsd: cost.totalCostMicroUsd } });
        await tx.$executeRaw `UPDATE "CodeManagedCall" SET "resolutionAuditId"=${auditLogId} WHERE "id"=${call.id}`;
        return { callId: call.id, resolutionId: body.resolutionId, state: "resolved", auditLogId, customerChargeCredits: 0 };
    });
}
