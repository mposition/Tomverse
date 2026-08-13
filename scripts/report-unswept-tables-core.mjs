/**
 * Tables the application writes rows to that nothing will ever remove rows
 * from.
 *
 * Three were found this way: `ProviderProbeResult` (a row per probed model
 * every ten minutes, read by nothing), `ScheduledJobRun` (every cron cycle,
 * read newest-first) and `ProviderModelCatalogRun` (daily, read by nothing).
 * None of them broke anything, which is the point -- a table with no ceiling
 * costs disk, backup time and query planning long before it costs an outage,
 * and by then the oldest rows are years old.
 *
 * A report, not a gate. Whether a table should be swept, kept, or is bounded
 * by something this cannot see is a decision a person makes; the failure this
 * prevents is nobody being asked. `report:issue-backlog` and
 * `report:credit-lot-invariants` are the same shape.
 *
 * Three ways a table can be off the list, and only the first two are checked
 * mechanically:
 *
 *   - the application deletes from it somewhere (a sweep, a consume-on-use, a
 *     queue drain);
 *   - a `Cascade` relation removes the row with its parent -- which answers
 *     "does this outlive the account", *not* "does this stop growing", so it
 *     is reported separately rather than treated as an answer;
 *   - it is bounded by a key space rather than by time, which is the
 *     registered set below.
 */

/**
 * Tables whose row count is a function of something bounded -- a setting key,
 * a provider, a plan, a model -- rather than of traffic or elapsed time.
 *
 * Each entry says what the ceiling is. "It is small today" is not a ceiling.
 */
export const BOUNDED_TABLES = {
    AppSetting: "one row per setting key, and the keys are written in code",
    BillingPlan: "one row per plan tier",
    ModelRegistryEntry: "one row per catalogued model",
    ProviderModelCatalogEntry: "one row per (provider, apiModel)",
    ProviderCreditConfig: "primary key is the provider",
    ProviderBillingConfig: "primary key is the provider",
    InfrastructureCreditConfig: "primary key is the service",
    AdminOperationalCheckpoint: "primary key is the checkpoint key",
    AdminSlackTemplate: "primary key is the template key",
    AdminAlertPolicy: "one row per alert policy, edited rather than appended",
    UserMemorySettings: "primary key is the user; grows with signups only",
    ProviderDailyUsage:
        "one row per (provider, model, source, day); the day makes it grow, but at a rate set by the catalogue rather than by traffic",
};

/**
 * Tables that grow with business or support events and are deliberately kept,
 * with the reason deleting a row would be wrong.
 */
export const RETAINED_TABLES = {
    AdminAuditLog:
        "tamper-evident hash chain; removing an entry from the middle breaks every later link",
    AdminActionApproval:
        "the record of who approved a two-person action, and what they approved",
    AdminRetentionRun:
        "the record that a destructive cleanup was run, and by whom; written on demand, not on a cadence",
    AdminOperationReport:
        "operator-authored reports, written on demand rather than on a cadence",
    AdminNote: "support notes about a customer, deleted with the customer",
    BillingTransaction:
        "billing record; a subscription charge has to stay answerable long after it clears",
    CreditPurchase:
        "billing record; a purchase is the evidence behind the credits it granted",
    CreditLot: "credit entitlement; expiry is a status change, not a delete",
    CreditLedgerEntry:
        "the ledger itself; an entry is never removed, only offset by another",
    CreditDebtEntry: "the ledger; debt is settled by a later entry, never by deletion",
    PlanChangeRequest:
        "the quote a customer was shown and the subscription change it became",
    StripeWebhookEventLog:
        "the idempotency record for every Stripe event; deleting one makes a redelivery reprocess",
    RefundRequest:
        "support and billing record; the decision on a refund outlives the refund",
    PrivacyRequest: "the record that a privacy request was made and answered",
    AdminProviderIncident:
        "incident history; the record of what was wrong and when it was resolved",
    Feedback: "support record, deleted with the customer",
    ImageAssetCleanup: "the queue's own record of what was deleted from R2",
};

/**
 * @param {{
 *   models: { name: string, hasUserCascade: boolean }[],
 *   created: Set<string>,
 *   deleted: Set<string>,
 *   bounded?: Record<string, string>,
 *   retained?: Record<string, string>,
 * }} input
 */
export function auditUnsweptTables({
    models,
    created,
    deleted,
    bounded = BOUNDED_TABLES,
    retained = RETAINED_TABLES,
}) {
    const unswept = [];
    const cascadeOnly = [];
    const errors = [];

    for (const { name, hasUserCascade } of models) {
        if (!created.has(name)) continue;
        if (deleted.has(name)) continue;
        if (name in bounded || name in retained) continue;
        if (hasUserCascade) {
            cascadeOnly.push(name);
            continue;
        }
        unswept.push(name);
    }

    for (const name of [...Object.keys(bounded), ...Object.keys(retained)]) {
        if (!models.some((model) => model.name === name)) {
            errors.push(
                `${name} is registered here but is not a model in prisma/schema.prisma. Remove the entry.`
            );
        }
    }
    for (const name of Object.keys(bounded)) {
        if (name in retained) {
            errors.push(`${name} is registered as both bounded and retained.`);
        }
    }

    return { unswept, cascadeOnly, errors };
}
