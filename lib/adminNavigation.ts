import type { AdminRole } from "@/lib/adminAuthCore";

/**
 * The Admin Console information architecture.
 *
 * One table, no React, no icons: the sidebar, the command palette, the pinned
 * pages store, the breadcrumb, the per-page tab strips and the legacy redirects
 * all read from here. Keeping it framework-free is what lets a server component
 * (the layout's badge counts) and a client component (the sidebar) agree on the
 * same route table without either importing the other.
 *
 * Icons live in `components/admin/adminNavigationIcons.ts`, keyed by item id,
 * because a `lucide-react` import would make this module unusable from a plain
 * Node test.
 *
 * Eight groups, thirty-two entries, at most six entries to a group (operator
 * approval, 2026-11-07). Every tab of every page is declared here, including
 * the ones whose screen is not built yet, so the later screen work changes a
 * page and never this table.
 */

export const ADMIN_NAV_GROUPS = [
  "Home",
  "Customers & Revenue",
  "AI Platform",
  "AI Agents",
  "Development",
  "System",
  "Messaging",
  "Governance",
] as const;

export type AdminNavGroup = (typeof ADMIN_NAV_GROUPS)[number];

/**
 * Which counter the sidebar renders beside an entry.
 *
 * Only entries an operator is expected to *act* on carry one. A badge on a
 * reference page would be noise, and a badge that never changes teaches an
 * operator to stop reading badges.
 */
export type AdminNavBadgeKey =
  | "abandonedLegalEmail"
  | "workQueue"
  | "support"
  | "refunds"
  | "providers"
  | "automation"
  | "alerts"
  | "modelLifecycle"
  | "emailCampaigns"
  | "marketing"
  | "productResearch"
  | "amuxOwnerQueue"
  | "amuxOrchestratorHalts"
  | "amuxExecution"
  | "amuxDecisionMaker";

export type AdminNavTab = {
  id: string;
  label: string;
  description: string;
  /**
   * Roles the tab strip shows this section to. Absent means every admin role.
   *
   * Visibility only, like `writeRoles`: the page still decides on its own
   * whether to render the section, and answers 404 to a role it refuses.
   * `tests/adminNavigation.test.mjs` keeps the two equal, so the strip never
   * offers a section that answers 404 and never hides one that would open.
   */
  viewRoles?: readonly AdminRole[];
  /** Counter shown beside the tab, from the same counts as the sidebar. */
  badge?: AdminNavBadgeKey;
};

export type AdminNavItem = {
  id: string;
  label: string;
  href: string;
  description: string;
  group: AdminNavGroup;
  /** Extra search terms the command palette matches on. */
  aliases: readonly string[];
  writeRoles?: readonly AdminRole[];
  /**
   * Roles the sidebar, the palette, pins and recents show this entry to.
   * Absent means every admin role.
   *
   * A page that answers 404 to a role is not advertised to it. Before this
   * field existed the owner-only AMUX screens were left out of the table
   * altogether, because the table fed every role's palette. Visibility is not
   * authorization: the page and its API routes still refuse on their own.
   */
  viewRoles?: readonly AdminRole[];
  badge?: AdminNavBadgeKey;
  tabs?: readonly AdminNavTab[];
  /**
   * The page uses the main column's full width instead of the console's
   * reading width. Only for a page whose content is a canvas that grows with
   * the space it gets (the Agent office floor); tables and forms keep the
   * reading width.
   */
  wide?: true;
};

export const ADMIN_NAVIGATION: readonly AdminNavItem[] = [
  // ---------------------------------------------------------------- Home
  {
    id: "overview",
    label: "Today",
    href: "/admin/overview",
    description: "Operational snapshot, attention queue, and recent activity",
    group: "Home",
    aliases: [
      "overview",
      "today",
      "home",
      "dashboard",
      "kpi",
      "status",
      "health",
      "snapshot",
      "health score",
      "score",
      "environment",
      "env",
      "variables",
    ],
    tabs: [
      {
        id: "summary",
        label: "Summary",
        description: "Operational snapshot, attention queue, and recent activity",
      },
      {
        id: "health",
        label: "Health score",
        description: "How the score was arrived at, and what to do about each line",
      },
    ],
  },
  {
    id: "work-queue",
    label: "Decisions",
    href: "/admin/work-queue",
    description: "Everything waiting on a person, by area",
    group: "Home",
    badge: "workQueue",
    aliases: ["work queue", "decisions", "decide", "inbox", "queue", "todo", "pending", "backlog", "approvals"],
    tabs: [
      {
        id: "all",
        label: "All",
        description: "Everything waiting on a person, oldest first",
      },
      {
        id: "customers",
        label: "Customers & revenue",
        description: "Support, refunds, privacy requests and billing decisions",
      },
      {
        id: "agents",
        label: "Agents",
        description: "What the AI agents are waiting on a person for",
      },
      {
        id: "development",
        label: "Development",
        description: "Idea approvals, plan approvals, escalations and halts",
      },
      {
        id: "system",
        label: "System",
        description: "Webhooks, scheduled jobs and alert deliveries that need a look",
      },
    ],
  },
  {
    id: "analytics",
    label: "Metrics",
    href: "/admin/analytics",
    description: "Active users, usage, model share, product funnel, AI Review, and import/memory metrics",
    group: "Home",
    aliases: [
      "analytics",
      "metrics",
      "usage",
      "active users",
      "dau",
      "mau",
      "model share",
      "geography",
      "language",
      "funnel",
      "activation",
      "conversion",
      "ga4",
      "product analytics",
      "memory",
      "import",
      "external import",
      "ai review",
      "cross review",
      "comparison review",
      "reviewer",
    ],
    tabs: [
      {
        id: "usage",
        label: "Usage",
        description: "Active users, messages, model share, and when and where people use Tomverse",
      },
      {
        id: "product",
        label: "Product & funnel",
        description: "Acquisition, activation, and revenue funnel",
      },
      {
        id: "ai-review",
        label: "AI Review",
        description: "Reliability, adoption, and reviewer-pair evidence",
      },
      {
        id: "imports",
        label: "Imports & memory",
        description: "External conversation import and memory metrics",
      },
    ],
  },
  // --------------------------------------------------- Customers & Revenue
  {
    id: "users",
    label: "Users",
    href: "/admin/users",
    description: "Accounts, usage, plans, and account controls",
    group: "Customers & Revenue",
    writeRoles: ["owner", "support"],
    aliases: ["customers", "accounts", "people", "subscribers", "email"],
  },
  {
    id: "support",
    label: "Support",
    href: "/admin/support",
    description: "Inquiries, the automatic fix review, and data-rights requests",
    group: "Customers & Revenue",
    writeRoles: ["owner", "support"],
    badge: "support",
    aliases: [
      "feedback",
      "inbox",
      "inquiries",
      "tickets",
      "cases",
      "auto fix",
      "autofix",
      "privacy",
      "gdpr",
      "data rights",
      "complaints",
    ],
    tabs: [
      {
        id: "feedback",
        label: "Inquiries",
        description: "Reports and requests submitted from the product",
      },
      {
        id: "autofix",
        label: "Auto-fix review",
        description: "Fixes the automation proposed from verified reports, waiting for a person",
      },
      {
        id: "privacy",
        label: "Privacy requests",
        description: "Export and erasure requests",
      },
    ],
  },
  {
    id: "billing",
    label: "Plans & pricing",
    href: "/admin/billing",
    description: "Plans, price catalogue, promotions, and promotion diagnostics",
    group: "Customers & Revenue",
    writeRoles: ["owner", "billing"],
    aliases: [
      "billing",
      "plans",
      "prices",
      "pricing",
      "stripe",
      "subscriptions",
      "catalogue",
      "promotions",
      "coupon",
      "discount",
      "risk",
      "diagnostics",
    ],
    tabs: [
      {
        id: "plans",
        label: "Plans",
        description: "Plan catalogue, Stripe IDs, and lifecycle counters",
      },
      {
        id: "prices",
        label: "Prices",
        description: "Localized prices for each plan and currency",
      },
      {
        id: "promotions",
        label: "Promotions",
        description: "Promotion codes and their abuse signals",
      },
      {
        id: "diagnostics",
        label: "Diagnostics",
        description: "Read-only checks on each promotion code",
      },
    ],
  },
  {
    id: "refunds",
    label: "Refunds",
    href: "/admin/refunds",
    description: "Refund review queue and reviewed requests",
    group: "Customers & Revenue",
    writeRoles: ["owner", "billing"],
    badge: "refunds",
    aliases: ["cancellations", "chargeback", "dispute", "money back"],
  },
  {
    // No `writeRoles`: the page reads the ledger and nothing on it writes.
    id: "credit-ledger",
    label: "Credit ledger",
    href: "/admin/credit-ledger",
    description: "Credit grants, settlements, and outstanding debt",
    group: "Customers & Revenue",
    aliases: ["credits", "ledger", "grants", "settlement", "debt"],
  },
  // ------------------------------------------------------------ AI Platform
  {
    id: "providers",
    label: "Providers",
    href: "/admin/providers",
    description: "Availability, spend, incidents, and fallback policy",
    group: "AI Platform",
    writeRoles: ["owner", "ops"],
    badge: "providers",
    aliases: [
      "openai",
      "anthropic",
      "google",
      "perplexity",
      "outage",
      "incident",
      "fallback",
      "usage",
      "cost",
      "spend",
      "balance",
      "budget",
    ],
    tabs: [
      {
        id: "health",
        label: "Status",
        description: "Availability, keys, and per-model metrics",
      },
      {
        id: "usage-cost",
        label: "Usage & cost",
        description: "Provider usage reconciliation and image spend",
      },
      {
        id: "incidents",
        label: "Incidents & fallback",
        description: "Readiness tests, incident mode, and recovery",
      },
    ],
  },
  {
    id: "models",
    label: "Models",
    href: "/admin/models",
    description: "Model registry, what discovery has found, and the default models",
    group: "AI Platform",
    writeRoles: ["owner", "ops"],
    badge: "modelLifecycle",
    aliases: [
      "registry",
      "catalogue",
      "catalog",
      "gpt",
      "claude",
      "gemini",
      "discovery",
      "candidates",
      "lifecycle",
      "backlog",
      "default model",
      "guest lineup",
      "fallback model",
    ],
    tabs: [
      {
        id: "registry",
        label: "Registry",
        description: "Availability, pricing overrides, and API configuration",
      },
      {
        id: "discovery",
        label: "Discovery",
        description: "Models a provider listed that nobody has decided about",
      },
      {
        id: "defaults",
        label: "Default models",
        description: "The fallback model, the guest lineup and the account default",
      },
      {
        id: "catalog",
        label: "Image & coding catalog",
        description: "Enable or hold image and coding models, price history, LLM drafts, the Code snapshot",
      },
    ],
  },
  {
    // `ops:write` is what every auto-router route checks, so the table says so;
    // it said nothing, and the screen never marked itself read-only.
    id: "routing",
    label: "Routing",
    href: "/admin/routing",
    description: "Auto router, optimizers, shadow comparison and statistics",
    group: "AI Platform",
    writeRoles: ["owner", "ops"],
    aliases: [
      "auto",
      "auto router",
      "router",
      "optimizer",
      "shadow",
      "statistics",
      "task profile",
      "candidates",
    ],
    tabs: [
      {
        id: "auto",
        label: "Auto router",
        description: "The Auto model router, its mode and its tunables",
      },
      {
        id: "optimizer",
        label: "Optimizer",
        description: "Router and rewrite optimizer recommendations",
      },
      {
        id: "shadow",
        label: "Shadow comparison",
        description: "What the router would have chosen against what ran",
      },
      {
        id: "stats",
        label: "Statistics",
        description: "Adaptive routing statistics",
        viewRoles: ["owner"],
      },
    ],
  },
  // -------------------------------------------------------------- AI Agents
  {
    // A pixel office for the agent teams and the AMUX workers, drawn from their
    // records, that links each one to the page that holds its record. Read
    // only, so it carries no badge and no writeRoles; the owner's AI briefing
    // writes only its own settings rows and audit entry (lib/agentOfficeBriefing.ts).
    id: "office",
    label: "Agents home",
    href: "/admin/office",
    // The office floor scales to the space it is given.
    wide: true,
    description: "The agent teams at a glance, each with a link to its record",
    group: "AI Agents",
    aliases: ["office", "agents", "agent teams", "pixel office", "live office", "team board", "agents home"],
    // The office draws its own tab strip, as the original UI did; its tabs are
    // links to these sections. The team board opens first (2026-11-07).
    tabs: [
      {
        id: "dashboard",
        label: "Team board",
        description: "Team board, digest brief and each team's record link",
      },
      {
        id: "live",
        label: "Live office",
        description: "The floor, what waits on you, each worker's sheet, the roster and today's merges",
      },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    href: "/admin/marketing",
    description:
      "Draft approvals, published posts, brand accounts, and what the automation reported",
    group: "AI Agents",
    writeRoles: ["owner", "ops"],
    badge: "marketing",
    aliases: [
      "social",
      "posts",
      "linkedin",
      "zernio",
      "campaign",
      "brand account",
      "draft queue",
      "approvals",
      "competitors",
      "assets",
      "guard",
    ],
    tabs: [
      {
        id: "overview",
        label: "Overview",
        description: "Mode, switches, the last run and what is waiting",
      },
      {
        id: "queue",
        label: "Approvals",
        description: "Drafts waiting on a person, and what the Guard said about each",
      },
      {
        id: "published",
        label: "Publishing",
        description:
          "Every approved post: waiting, in flight, published, failed, or unconfirmed",
      },
      {
        id: "accounts",
        label: "Accounts",
        description: "Brand accounts, their mode, and why a paused one is paused",
      },
      {
        id: "reports",
        label: "Reports & competitors",
        description: "Weekly summaries, competitor facts, and which hosts a person approved as official",
      },
      {
        id: "settings",
        label: "Settings",
        description: "Switches and webhook wiring for the marketing automation",
      },
    ],
  },
  {
    id: "product-research",
    label: "Product research",
    href: "/admin/product-research",
    description:
      "What the Scout suggests improving on the public pages, generated files and catalogue, and its runs and spending",
    group: "AI Agents",
    writeRoles: ["owner", "ops"],
    badge: "productResearch",
    aliases: [
      "scout",
      "improvement",
      "suggestion",
      "product research",
      "observation",
      "issue backlog",
      "slot",
    ],
    tabs: [
      {
        id: "suggestions",
        label: "Suggestions",
        description: "Open Scout suggestions by page or file, to dismiss or send to AMUX",
        badge: "productResearch",
      },
      {
        id: "runs",
        label: "Runs & cost",
        description: "Whether the Scout ran, the model and daily cap an owner chose, and the last seven days",
      },
      {
        id: "observations",
        label: "Issue observations",
        description:
          "Observation slots, the newest one's rows, and the staging and production windows",
      },
    ],
  },
  {
    id: "engineering-agent",
    label: "Engineering",
    href: "/admin/engineering-agent",
    description: "The engineering agent's record: decisions waiting, runs, pull requests and its mode",
    group: "AI Agents",
    writeRoles: ["owner", "ops"],
    aliases: [
      "engineering agent",
      "engineering",
      "agent",
      "t2 draft",
      "patch",
      "pull request",
      "publisher",
      "runner",
      "freeze",
    ],
    tabs: [
      {
        id: "overview",
        label: "Overview",
        description: "Mode, switches, the last run and what is waiting",
      },
      {
        id: "queue",
        label: "Decisions waiting",
        description: "T2 drafts, decisions and state mismatches waiting on a person",
      },
      {
        id: "runs",
        label: "Runs & PRs",
        description: "Each run and the pull requests the agent bound, with how each ended",
      },
      {
        id: "settings",
        label: "Settings",
        description: "Mode, freeze, the kill switch and the owner queue against its caps",
      },
    ],
  },
  {
    id: "sre-ops",
    label: "SRE",
    href: "/admin/sre-ops",
    description: "The ops observer's state chain, its trust verdict, its daily report and the owner's genesis",
    group: "AI Agents",
    writeRoles: ["owner"],
    aliases: ["sre", "sre agent", "ops observer", "genesis", "trust", "state chain", "pager", "daily report"],
    tabs: [
      {
        id: "overview",
        label: "Overview",
        description: "The state chain, its trust verdict and the owner's genesis",
      },
      {
        id: "daily",
        label: "Daily report",
        description: "What the ops observer reported each day",
      },
      {
        id: "settings",
        label: "Settings",
        description: "Mode and switches for the ops observer",
      },
    ],
  },
  {
    // The pending-price deadline digest left Agent digests for its own page
    // (2026-11-07), with the agent's switch and its monitor check.
    id: "finance-agent",
    label: "Billing & finance",
    href: "/admin/finance-agent",
    description: "The daily pending-price deadline digest, the agent switch and the monitor check",
    group: "AI Agents",
    writeRoles: ["owner", "ops"],
    aliases: ["finance", "billing agent", "price deadline", "billing-finance-ops", "digest", "pending price"],
    tabs: [
      {
        id: "overview",
        label: "Overview",
        description: "The agent switch, the monitor check and the newest digest",
      },
      {
        id: "report",
        label: "Price deadline report",
        description: "The daily pending-price deadline report",
      },
      {
        id: "settings",
        label: "Settings",
        description: "Mode and switches for the billing and finance agent",
      },
    ],
  },
  // ------------------------------------------------------------ Development
  // AMUX: the development-agent work board (docs/policy/development-agent-orchestration.md).
  // Ideas is owner-only -- the page and every API route behind it answer 404
  // to any other role -- so it is shown to the owner alone. The execution
  // board opens to every admin because its review queue does; its board is
  // owner-only like the page it replaced.
  {
    id: "amux-backlog",
    label: "Ideas",
    href: "/admin/amux-backlog",
    description: "Idea input, the card list and portfolio assessment",
    group: "Development",
    writeRoles: ["owner"],
    viewRoles: ["owner"],
    aliases: [
      "amux",
      "backlog",
      "intake",
      "idea analysis",
      "new idea",
      "register card",
      "priority",
      "cost estimate",
      "portfolio",
      "assessment",
    ],
    tabs: [
      {
        id: "ideas",
        label: "Ideas",
        description: "Enter an idea, approve its execution and its plan",
      },
      {
        id: "list",
        label: "Card list",
        description: "Backlog cards, creation dates, summaries and recorded scores",
      },
      {
        id: "portfolio",
        label: "Portfolio",
        description: "Strategic assessment and score of each card",
      },
    ],
  },
  {
    id: "amux-execution",
    label: "Execution board",
    href: "/admin/amux-execution",
    description: "AMUX cards and their execution state, the cards waiting on you, and diagnostics",
    group: "Development",
    // Assignment decisions take `ops:write` (every /api/admin/amux/escalations
    // route checks it); the owner-only board writes nothing.
    writeRoles: ["owner", "ops"],
    // Halts belong to Safety & recovery, so this counts what waits on the
    // owner here: the cards of "Waiting on me". The sidebar entry, that tab and
    // the board's column read the one count (lib/amux/ownerQueueCore.ts).
    badge: "amuxOwnerQueue",
    aliases: [
      "amux",
      "board",
      "cards",
      "execution",
      "attempt",
      "assignment",
      "escalation",
      "human review",
      "review",
      "review queue",
      "waiting on me",
      "owner queue",
      "worker question",
      "diagnostics",
      "worker performance",
      "decision log",
      "incident",
    ],
    tabs: [
      {
        id: "cards",
        label: "Board",
        description: "Every AMUX card stored in Tomverse and its execution state",
        viewRoles: ["owner"],
        badge: "amuxDecisionMaker",
      },
      {
        id: "review",
        label: "Waiting on me",
        description: "Every card that waits on you, one after another: decisions, worker questions and recoveries",
        badge: "amuxOwnerQueue",
      },
      {
        id: "diagnostics",
        label: "Diagnostics",
        description: "Worker performance and the decision log",
      },
    ],
  },
  {
    // QA and release left Agent digests for its own page (owner, 2026-10-23),
    // and moved to /admin/release with the redesign (2026-11-07): the merge
    // lane, CI admission and the release train are one pipeline the operator
    // works in, not one agent's daily report.
    id: "release",
    label: "Release",
    href: "/admin/release",
    description: "From develop merge to production: the merge lane, the release train and the CI queue",
    group: "Development",
    writeRoles: ["owner", "ops"],
    aliases: [
      "qa",
      "qa-release",
      "release",
      "release readiness",
      "merge lane",
      "release train",
      "control revision",
      "ci admission",
      "ci queue",
      "runners",
    ],
    tabs: [
      {
        id: "qa",
        label: "QA & release",
        description:
          "What needs the operator, production against main, the merge lane and the release train",
      },
      {
        id: "ci",
        label: "CI queue",
        description: "Pull requests waiting for runners, their order and live runner usage",
      },
    ],
  },
  {
    id: "amux-settings",
    label: "AMUX settings",
    href: "/admin/amux-settings",
    description: "AMUX automatic admission, workers, Decision Maker controls and analysis budget",
    group: "Development",
    // A worker registry change takes the owner role and a recent step-up in
    // its route (orchestration policy version 31, section 3).
    writeRoles: ["owner", "ops"],
    aliases: [
      "amux",
      "settings",
      "worker",
      "workers",
      "registry",
      "worker registry",
      "automatic admission",
      "auto admission",
      "orchestrator",
      "decision maker",
      "kill switch",
      "analysis settings",
      "analysis budget",
    ],
    tabs: [
      {
        id: "automatic-admission",
        label: "Automatic admission",
        description: "Owner approval for ready Tasks to enter unassigned Todo",
        viewRoles: ["owner"],
      },
      {
        id: "workers",
        label: "Workers",
        description: "Register AI workers, choose what each can do, and turn them on or off",
      },
      {
        id: "decision-maker",
        label: "Decision Maker",
        description: "The Decision Maker kill switch and the mode of each instance",
      },
      {
        id: "analysis",
        label: "Analysis budget & models",
        description: "Monthly analysis budget and approved analysis models",
        viewRoles: ["owner"],
      },
    ],
  },
  {
    // Halts, unused reservations and the retired promotion and import tools,
    // gathered in one place (2026-11-07). Every admin role reads the halts, as
    // it did in Operations settings; the owner alone clears one.
    id: "amux-recovery",
    label: "Safety & recovery",
    href: "/admin/amux-recovery",
    description: "Execution safety and halts, reservation recovery, and the retired AMUX tools",
    group: "Development",
    writeRoles: ["owner"],
    badge: "amuxOrchestratorHalts",
    aliases: [
      "amux",
      "safety",
      "recovery",
      "halt",
      "halts",
      "outcome unknown",
      "reservation",
      "claim",
      "claim resolution",
      "legacy",
      "catalog import",
      "board import",
      "reconciliation",
      "source revision",
      "metadata",
      "promotion",
      "recommendation",
      "auto-promotion",
      "grant",
    ],
    tabs: [
      {
        id: "safety",
        label: "Execution safety",
        description: "Automatic recovery, evidence to inspect and operator halt decisions",
        badge: "amuxOrchestratorHalts",
      },
      {
        id: "reservations",
        label: "Reservations & claims",
        description: "Unused analysis reservations and claims that need a decision",
        viewRoles: ["owner"],
      },
      {
        id: "legacy",
        label: "Legacy tools",
        description: "Catalog import, source reconciliation, card metadata and card promotion",
        viewRoles: ["owner"],
      },
    ],
  },
  // ----------------------------------------------------------------- System
  {
    id: "infrastructure",
    label: "Infrastructure",
    href: "/admin/infrastructure",
    description: "Railway, R2, database, and Prisma operations",
    group: "System",
    writeRoles: ["owner", "ops", "billing"],
    aliases: ["railway", "r2", "database", "prisma", "hosting", "storage"],
  },
  {
    id: "automation",
    label: "Automation",
    href: "/admin/automation",
    description: "Scheduled jobs, webhook delivery, and operations reports",
    group: "System",
    writeRoles: ["owner", "ops", "billing"],
    badge: "automation",
    aliases: [
      "cron",
      "jobs",
      "scheduler",
      "webhook",
      "stripe events",
      "replay",
      "report",
    ],
    tabs: [
      {
        id: "jobs",
        label: "Scheduled jobs",
        description: "Cron health, history, and stuck runs",
      },
      {
        id: "webhooks",
        label: "Webhooks",
        description: "Billing event delivery and replay",
      },
      {
        id: "reports",
        label: "Reports",
        description: "Operations reports and their distribution",
      },
    ],
  },
  {
    id: "platform",
    label: "Feature flags",
    href: "/admin/platform",
    description: "Emergency stops, feature switches and account defaults",
    group: "System",
    writeRoles: ["owner", "ops"],
    aliases: [
      "platform",
      "platform settings",
      "settings",
      "defaults",
      "feature flags",
      "kill switch",
      "emergency",
      "switches",
      "guest default",
    ],
    tabs: [
      {
        id: "emergency",
        label: "Emergency stops",
        description: "Kill switches for chat, attachments and public sharing",
      },
      {
        id: "features",
        label: "Feature switches",
        description: "Rollout switches for product features",
      },
      {
        id: "account-defaults",
        label: "Account defaults",
        description: "Defaults that new and existing accounts start from",
      },
    ],
  },
  // -------------------------------------------------------------- Messaging
  {
    id: "email-campaigns",
    label: "Email campaigns",
    href: "/admin/email-campaigns",
    description:
      "Campaign drafts, what each one is waiting on, and the waves that are due",
    group: "Messaging",
    writeRoles: ["owner", "ops"],
    badge: "emailCampaigns",
    aliases: [
      "campaign",
      "fan-out",
      "fanout",
      "wave",
      "reminder",
      "retirement notice",
      "bulk email",
      "announcement",
      "attestation",
      "approve campaign",
      "new campaign",
    ],
    tabs: [
      {
        id: "campaigns",
        label: "Campaigns",
        description: "Every campaign, its status, and what still blocks its send",
      },
      {
        id: "schedule",
        label: "Schedule",
        description: "Waves by the time they are due, overdue ones first",
      },
      {
        id: "new",
        label: "New campaign",
        description: "Write a campaign or a policy-change notice",
      },
    ],
  },
  {
    id: "email-delivery",
    label: "Customer mail",
    href: "/admin/email-delivery",
    description: "What was sent to whom, what was refused, and which addresses are suppressed",
    group: "Messaging",
    writeRoles: ["owner", "ops"],
    badge: "abandonedLegalEmail",
    aliases: [
      "email delivery",
      "outbox",
      "delivery log",
      "bounce",
      "complaint",
      "suppression",
      "unsubscribe",
      "abandoned",
      "dead letter",
      "did not arrive",
      "never received",
      "email history",
    ],
    tabs: [
      {
        id: "deliveries",
        label: "Delivery log",
        description: "Every message and what became of it",
      },
      {
        id: "suppressions",
        label: "Suppressions",
        description: "Addresses we will not mail, and why",
      },
    ],
  },
  {
    id: "alerts",
    label: "Operator alerts",
    href: "/admin/alerts",
    description: "Alert thresholds, templates, the delivery log and the mail path test",
    group: "Messaging",
    writeRoles: ["owner", "ops"],
    badge: "alerts",
    aliases: ["alerts", "notifications", "slack", "discord", "thresholds", "paging", "probe"],
    tabs: [
      {
        id: "policy",
        label: "Policy",
        description: "Budget and incident thresholds",
      },
      {
        id: "templates",
        label: "Templates",
        description: "Message templates and delivery tests",
      },
      {
        id: "deliveries",
        label: "Delivery log",
        description: "What was sent, to where, and whether it landed",
      },
      {
        id: "mail-test",
        label: "Mail path test",
        description: "Send a test operator alert through the mail path",
      },
    ],
  },
  {
    id: "email-policy",
    label: "Email policy",
    href: "/admin/email-policy",
    description: "Jurisdiction profiles for outbound mail, and which version is in force",
    group: "Messaging",
    writeRoles: ["owner", "ops"],
    aliases: [
      "email",
      "jurisdiction",
      "unsubscribe",
      "marketing",
      "footer",
      "subject prefix",
      "quiet hours",
      "consent",
      "dmarc",
      "dkim",
      "spf",
      "sending domain",
      "deliverability",
    ],
    tabs: [
      {
        id: "jurisdictions",
        label: "Jurisdictions",
        description: "Profile versions, and which one is in force",
      },
      {
        id: "domains",
        label: "Sending domains",
        description: "Domain verification and DNS record status",
      },
    ],
  },
  // ------------------------------------------------------------- Governance
  {
    id: "audit",
    label: "Audit log",
    href: "/admin/audit",
    description: "Administrator activity with actor and target, and the integrity check of the log",
    group: "Governance",
    aliases: ["log", "history", "activity", "trail", "who changed", "integrity", "hash chain", "tamper"],
    tabs: [
      {
        id: "log",
        label: "Records",
        description: "Administrator activity, with actor and target",
      },
      {
        id: "integrity",
        label: "Integrity check",
        description: "Tamper-evidence for the audit log",
      },
    ],
  },
  {
    id: "retention",
    label: "Retention & deletion",
    href: "/admin/retention",
    description: "Retention windows and destructive cleanup",
    group: "Governance",
    writeRoles: ["owner", "ops"],
    aliases: ["retention", "cleanup", "purge", "delete", "data lifecycle"],
  },
  {
    id: "admin-access",
    label: "Admin access",
    href: "/admin/admin-access",
    description: "Administrator roles and expiry, and operational readiness",
    group: "Governance",
    writeRoles: ["owner"],
    aliases: [
      "roles",
      "permissions",
      "rbac",
      "administrators",
      "readiness",
    ],
    tabs: [
      {
        id: "administrators",
        label: "Administrators",
        description: "Configured identities, roles, and expiry",
      },
      {
        id: "readiness",
        label: "Operational readiness",
        description: "Checkpoints an operator must confirm",
      },
    ],
  },
] as const;

export const ADMIN_NAV_ITEMS_BY_GROUP: ReadonlyArray<{
  label: AdminNavGroup;
  items: readonly AdminNavItem[];
}> = ADMIN_NAV_GROUPS.map((label) => ({
  label,
  items: ADMIN_NAVIGATION.filter((item) => item.group === label),
}));

/** Routes that exist but are deliberately absent from the sidebar. */
export const ADMIN_UNLISTED_PAGES = [
  {
    id: "search",
    label: "Global search",
    href: "/admin/search",
    description:
      "Search customers, refunds, traces, and audit events across the console",
    aliases: ["find", "lookup", "trace", "everything"],
  },
  {
    // The Trust and safety digest has no menu of its own yet; it kept the
    // address it always had (the activation step-up and the Agent office link
    // it). Every other `/admin/agent-digests` address redirects
    // (ADMIN_AGENT_DIGESTS_LEGACY_TABS).
    id: "agent-digests",
    label: "Trust and safety digest",
    href: "/admin/agent-digests",
    description:
      "DSR deadlines counted when the page opens, and the trust and safety observation switch",
    aliases: ["trust", "safety", "trust and safety", "dsr", "privacy deadline", "digest", "observer"],
    /** The one `?tab=` this page renders; every other value redirects. */
    sections: ["trust-safety"],
    /** Where the palette and pins open it: the bare address redirects to Release. */
    openHref: "/admin/agent-digests?tab=trust-safety",
  },
] as const;

export type AdminPageMeta = {
  label: string;
  description: string;
  href: string;
  group: AdminNavGroup | null;
  parentLabel?: string;
  parentHref?: string;
  /** False for a route the navigation table does not describe. */
  isKnown: boolean;
};

const matchesRoute = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * The navigation entry a pathname belongs to, or `null` for a route outside the
 * table.
 */
export const findAdminNavItem = (pathname: string): AdminNavItem | null =>
  ADMIN_NAVIGATION.find((item) => matchesRoute(pathname, item.href)) || null;

export const ADMIN_DETAIL_ROUTES = [
  {
    // This one-card diagnostic is linked from the owner-only AMUX execution
    // view. Detail metadata provides its breadcrumb without advertising it in
    // the global palette for roles that cannot open the page.
    id: "amux-u21-test-card",
    pattern: /^\/admin\/amux-u21-test-card$/,
    label: "AMUX U21 test card",
    description: "Owner-only synthetic candidate receipt diagnostic",
    parentLabel: "Execution board",
    parentHref: "/admin/amux-execution",
    group: "Development" as const,
    viewRoles: ["owner"] as const,
  },
  {
    // Deliberately omitted from ADMIN_NAVIGATION and ADMIN_UNLISTED_PAGES:
    // those tables feed the palette for every admin role, while this one-shot
    // cost-authority surface is owner-only and should not be advertised to
    // roles that receive a 404 from the page and API routes.
    id: "prompt-refiner-shadow",
    pattern: /^\/admin\/prompt-refiner-shadow$/,
    label: "Prompt Refiner shadow run",
    description:
      "Owner-only approval and execution for the frozen synthetic shadow run",
    parentLabel: "Models",
    parentHref: "/admin/models",
    group: "AI Platform" as const,
  },
  {
    id: "user-detail",
    pattern: /^\/admin\/users\/[^/]+$/,
    label: "Customer detail",
    description: "Account timeline, billing, credits, and security controls",
    parentLabel: "Users",
    parentHref: "/admin/users",
    group: "Customers & Revenue" as const,
    // The detail page's sections, declared with the rest of the table so the
    // screen work that builds them does not edit it (2026-11-07).
    tabs: [
      { id: "overview", label: "Overview", description: "Who the customer is, their plan and recent activity" },
      { id: "billing", label: "Billing", description: "Subscription, credits, refunds and invoices" },
      { id: "security", label: "Security", description: "Sign-in methods, sessions and account locks" },
      { id: "conversations", label: "Conversations", description: "The customer's conversations and what ran in them" },
      { id: "notes", label: "Notes & timeline", description: "Operator notes and the account timeline" },
    ],
  },
  {
    id: "campaign-detail",
    pattern: /^\/admin\/email-campaigns\/[^/]+$/,
    label: "Campaign detail",
    description:
      "The copy this campaign sends, who has attested to what, and whether it may go out",
    parentLabel: "Email campaigns",
    parentHref: "/admin/email-campaigns",
    group: "Messaging" as const,
  },
  {
    // The ops-observer page message link (docs/policy/sre-ops.md §3 rule 1).
    // Its path is fixed by scripts/ops-observer/content-guard-core.mjs, so it
    // lives under /admin/agents rather than beside its parent entry.
    id: "sre-ops-item",
    pattern: /^\/admin\/agents\/sre-ops\/items\/[^/]+$/,
    label: "Ops observer message",
    description: "What one page message was about: its signals, message kinds and times",
    parentLabel: "SRE",
    parentHref: "/admin/sre-ops",
    group: "AI Agents" as const,
  },
  {
    id: "provider-detail",
    pattern: /^\/admin\/providers\/[^/]+$/,
    label: "Provider detail",
    description: "Usage diagnostics, billing, fallback, and recent errors",
    parentLabel: "Providers",
    parentHref: "/admin/providers",
    group: "AI Platform" as const,
  },
] as const;

/**
 * Title, description and breadcrumb for any admin pathname.
 *
 * A route the table does not know about resolves to a neutral "Admin Console"
 * heading rather than falling through to the first navigation entry. The old
 * behaviour titled `/admin/search` -- and any recent route that had since been
 * renamed -- "Overview", which reads as a wrong page rather than an unknown one.
 */
export const resolveAdminPageMeta = (
  pathname: string,
  /**
   * When given, an entry this role may not view resolves as unknown, so the
   * shell does not title a page the role is about to receive a 404 for.
   * Omitted means unfiltered, for callers that are not rendering for a role.
   */
  role?: AdminRole | null,
): AdminPageMeta => {
  const detail = ADMIN_DETAIL_ROUTES.find((route) => route.pattern.test(pathname));
  if (detail && (role === undefined ||
      !("viewRoles" in detail) ||
      detail.viewRoles.some((allowedRole) => allowedRole === role))) {
    return {
      label: detail.label,
      description: detail.description,
      href: pathname,
      group: detail.group,
      parentLabel: detail.parentLabel,
      parentHref: detail.parentHref,
      isKnown: true,
    };
  }

  const unlisted = ADMIN_UNLISTED_PAGES.find((page) =>
    matchesRoute(pathname, page.href)
  );
  if (unlisted) {
    return {
      label: unlisted.label,
      description: unlisted.description,
      href: unlisted.href,
      group: null,
      isKnown: true,
    };
  }

  const item = findAdminNavItem(pathname);
  if (item && (role === undefined || adminIsVisibleTo(role, item))) {
    return {
      label: item.label,
      description: item.description,
      href: item.href,
      group: item.group,
      isKnown: true,
    };
  }

  return {
    label: "Admin Console",
    description: "This route is not part of the console navigation.",
    href: pathname,
    group: null,
    isKnown: false,
  };
};

/**
 * Retired routes and where they now live.
 *
 * Nothing is deleted: every previously reachable `/admin/*` URL still resolves,
 * so deep links, bookmarks, runbooks and the `href`s already written into audit
 * summaries keep working. Each entry names the tab as well as the page, because
 * landing on a consolidated page's first tab would silently drop the operator
 * somewhere other than where the link pointed.
 */
export const ADMIN_LEGACY_ROUTES: Readonly<Record<string, string>> = {
  "/admin/feedback": "/admin/support?tab=feedback",
  "/admin/promotions": "/admin/billing?tab=promotions",
  "/admin/incidents": "/admin/providers?tab=incidents",
  "/admin/fallback-policies": "/admin/providers?tab=incidents",
  "/admin/usage-cost": "/admin/providers?tab=usage-cost",
  "/admin/jobs": "/admin/automation?tab=jobs",
  "/admin/webhooks": "/admin/automation?tab=webhooks",
  "/admin/approvals": "/admin/work-queue",
  // The eight owner-only AMUX screens, gathered under the AMUX group. Policy
  // documents and runbooks name these addresses, so each lands on its own
  // section, except retired JSON intake now opens Ideas. A role the destination
  // refuses is redirected and then answers 404 there, exactly as it did here:
  // the redirect confirms nothing the destination would not. The import,
  // reconciliation, metadata and promotion screens are the Legacy tools of
  // Safety & recovery since 2026-11-07.
  "/admin/amux-intake": "/admin/amux-backlog?tab=ideas",
  "/admin/amux-board-import": "/admin/amux-recovery?tab=legacy",
  "/admin/amux-reconciliation": "/admin/amux-recovery?tab=legacy",
  "/admin/amux-backlog-metadata": "/admin/amux-recovery?tab=legacy",
  "/admin/amux-board-recommendation": "/admin/amux-recovery?tab=legacy",
  "/admin/amux-board-promotion": "/admin/amux-recovery?tab=legacy",
  "/admin/amux-board-auto-promotion": "/admin/amux-recovery?tab=legacy",
  "/admin/amux-cards": "/admin/amux-execution?tab=cards",
  // Pages the 2026-11-07 redesign retired. The Promotion page is the Legacy
  // tools tab; QA and release is the Release page (its own `?tab=` values are
  // ADMIN_QA_RELEASE_LEGACY_TABS).
  "/admin/amux-promotion": "/admin/amux-recovery?tab=legacy",
  "/admin/qa-release": "/admin/release?tab=qa",
};

/**
 * Where `/admin?tab=<value>` used to land, expressed against the new IA.
 *
 * Kept separate from `ADMIN_LEGACY_ROUTES` because the keys are query values
 * rather than paths, and several of them (`platform`, `audit`) still map to a
 * page that did not move.
 */
export const ADMIN_LEGACY_TAB_ROUTES: Readonly<Record<string, string>> = {
  overview: "/admin/overview",
  "work-queue": "/admin/work-queue",
  search: "/admin/search",
  platform: "/admin/platform",
  users: "/admin/users",
  billing: "/admin/billing",
  refunds: "/admin/refunds",
  providers: "/admin/providers",
  models: "/admin/models",
  analytics: "/admin/analytics",
  infrastructure: "/admin/infrastructure",
  alerts: "/admin/alerts",
  retention: "/admin/retention",
  audit: "/admin/audit",
  support: "/admin/support",
  "credit-ledger": "/admin/credit-ledger",
  "admin-access": "/admin/admin-access",
  automation: "/admin/automation",
  ...ADMIN_LEGACY_ROUTES,
  // The `?tab=` values that named a now-merged workspace.
  feedback: ADMIN_LEGACY_ROUTES["/admin/feedback"],
  promotions: ADMIN_LEGACY_ROUTES["/admin/promotions"],
  incidents: ADMIN_LEGACY_ROUTES["/admin/incidents"],
  "fallback-policies": ADMIN_LEGACY_ROUTES["/admin/fallback-policies"],
  "usage-cost": ADMIN_LEGACY_ROUTES["/admin/usage-cost"],
  jobs: ADMIN_LEGACY_ROUTES["/admin/jobs"],
  webhooks: ADMIN_LEGACY_ROUTES["/admin/webhooks"],
  approvals: ADMIN_LEGACY_ROUTES["/admin/approvals"],
};

type QueryValue = string | string[] | undefined;

/**
 * Merges a legacy request's own query string onto its new destination.
 *
 * `/admin/feedback?status=open` has to arrive at
 * `/admin/support?tab=feedback&status=open`: dropping `status` would turn a
 * working bookmark into a page that opens on the wrong filter, which is the
 * failure a redirect is supposed to prevent.
 *
 * The source's own `tab` is always dropped: on `/admin?tab=refunds` it named
 * the *old* workspace and has already been consumed by the lookup, so copying
 * it forward would land on `/admin/refunds?tab=refunds` -- a query the refunds
 * page does not use and a URL no operator would have typed.
 */
export const adminRedirectTarget = (
  destination: string,
  query: Record<string, QueryValue> = {}
): string => {
  const [path, destinationQuery = ""] = destination.split("?");
  const params = new URLSearchParams(destinationQuery);
  for (const [key, value] of Object.entries(query)) {
    if (key === "tab") continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first !== "string" || first.length === 0) continue;
    params.set(key, first);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
};

/**
 * Product research left the engineering agent's screen for its own workspace
 * (2026-10-19). The old tab link opens the section it showed in production,
 * the observation record. The pull request record is a view of Runs & PRs
 * since 2026-11-07.
 */
export const ADMIN_ENGINEERING_AGENT_LEGACY_TABS: Readonly<Record<string, string>> = {
  "product-research": "/admin/product-research?tab=observations",
  "pull-requests": "/admin/engineering-agent?tab=runs&view=pull-requests",
};

/**
 * Agent digests is no longer a menu (2026-11-07). QA and release, and CI
 * admission, are the Release page; the billing and finance digest is its own
 * agent page. Operator emails, commit statuses and the agent office link these
 * addresses with their `?tab=`. A bare `/admin/agent-digests` opens Release,
 * its first tab having been QA; the Trust and safety digest kept the address
 * (`?tab=trust-safety`) and is not redirected.
 */
export const ADMIN_AGENT_DIGESTS_LEGACY_TABS: Readonly<Record<string, string>> = {
  "qa-release": "/admin/release?tab=qa",
  "ci-admission": "/admin/release?tab=ci",
  "billing-finance-ops": "/admin/finance-agent",
};

/** Where a bare or unknown `/admin/agent-digests` request lands. */
export const ADMIN_AGENT_DIGESTS_DEFAULT_ROUTE = "/admin/release";

/**
 * `/admin/qa-release`'s four sections, now two tabs of Release with the first
 * tab's three views (`?view=`). The merge lane's and the train's links are in
 * emails, commit statuses and audit summaries.
 */
export const ADMIN_QA_RELEASE_LEGACY_TABS: Readonly<Record<string, string>> = {
  overview: "/admin/release?tab=qa",
  train: "/admin/release?tab=qa&view=train",
  lane: "/admin/release?tab=qa&view=lane",
  "ci-admission": "/admin/release?tab=ci",
};

/**
 * Backlog sections that moved to Safety & recovery (2026-11-07). `intake` is
 * older: the retired JSON intake screen, which opens Ideas.
 */
export const ADMIN_AMUX_BACKLOG_LEGACY_TABS: Readonly<Record<string, string>> = {
  intake: "/admin/amux-backlog?tab=ideas",
  import: "/admin/amux-recovery?tab=legacy",
  reconciliation: "/admin/amux-recovery?tab=legacy",
  metadata: "/admin/amux-recovery?tab=legacy",
  recovery: "/admin/amux-recovery?tab=reservations",
};

/** Execution safety left Operations settings for Safety & recovery. */
export const ADMIN_AMUX_SETTINGS_LEGACY_TABS: Readonly<Record<string, string>> = {
  safety: "/admin/amux-recovery?tab=safety",
};

/** The audit chain check is part of the Audit log. */
export const ADMIN_ADMIN_ACCESS_LEGACY_TABS: Readonly<Record<string, string>> = {
  integrity: "/admin/audit?tab=integrity",
};

/**
 * Marketing sections that have no tab of their own in the redesign. Each stays
 * reachable, built as it is, as a view of the tab it belongs to until the
 * Marketing screen is rebuilt: competitors and experiments with the reports,
 * assets and the comment alerts with the approvals.
 */
export const ADMIN_MARKETING_LEGACY_TABS: Readonly<Record<string, string>> = {
  competitors: "/admin/marketing?tab=reports&view=competitors",
  experiments: "/admin/marketing?tab=reports&view=experiments",
  assets: "/admin/marketing?tab=queue&view=assets",
  comments: "/admin/marketing?tab=queue&view=comments",
};

/**
 * The old section links remain bookmarks, never a second control surface.
 * `assignment` is the review queue under its new name; `halts` moved with
 * execution safety to Safety & recovery.
 */
export const ADMIN_AMUX_EXECUTION_LEGACY_TABS: Readonly<Record<string, string>> = {
  assignment: "/admin/amux-execution?tab=review",
  halts: "/admin/amux-recovery?tab=safety",
  "decision-maker": "/admin/amux-settings?tab=decision-maker",
  workers: "/admin/amux-settings?tab=workers",
};


/**
 * The tab a page should open on.
 *
 * Unknown and missing values both fall back to the first declared tab, so a
 * hand-edited or stale `?tab=` never renders an empty page.
 */
export const resolveAdminTab = <T extends AdminNavTab>(
  tabs: readonly T[],
  requested: QueryValue
): T => {
  const value = Array.isArray(requested) ? requested[0] : requested;
  return tabs.find((tab) => tab.id === value) || tabs[0];
};

/**
 * The view a tab opens on, for a tab that holds more than one existing screen
 * until its own is built (`?tab=reports&view=competitors`). Unknown and
 * missing values open the first view, as an unknown tab opens the first tab.
 */
export const resolveAdminView = <T extends string>(
  views: readonly T[],
  requested: QueryValue
): T => {
  const value = Array.isArray(requested) ? requested[0] : requested;
  return views.find((view) => view === value) || views[0];
};

export const adminNavItemTabs = (id: string): readonly AdminNavTab[] => {
  const item = ADMIN_NAVIGATION.find((entry) => entry.id === id);
  if (!item?.tabs) {
    throw new Error(`Admin navigation entry "${id}" declares no tabs.`);
  }
  return item.tabs;
};

export const adminItemIsWritable = (
  role: AdminRole,
  item: Pick<AdminNavItem, "writeRoles">
) => !item.writeRoles || item.writeRoles.includes(role);

/**
 * Whether the console may show an entry or a section to a role.
 *
 * `null` -- a role the caller could not determine -- sees only what every role
 * sees. Failing closed here costs a restricted entry its listing; failing open
 * would advertise a page that answers 404.
 */
export const adminIsVisibleTo = (
  role: AdminRole | null | undefined,
  entry: { viewRoles?: readonly AdminRole[] }
) => !entry.viewRoles || (role != null && entry.viewRoles.includes(role));

/** The sections of a page a role may be shown, in declared order. */
export const adminVisibleTabs = <T extends AdminNavTab>(
  tabs: readonly T[],
  role: AdminRole | null | undefined
): T[] => tabs.filter((tab) => adminIsVisibleTo(role, tab));

/**
 * The route table as one role sees it: entries it may open, each carrying only
 * the sections it may open. An entry whose every section is hidden is dropped
 * with them, rather than listed as a page with nothing on it.
 */
export const adminNavigationFor = (
  role: AdminRole | null | undefined
): AdminNavItem[] =>
  ADMIN_NAVIGATION.flatMap((item) => {
    if (!adminIsVisibleTo(role, item)) return [];
    if (!item.tabs) return [item];
    const tabs = adminVisibleTabs(item.tabs, role);
    return tabs.length === 0 ? [] : [{ ...item, tabs }];
  });

/** `ADMIN_NAV_ITEMS_BY_GROUP` for one role; a group left empty is dropped. */
export const adminNavItemsByGroupFor = (
  role: AdminRole | null | undefined
): Array<{ label: AdminNavGroup; items: AdminNavItem[] }> => {
  const items = adminNavigationFor(role);
  return ADMIN_NAV_GROUPS.map((label) => ({
    label,
    items: items.filter((item) => item.group === label),
  })).filter((group) => group.items.length > 0);
};

/**
 * Whether a stored href -- a pin or a recent route -- may be shown to a role.
 *
 * An href outside the route table is left to the caller's own rule (pins drop
 * unknown hrefs, recents drop unknown titles). A `?tab=` naming a section the
 * role may not open hides the link as well, so a shared browser does not hand
 * the owner's recent `/admin/amux-execution?tab=cards` to another role.
 */
export const adminHrefIsVisibleTo = (
  role: AdminRole | null | undefined,
  href: string
): boolean => {
  const [path, search = ""] = href.split("?");
  const item = findAdminNavItem(path);
  if (!item) return true;
  if (!adminIsVisibleTo(role, item)) return false;
  // An entry with sections but none this role may open is not listed either.
  if (item.tabs && adminVisibleTabs(item.tabs, role).length === 0) return false;
  const tabId = new URLSearchParams(search).get("tab");
  const tab = tabId ? item.tabs?.find((entry) => entry.id === tabId) : undefined;
  return !tab || adminIsVisibleTo(role, tab);
};

/**
 * The section a page opens on for a role, or `null` when the request named a
 * section that exists but is not this role's to open.
 *
 * `null` is the page's cue to answer 404: silently swapping in another section
 * would tell the requester the one they asked for exists and is withheld,
 * while falling back is still right for a stale or misspelt `?tab=` that names
 * no section at all. Missing and unknown values open the first section the
 * role may see, which is how a page can default to different sections for
 * different roles without a second rule.
 */
export const resolveAdminTabFor = <T extends AdminNavTab>(
  tabs: readonly T[],
  role: AdminRole | null | undefined,
  requested: QueryValue
): { tab: T; visible: T[] } | null => {
  const visible = adminVisibleTabs(tabs, role);
  if (visible.length === 0) return null;
  const value = Array.isArray(requested) ? requested[0] : requested;
  const named = tabs.find((tab) => tab.id === value);
  if (named && !visible.includes(named)) return null;
  return { tab: resolveAdminTab(visible, value), visible };
};

/**
 * Every page the command palette can jump to, listed and unlisted alike.
 *
 * Every role's pages. The palette lists `adminSearchablePagesFor(role)`; this
 * full list is what a stored pin is checked against for still existing.
 */
export const ADMIN_SEARCHABLE_PAGES = [
  ...ADMIN_NAVIGATION.map((item) => ({
    id: item.id,
    label: item.label,
    href: item.href,
    description: item.description,
    group: item.group as AdminNavGroup | null,
    aliases: item.aliases,
    viewRoles: item.viewRoles as readonly AdminRole[] | undefined,
  })),
  ...ADMIN_UNLISTED_PAGES.map((page) => ({
    id: page.id,
    label: page.label,
    href: "openHref" in page ? page.openHref : page.href,
    description: page.description,
    group: null as AdminNavGroup | null,
    aliases: page.aliases,
    viewRoles: undefined as readonly AdminRole[] | undefined,
  })),
];

export type AdminSearchablePage = (typeof ADMIN_SEARCHABLE_PAGES)[number];

/**
 * The pages one role's palette may offer: exactly the entries its sidebar
 * lists (`adminNavigationFor`), plus the unlisted pages it may open.
 */
export const adminSearchablePagesFor = (
  role: AdminRole | null | undefined
): AdminSearchablePage[] => {
  const listed = new Set(adminNavigationFor(role).map((item) => item.href));
  return ADMIN_SEARCHABLE_PAGES.filter((page) =>
    page.group === null ? adminIsVisibleTo(role, page) : listed.has(page.href)
  );
};

/**
 * Matches a page on its label, description, group and aliases.
 *
 * Aliases carry the words an operator actually types -- "coupon", "outage",
 * "cron" -- none of which appear in any label. Without them the palette only
 * finds a page when the operator already knows what it is called, which is the
 * case where they least need it.
 */
export const matchAdminPages = (
  query: string,
  pages: readonly AdminSearchablePage[] = ADMIN_SEARCHABLE_PAGES
): AdminSearchablePage[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return pages.filter((page) =>
    [page.label, page.description, page.group || "", ...page.aliases]
      .join(" ")
      .toLowerCase()
      .includes(normalized)
  );
};
