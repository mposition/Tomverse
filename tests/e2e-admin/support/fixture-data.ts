/**
 * The deterministic Admin Console dataset.
 *
 * Identifiers and human-readable labels live here so specs assert on stable
 * strings instead of on whatever the seeder happened to write. Every value is
 * fixed; nothing is random and nothing is derived from the test's position in
 * the run, so a spec behaves identically whether it runs first, last or alone.
 *
 * Dates are the one exception: a few rows have to be positioned relative to
 * "now" for the product to classify them (an SLA breach is defined by age, a
 * privacy request by its due date). Those use fixed offsets from seed time,
 * and specs assert on the resulting *classification*, never on a rendered
 * timestamp.
 */

const CUSTOMER_DOMAIN = "customer-e2e.tomverse.invalid";

export const FIXTURE_CUSTOMERS = {
  /** Healthy paid customer. The default target for user-detail journeys. */
  activePro: {
    id: "e2e-customer-active-pro",
    email: `ada.active@${CUSTOMER_DOMAIN}`,
    name: "Ada Activepro",
    plan: "Pro",
  },
  /**
   * Deletion requested and scheduled: the one state in which the console
   * offers "Cancel deletion & restore account".
   */
  pendingDeletion: {
    id: "e2e-customer-pending-deletion",
    email: `ben.restore@${CUSTOMER_DOMAIN}`,
    name: "Ben Restorable",
    plan: "Free",
  },
  /** Suspended: recovery is not on offer, unsuspension is. */
  suspended: {
    id: "e2e-customer-suspended",
    email: `cara.suspended@${CUSTOMER_DOMAIN}`,
    name: "Cara Suspended",
    plan: "Free",
  },
  /** Carries credit debt and a disputed billing hold. */
  disputedHold: {
    id: "e2e-customer-disputed-hold",
    email: `dana.disputed@${CUSTOMER_DOMAIN}`,
    name: "Dana Disputed",
    plan: "Max",
  },
} as const;

export const FIXTURE_CONVERSATION = {
  id: "e2e-conversation-active-pro",
  title: "Quarterly model comparison",
} as const;

/**
 * Trace observability seeded onto the two open feedback rows (never as new
 * rows: the work-queue counter asserts on the open count). The `open` row is
 * the fully verified path -- signed token, recorded evidence, a Phase 2
 * shadow case awaiting human review; `slaBreached` is the honest opposite --
 * a client-classified EMPTY_RESPONSE with no token.
 */
export const FIXTURE_TRACE_REPORT = {
  verified: {
    traceId: "e2e10000-1111-4111-8111-111111111111",
    evidenceId: "e2e-trace-evidence-open",
    occurrenceId: "e2e-occurrence-open",
    errorCode: "AI_PROVIDER_ERROR",
    routeClass: "chat",
    release: "e2e-release-sha",
    caseId: "e2e-autofix-case-open",
  },
  clientClassified: {
    traceId: "e2e20000-2222-4222-8222-222222222222",
  },
} as const;

export const FIXTURE_FEEDBACK = {
  open: {
    id: "e2e-feedback-open",
    message: "Streaming stalls when I switch models mid-answer.",
    type: "bug",
  },
  /** Older than 24h and still open, so it lands in the SLA breach panel. */
  slaBreached: {
    id: "e2e-feedback-sla",
    message: "Export produced an empty PDF for a long conversation.",
    type: "bug",
    ageHours: 72,
  },
  resolved: {
    id: "e2e-feedback-resolved",
    message: "Korean IME composition was fixed, thank you.",
    type: "praise",
  },
} as const;

export const FIXTURE_PRIVACY_REQUEST = {
  open: {
    id: "e2e-privacy-open",
    email: `ada.active@${CUSTOMER_DOMAIN}`,
    requestType: "export",
  },
} as const;

export const FIXTURE_REFUNDS = {
  pending: {
    id: "e2e-refund-pending",
    email: `ada.active@${CUSTOMER_DOMAIN}`,
    plan: "Pro",
    reason: "Charged after cancelling the annual plan.",
    refundAmountCents: 1_500,
  },
  approved: {
    id: "e2e-refund-approved",
    email: `dana.disputed@${CUSTOMER_DOMAIN}`,
    plan: "Max",
    reason: "Duplicate subscription created by a failed checkout retry.",
    refundAmountCents: 2_500,
  },
} as const;

/**
 * The `ChatUsageBucket` rows seeded for the active Pro customer.
 *
 * `count` is a BigInt column, so Prisma hands these back as `bigint` no matter
 * how small they are -- which is what makes them the fixture that exercises the
 * admin detail route's serialization. `creditsMonth` deliberately sits past
 * int4, the range that forced the column to BigInt (see
 * docs/policy/credit-and-cost-limits.md), so an end-to-end read proves the full
 * width rather than only the happy digits.
 *
 * The rows are written under the application's own derived key, not the raw
 * user id -- see `userChatUsageKey` in `lib/chatUsageKey.ts`.
 */
export const FIXTURE_USAGE = {
  creditsToday: 17,
  creditsMonth: 2_500_000_000,
} as const;

export const FIXTURE_CREDIT = {
  purchaseId: "e2e-credit-purchase",
  lotId: "e2e-credit-lot",
  ledgerEntryId: "e2e-credit-ledger-grant",
  packId: "project_1500",
  creditsPurchased: 1_500,
} as const;

export const FIXTURE_PROMOTION = {
  id: "e2e-promotion-launch",
  /** 92% off and nearly exhausted, so the risk panel has something to show. */
  code: "E2ELAUNCH92",
  discountPercent: 92,
  maxRedemptions: 10,
} as const;

export const FIXTURE_MODEL = {
  /** Enabled model the registry lists and the tests toggle. */
  enabled: {
    id: "e2e-model-primary",
    name: "E2E Primary Model",
    provider: "openai",
    apiModel: "e2e-primary",
    /** `lib/modelRegistryShared.ts` allow-lists this exact base URL. */
    apiBaseUrl: "https://api.openai.com/v1",
  },
  /** Already disabled, so the registry has a non-enabled row to render. */
  disabled: {
    id: "e2e-model-disabled",
    name: "E2E Disabled Model",
    provider: "anthropic",
    apiModel: "e2e-disabled",
    /** `lib/modelRegistryShared.ts` allow-lists this exact base URL. */
    apiBaseUrl: "https://api.anthropic.com",
  },
  /**
   * Retired exactly as `isRetiredModel()` defines it -- delisted, disabled and
   * status disabled -- so the registry's lifecycle filter has a row that must
   * not be confused with the merely disabled one above.
   */
  retired: {
    id: "e2e-model-retired",
    name: "E2E Retired Model",
    provider: "google",
    apiModel: "e2e-retired",
    /** `lib/modelRegistryShared.ts` allow-lists this exact base URL. */
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  /**
   * Removed from the catalogue by an administrator (`catalogDeleted`). A
   * separate state from retirement, and still runnable-looking otherwise.
   */
  archived: {
    id: "e2e-model-archived",
    name: "E2E Archived Model",
    provider: "openai",
    apiModel: "e2e-archived",
    /** `lib/modelRegistryShared.ts` allow-lists this exact base URL. */
    apiBaseUrl: "https://api.openai.com/v1",
  },
} as const;

export const FIXTURE_INCIDENT = {
  active: {
    id: "e2e-incident-active",
    provider: "openai",
    title: "E2E openai latency incident",
    status: "limited",
  },
  resolved: {
    id: "e2e-incident-resolved",
    provider: "google",
    title: "E2E google recovered incident",
    status: "resolved",
  },
} as const;

export const FIXTURE_HEALTH_CHECK = {
  id: "e2e-health-check-openai",
  provider: "openai",
  status: "degraded",
  errorCode: "E2E_UPSTREAM_TIMEOUT",
} as const;

export const FIXTURE_NOTIFICATION = {
  failed: {
    id: "e2e-notification-failed",
    title: "E2E provider budget alert delivery failed",
    detail: "Slack webhook returned 500 for the openai budget alert.",
  },
} as const;

export const FIXTURE_ALERT_POLICY = {
  id: "e2e-alert-policy",
  name: "E2E default alert policy",
} as const;

/**
 * `jobKey` values must match `lib/scheduledJobs.ts`; the dashboard renders one
 * card per known job and joins runs onto it, so an invented key would be
 * silently dropped.
 */
export const FIXTURE_JOB_RUN = {
  succeeded: {
    id: "e2e-job-run-cleanup",
    jobKey: "retention_cleanup",
    label: "Retention cleanup",
  },
  failed: {
    id: "e2e-job-run-usage-sync",
    jobKey: "provider_usage_sync",
    label: "Provider usage and infrastructure report",
    error: "E2E provider usage sync failed",
  },
} as const;

export const FIXTURE_WEBHOOK = {
  failed: {
    id: "e2e-webhook-failed",
    stripeEventId: "evt_e2e_failed_checkout",
    eventType: "checkout.session.completed",
  },
  processed: {
    id: "e2e-webhook-processed",
    stripeEventId: "evt_e2e_processed_checkout",
    eventType: "checkout.session.completed",
  },
} as const;

export const FIXTURE_AUDIT_LOG = {
  id: "e2e-audit-seed",
  action: "platform.settings_updated",
  summary: "E2E seeded audit entry for the audit log surface.",
} as const;

export const FIXTURE_RETENTION_RUN = {
  id: "e2e-retention-run",
  mode: "dry-run",
} as const;

/**
 * The guest default has to stay one of `GUEST_BRAND_TRIO_MODEL_IDS`, because
 * that is the only list the Platform Settings selector offers -- and the model
 * registry route refuses to restrict whichever model this points at.
 */
export const FIXTURE_APP_SETTINGS = {
  guestDefaultModelId: "gemini-2-5-flash",
  alternateGuestDefaultModelId: "claude-haiku-4-5",
} as const;

/**
 * `eventName` must be one of `PRODUCT_ANALYTICS_EVENT_NAMES`; the funnel table
 * is built from that list, so an unknown name renders nowhere.
 */
export const FIXTURE_ANALYTICS = {
  eventName: "landing_view",
  utmCampaign: "admin-console-e2e",
  count: 4,
} as const;

export const FIXTURE_PROVIDER_USAGE = {
  provider: "openai",
  estimatedCostMicroUsd: 4_250_000,
} as const;
