/**
 * Which lane each database integration suite runs in.
 *
 * The suite used to be one job. On 2026-08-15 its 20-minute timeout was raised
 * to 30 with a note saying what would have to happen next:
 *
 *   This is not a licence to grow: past about 25 minutes the suite needs
 *   splitting by scenario group, because raising this again would be the
 *   second time the number was chosen to fit the runtime rather than to
 *   bound it.
 *
 * By 2026-08-26 an ordinary run took 27-29 minutes. Every branch was one slow
 * minute from a red check that said nothing about the branch, and
 * `claude/to-develop/audit-no-rotation` drew it at 30.6 -- a documentation
 * change, cancelled by a timeout, on a suite its diff does not touch. So the
 * split is this file, and the timeout goes back to bounding a hang.
 *
 * ## Why a rule over the filename, not a list
 *
 * `run-db-integration-tests.mjs` names every suite in order, each with a
 * comment saying what it is there to prove. Copying them into one array per lane
 * would scatter that reasoning and put every future suite in front of a
 * question -- which array? -- that is easy to answer wrongly and silent when
 * it is. The runner keeps its list; this decides the lane from the name.
 *
 * ## The hole this must not reopen
 *
 * The runner's own comments record it: the import and memory suites "were
 * written alongside their slices but never listed here, i.e. never actually
 * run by CI -- a guard nobody runs is not a guard." Splitting the job is a
 * second way to lose a suite, so `tests/dbIntegrationGroups.test.mjs` asserts
 * that every `tests/integration/*.db.test.ts` on disk is listed by the runner
 * and lands in exactly one lane. That check did not exist before this split
 * and is the reason the split is safe to make.
 *
 * A new suite needs no edit here: an unmatched name falls to `accounts`, which
 * runs it rather than dropping it. Add a rule when a lane grows uneven, not to
 * make a suite run at all.
 */

/** Ordered most specific first: the first match wins. */
const LANE_RULES = [
  // Who may be written to and under which rules: consent and its
  // confirmation, jurisdiction, the campaign layer and the release-note sends
  // built on it. Split from `email` on 2026-10-02, when the two together were
  // 42 suites and the second-slowest lane; it must stay above `email`, whose
  // `email-` prefix would otherwise take these.
  [
    "consent",
    /^(campaign-|marketing-lane|email-(audience-expansion|campaign|consent-confirmation|jurisdiction-|login-signup-hold|marketing-reach|permission-ledger|policy-publication|preferences-consent|send-approval-cohort|statutory-display-readiness|verified-session-consent)|release-notes-|signup-consent)/,
  ],
  // Delivery: both email lanes, suppression, webhooks, templates and the two
  // report senders.
  [
    "email",
    /^(email-|founding-tester-pass-emails|model-lifecycle-|admin-email-delivery|credential-email-lane|standard-email-lane)/,
  ],
  // Assistant profiles: the version snapshot, the knowledge pipeline, package
  // import and export, and which revision a turn actually reads.
  ["assistant", /^(assistant-|chat-profile-context|conversation-profile-binding)/],
  // Account memory: extraction through retrieval, expiry and revocation.
  [
    "memory",
    /^(memory-|retention-sweep|chat-context-bundle|conversation-memory-mode)/,
  ],
  // Conversations and what they carry: external import, the snapshot lock,
  // retention and sharing, and -- since 2026-10-02, moved out of `accounts` --
  // continuation, pin/search/title, durable recovery, attachments and
  // generated artifacts. This lane was `import` until then.
  [
    "conversations",
    /^(external-import|external-conversation-|context-manifest-retention|public-share-route|default-model-reconciliation|conversation-(lock-migration|pin|search|title)|continuation-source-export|chat-durable-recovery|message-attachment|generated-artifacts)/,
  ],
  // Routing: the run, its attempts, the manifest boundary, and the product and
  // selection-mode attribution the ROUTE gates are written against.
  [
    "routing",
    /^(amux-orchestration|amux-agent-review-approval|amux-v4-|amuxV4|routing-|conversation-auto-selection|conversation-selection-mode|conversation-product-key|conversation-writer-product|chat-route-search-settlement)/,
  ],
  // Credits, reservations, settlement, Stripe, and the admission limits that
  // decide whether a paid turn starts at all.
  [
    "finance",
    /^(credit-finance|chat-concurrency|chat-rate-limit|chat-token-quota|fallback-pricing|chat-attempt-usage|model-registry|prompt-refiner-reservation|prompt-refiner-vnext-one-shot|subscription-sync-ordering|plan-change-|image-generation|refund-decision-route|stripe-webhook-route|webhook-reprocess-route|perplexity-deep-research-route|readiness-route)/,
  ],
  // The agents and the review machinery around them: AMUX intake, promotion
  // and reconciliation, the engineering and marketing agents, Prompt Refiner
  // shadow runs, and AI Review telemetry and feedback. Moved out of `accounts`
  // on 2026-10-02. Below `routing` and `finance` on purpose: their AMUX and
  // Prompt Refiner suites keep the lanes they had.
  [
    "agents",
    /^(amux-|engineering-agent-|ops-observer-|marketing-(automation|fact|templates|webhook)|prompt-refiner-|comparison-review-|feedback-lifecycle|support-triage-)/,
  ],
];

/**
 * The catch-all, and deliberately a real domain rather than a bucket named
 * "other": accounts, administrators, sign-in and providers. A suite nobody
 * classified runs here.
 */
export const DB_INTEGRATION_FALLBACK_GROUP = "accounts";

/**
 * A compatibility job, not a lane. CI's lanes run PostgreSQL 17; production's
 * version is not known to this repository, and docs/policy/support-triage.md
 * §4 requires the support-triage timeout suites to run on 16 as well, where
 * transaction_timeout does not exist. These suites also run in their own lane
 * on 17, so this list is outside the lane partition: it never removes a suite
 * from a lane, and `dbIntegrationGroupOf` never returns it.
 */
export const POSTGRES16_COMPAT_GROUP = "postgres16";
export const POSTGRES16_COMPAT_SUITES = Object.freeze([
  "tests/integration/support-triage-run.db.test.ts",
  "tests/integration/support-triage-timeouts.db.test.ts",
]);

export const DB_INTEGRATION_GROUPS = [
  ...LANE_RULES.map(([id]) => id),
  DB_INTEGRATION_FALLBACK_GROUP,
];

/** The lane for one suite, by path or bare filename. */
export function dbIntegrationGroupOf(testPath) {
  const name = testPath.slice(testPath.lastIndexOf("/") + 1);
  for (const [id, pattern] of LANE_RULES) {
    if (pattern.test(name)) return id;
  }
  return DB_INTEGRATION_FALLBACK_GROUP;
}
