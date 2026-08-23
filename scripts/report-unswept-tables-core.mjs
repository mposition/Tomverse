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
    ModelMigrationRecord:
        "the record of what an approved retirement changed on somebody's account; it is the audience of the notice that tells them, and the only answer to what their setting held before",
    ModelLifecycleWorkItem:
        "the decision record for a discovered model; deleting one returns that model to the state this table was built to end, where nothing says whether it was reviewed",
    ModelLifecycleWorkItemEvent:
        "append-only history of who moved a work item and when; an entry removed from the middle makes the decision unanswerable",
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
};

/**
 * Tables held out of both lists on purpose, because the decision that would
 * put them in one has an owner and a date and has not been made yet.
 *
 * This is a third state and needs to be, because the other two both read as
 * settled. "Unswept" says nobody has looked; "retained" says someone decided
 * to keep the rows. A reservation row is neither: it is the record linking a
 * request to the credits it spent, so a sweep is a decision about billing
 * evidence rather than about disk -- and "billing evidence" justifies keeping
 * a row for a stated period, never keeping it forever by default. The row also
 * carries a user link, so how long it is kept is a privacy question as much as
 * a finance one.
 *
 * A hold without a date is how "not yet" becomes "never", so each entry
 * carries one. Past it the report stops calling the hold current and reports
 * it as an overdue decision -- the same rows, a different sentence, because a
 * deadline that produces the identical output on either side of itself is not
 * a deadline.
 */
export const PENDING_RETENTION_DECISIONS = [
    {
        key: "credit-reservations",
        // One decision, not three. The three tables differ only in which
        // workflow reserved the credits; every question below has the same
        // answer for all of them, and answering them separately is how two of
        // the three end up with a policy and the third does not.
        tables: [
            "ChatCreditReservation",
            "ImageCreditReservation",
            "MemoryExtractionCreditReservation",
        ],
        owners: ["finance-ops", "privacy/legal"],
        // End of 2026-08-28 in AEST (UTC+10), as an instant, so the report
        // does not depend on the reader's clock. This is the date a policy is
        // approved by -- not a date anything is deleted on. Nothing may be
        // deleted before the approval exists.
        dueBy: "2026-08-28T14:00:00Z",
        dueByLabel: "2026-08-28 (AEST)",
        holds: "no deletion before approval",
        decides: [
            "retention period per status -- an expired `reserved` row, a `settled` row and a `refunded` row do not have the same evidential life, and one period for all three is a decision by omission",
            "what happens at the end of it: deletion, or anonymisation that keeps the aggregate and drops the user link (if anonymisation, which columns)",
            "account deletion, refunds and disputes: whether a deletion request removes these rows or the period outlives it, and what a live chargeback freezes",
            "how far the period reaches into restorable backups, and what a deletion covers there",
        ],
        reference: ".github/RELEASE_CHECKLIST.md §7.8",
    },
];

/** Every table named by a pending decision, mapped to the decision holding it. */
export const pendingDecisionByTable = (
    decisions = PENDING_RETENTION_DECISIONS
) => {
    const byTable = new Map();
    for (const decision of decisions) {
        for (const table of decision.tables) byTable.set(table, decision);
    }
    return byTable;
};

/**
 * @param {{
 *   models: { name: string, hasUserCascade: boolean }[],
 *   created: Set<string>,
 *   deleted: Set<string>,
 *   bounded?: Record<string, string>,
 *   retained?: Record<string, string>,
 *   pending?: typeof PENDING_RETENTION_DECISIONS,
 *   now?: Date,
 * }} input
 */
export function auditUnsweptTables({
    models,
    created,
    deleted,
    bounded = BOUNDED_TABLES,
    retained = RETAINED_TABLES,
    pending = PENDING_RETENTION_DECISIONS,
    now = new Date(),
}) {
    const unswept = [];
    const cascadeOnly = [];
    const errors = [];
    const held = pendingDecisionByTable(pending);
    const heldTables = [];

    for (const { name, hasUserCascade } of models) {
        if (!created.has(name)) continue;
        if (deleted.has(name)) continue;
        if (name in bounded || name in retained) continue;
        if (held.has(name)) {
            // Not `unswept`. A table with an owner and a date is a different
            // state from one nobody has looked at, and merging them loses the
            // only fact that distinguishes them.
            heldTables.push(name);
            continue;
        }
        if (hasUserCascade) {
            cascadeOnly.push(name);
            continue;
        }
        unswept.push(name);
    }

    for (const name of [
        ...Object.keys(bounded),
        ...Object.keys(retained),
        ...held.keys(),
    ]) {
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
    for (const name of held.keys()) {
        if (name in bounded || name in retained) {
            errors.push(
                `${name} is held for a pending decision and also registered as bounded or retained. A settled entry and an open decision cannot both be true of it.`
            );
        }
    }

    // Split rather than flagged, so the caller cannot print one sentence for
    // both. An overdue decision is not a louder version of a current hold; it
    // is the hold having failed.
    const decisions = { open: [], overdue: [] };
    for (const decision of pending) {
        const due = new Date(decision.dueBy);
        const overdue = now.getTime() > due.getTime();
        const daysPast = overdue
            ? Math.floor((now.getTime() - due.getTime()) / 86_400_000)
            : 0;
        decisions[overdue ? "overdue" : "open"].push({ ...decision, daysPast });
    }

    return { unswept, cascadeOnly, errors, heldTables, decisions };
}
