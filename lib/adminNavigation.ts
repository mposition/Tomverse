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
 */

export const ADMIN_NAV_GROUPS = [
  "Command Center",
  "Customers",
  "Revenue",
  "AI Platform",
  "Operations",
  "AMUX",
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
  | "amuxEscalations"
  | "amuxOrchestratorHalts"
  | "amuxExecution";

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
  {
    id: "overview",
    label: "Overview",
    href: "/admin/overview",
    description: "Operational snapshot, attention queue, and recent activity",
    group: "Command Center",
    aliases: [
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
    label: "Work queue",
    href: "/admin/work-queue",
    description: "Everything waiting on an operator, oldest first",
    group: "Command Center",
    badge: "workQueue",
    aliases: ["queue", "todo", "pending", "backlog", "approvals"],
  },
  {
    id: "analytics",
    label: "Analytics",
    href: "/admin/analytics",
    description: "Active users, usage, model share, product funnel, and import/memory metrics",
    group: "Command Center",
    aliases: [
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
        label: "Product analytics",
        description: "Acquisition, activation, and revenue funnel",
      },
      {
        id: "imports",
        label: "Imports & memory",
        description: "External conversation import and memory metrics",
      },
      {
        id: "ai-review",
        label: "AI Review",
        description: "Reliability, adoption, and reviewer-pair evidence",
      },
    ],
  },
  {
    id: "users",
    label: "Users",
    href: "/admin/users",
    description: "Accounts, usage, plans, and account controls",
    group: "Customers",
    writeRoles: ["owner", "support"],
    aliases: ["customers", "accounts", "people", "subscribers", "email"],
  },
  {
    id: "support",
    label: "Support",
    href: "/admin/support",
    description: "Feedback inbox and data-rights request queue",
    group: "Customers",
    writeRoles: ["owner", "support"],
    badge: "support",
    aliases: [
      "feedback",
      "inbox",
      "tickets",
      "cases",
      "privacy",
      "gdpr",
      "data rights",
      "complaints",
    ],
    tabs: [
      {
        id: "feedback",
        label: "Feedback",
        description: "Reports and requests submitted from the product",
      },
      {
        id: "fixes",
        label: "Auto-fix review",
        description: "Problems and fixes found from traces, approval and rollout",
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
    label: "Billing",
    href: "/admin/billing",
    description: "Plans, price catalogue, promotions, and promotion risk",
    group: "Revenue",
    writeRoles: ["owner", "billing"],
    aliases: [
      "plans",
      "prices",
      "stripe",
      "subscriptions",
      "catalogue",
      "promotions",
      "coupon",
      "discount",
      "risk",
    ],
    tabs: [
      {
        id: "plans",
        label: "Plans & prices",
        description: "Plan catalogue, Stripe IDs, and lifecycle counters",
      },
      {
        id: "promotions",
        label: "Promotions & risk",
        description: "Promotion codes and their abuse signals",
      },
    ],
  },
  {
    id: "refunds",
    label: "Refunds",
    href: "/admin/refunds",
    description: "Refund review queue and reviewed requests",
    group: "Revenue",
    writeRoles: ["owner", "billing"],
    badge: "refunds",
    aliases: ["cancellations", "chargeback", "dispute", "money back"],
  },
  {
    id: "credit-ledger",
    label: "Credit ledger",
    href: "/admin/credit-ledger",
    description: "Credit grants, settlements, and outstanding debt",
    group: "Revenue",
    writeRoles: ["owner", "billing"],
    aliases: ["credits", "ledger", "grants", "settlement", "debt"],
  },
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
        label: "Health",
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
    description: "Model registry, availability, and what discovery has found",
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
    ],
  },
  {
    id: "routing",
    label: "Routing",
    href: "/admin/routing",
    description: "Chat shadow routing",
    group: "AI Platform",
    aliases: [
      "auto",
      "router",
      "shadow",
      "task profile",
      "candidates",
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    href: "/admin/infrastructure",
    description: "Railway, R2, database, and Prisma operations",
    group: "Operations",
    writeRoles: ["owner", "ops", "billing"],
    aliases: ["railway", "r2", "database", "prisma", "hosting", "storage"],
  },
  {
    id: "automation",
    label: "Automation",
    href: "/admin/automation",
    description: "Scheduled jobs, webhook delivery, and operations reports",
    group: "Operations",
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
    id: "alerts",
    label: "Alerts",
    href: "/admin/alerts",
    description: "Alert thresholds, templates, and the delivery log",
    group: "Operations",
    writeRoles: ["owner", "ops"],
    badge: "alerts",
    aliases: ["notifications", "slack", "discord", "thresholds", "paging"],
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
    ],
  },
  {
    id: "email-campaigns",
    label: "Email campaigns",
    href: "/admin/email-campaigns",
    description:
      "Campaign drafts, what each one is waiting on, and the waves that are due",
    group: "Operations",
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
    ],
  },
  {
    id: "email-delivery",
    label: "Email delivery",
    href: "/admin/email-delivery",
    description: "What was sent to whom, what was refused, and which addresses are suppressed",
    group: "Operations",
    writeRoles: ["owner", "ops"],
    badge: "abandonedLegalEmail",
    aliases: [
      "outbox",
      "delivery log",
      "bounce",
      "complaint",
      "suppression",
      "abandoned",
      "dead letter",
      "did not arrive",
      "never received",
      "email history",
    ],
    tabs: [
      {
        id: "deliveries",
        label: "Deliveries",
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
    id: "marketing",
    label: "Marketing",
    href: "/admin/marketing",
    description:
      "Draft queue, published posts, brand accounts, and what the automation reported",
    group: "Operations",
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
      "guard",
    ],
    tabs: [
      {
        id: "queue",
        label: "Queue",
        description: "Drafts waiting on a person, and what the Guard said about each",
      },
      {
        id: "published",
        label: "Publish state",
        description:
          "Every approved post: waiting, in flight, published, failed, or unconfirmed",
      },
      {
        id: "accounts",
        label: "Accounts",
        description: "Brand accounts, their mode, and why a paused one is paused",
      },
      {
        id: "experiments",
        label: "Experiments",
        description: "Landing copy experiments and their results",
      },
      {
        id: "reports",
        label: "Reports",
        description: "Weekly summaries, competitor facts, and retention runs",
      },
      {
        id: "comments",
        label: "Comments",
        description: "Comment alerts the monitor raised and nobody has answered",
      },
    ],
  },
  {
    id: "engineering-agent",
    label: "Engineering agent",
    href: "/admin/engineering-agent",
    description:
      "The agents' record: engineering T2 drafts and runs, and the product-research observation slots",
    group: "Operations",
    writeRoles: ["owner", "ops"],
    aliases: [
      "engineering",
      "agent",
      "t2 draft",
      "patch",
      "pull request",
      "publisher",
      "runner",
      "freeze",
      // The product-research section lives on this screen as a tab
      // (docs/policy/product-research-agent.md §4), so the palette has to find
      // it under its own words rather than under the engineering agent's.
      "product research",
      "observation",
      "issue backlog",
      "slot",
    ],
    tabs: [
      {
        id: "queue",
        label: "Owner queue",
        description: "T2 drafts, decisions and state mismatches waiting on a person",
      },
      {
        id: "runs",
        label: "Runs",
        description: "Each run, the mode it started under, how it ended and any halt",
      },
      {
        id: "pull-requests",
        label: "Pull requests",
        description: "What the agent bound: pull request, snapshot, approval and merge observations",
      },
      {
        id: "settings",
        label: "Mode",
        description: "Mode, freeze, the kill switch and the owner queue against its caps",
      },
      {
        id: "product-research",
        label: "Product research",
        description:
          "Observation slots, the newest one's rows, and the staging and production windows",
      },
    ],
  },
  {
    id: "sre-ops",
    label: "SRE agent",
    href: "/admin/sre-ops",
    description: "The ops observer's state chain, its trust verdict and the owner's genesis",
    group: "Operations",
    writeRoles: ["owner"],
    aliases: ["sre", "ops observer", "genesis", "trust", "state chain", "pager"],
  },
  {
    id: "agent-digests",
    label: "Agent digests",
    href: "/admin/agent-digests",
    description: "What each agent reported each day, and the operator control it runs under",
    group: "Operations",
    writeRoles: ["owner", "ops"],
    aliases: ["digest", "qa", "release", "release readiness", "merge lane", "control revision", "price deadline", "billing-finance-ops"],
    tabs: [
      {
        id: "qa-release",
        label: "QA and release",
        description: "The daily release-readiness digest and the operator control revision",
      },
      {
        id: "billing-finance-ops",
        label: "Billing and finance",
        description: "The daily pending-price deadline digest, the agent switch and the monitor check",
      },
    ],
  },
  {
    // A shell: a pixel office for the eight agent teams that plays a demo day
    // and links each team to the page that holds its record. A LIVE room reads
    // that team's operating state, read only; nothing on the page writes, so
    // it carries no badge and no writeRoles.
    id: "office",
    label: "Agent office",
    href: "/admin/office",
    // The office floor scales to the space it is given.
    wide: true,
    description: "A pixel office shell for the eight agent teams, with a link to each team's record",
    group: "Operations",
    aliases: ["office", "agent teams", "pixel office", "live office", "team board"],
    // The office draws its own tab strip, as the original UI did; its tabs are
    // links to these sections, and one demo engine runs under both.
    tabs: [
      {
        id: "live",
        label: "Live office",
        description: "The office floor, the operator console and the demo approval",
      },
      {
        id: "dashboard",
        label: "Dashboard",
        description: "Team board, demo approval, digest brief and each team's record link",
      },
    ],
  },
  {
    id: "platform",
    label: "Platform settings",
    href: "/admin/platform",
    description: "Product defaults and emergency feature controls",
    group: "Operations",
    writeRoles: ["owner", "ops"],
    aliases: [
      "settings",
      "defaults",
      "feature flags",
      "kill switch",
      "guest default",
    ],
  },
  // AMUX: the development-agent work board (docs/policy/development-agent-orchestration.md).
  // Backlog and Promotion are owner-only -- the pages and every API route
  // behind them answer 404 to any other role -- so they are shown to the owner
  // alone. Execution opens to every admin because its Assignment section does;
  // its Cards section is owner-only like the page it replaced.
  {
    id: "amux-backlog",
    label: "Backlog",
    href: "/admin/amux-backlog",
    description:
      "Idea input, card registration, catalog import, source reconciliation and card metadata",
    group: "AMUX",
    writeRoles: ["owner"],
    viewRoles: ["owner"],
    aliases: [
      "amux",
      "intake",
      "idea analysis",
      "new idea",
      "register card",
      "catalog import",
      "board import",
      "reconciliation",
      "source revision",
      "metadata",
      "priority",
      "cost estimate",
    ],
    tabs: [
      {
        id: "ideas",
        label: "Ideas",
        description: "Check an operator idea before any external transfer",
      },
      {
        id: "import",
        label: "Catalog import",
        description: "Preview a workboard catalog, approve it, then import it",
      },
      {
        id: "reconciliation",
        label: "Source reconciliation",
        description: "Accept or reject each card's new source revision",
      },
      {
        id: "metadata",
        label: "Card metadata",
        description: "Kind, priority and cost estimate for one backlog card",
      },
    ],
  },
  {
    id: "amux-promotion",
    label: "Promotion",
    href: "/admin/amux-promotion",
    description:
      "Recommendation pool, manual promotion and auto-promotion of backlog cards",
    group: "AMUX",
    writeRoles: ["owner"],
    viewRoles: ["owner"],
    aliases: [
      "amux",
      "recommendation",
      "recommendation pool",
      "promote",
      "promotion",
      "auto-promotion",
      "grant",
      "halt",
      "todo",
    ],
    tabs: [
      {
        id: "recommendation",
        label: "Recommendation pool",
        description: "A backlog snapshot and a person's decision on each card",
      },
      {
        id: "promotion",
        label: "Manual promotion",
        description: "Promote one to three backlog cards a person picked",
      },
      {
        id: "auto-promotion",
        label: "Auto-promotion",
        description: "Grants, halt and resume for limited automatic promotion",
      },
    ],
  },
  {
    id: "amux-execution",
    label: "Execution",
    href: "/admin/amux-execution",
    description: "AMUX cards, their execution state, and why AMUX assigned the work",
    group: "AMUX",
    // Assignment decisions take `ops:write` (every /api/admin/amux/escalations
    // route checks it); the card list writes nothing. Clearing an orchestrator
    // halt takes the owner role and a recent step-up in its own route.
    writeRoles: ["owner", "ops"],
    // Escalations plus open orchestrator halts (orchestration policy
    // version 20, section 7).
    badge: "amuxExecution",
    aliases: [
      "amux",
      "cards",
      "execution",
      "worker",
      "attempt",
      "assignment",
      "escalation",
      "human review",
      "review",
      "incident",
      "orchestrator",
      "halt",
      "outcome unknown",
    ],
    tabs: [
      {
        id: "cards",
        label: "Cards",
        description: "Every AMUX card stored in Tomverse and its execution state",
        viewRoles: ["owner"],
      },
      {
        id: "assignment",
        label: "Assignment",
        description: "Why AMUX assigned the work, and escalations waiting on a person",
        badge: "amuxEscalations",
      },
      {
        id: "halts",
        label: "Halts",
        description: "Orchestrator halts, the writes a person has to confirm, and clearing a halt",
        badge: "amuxOrchestratorHalts",
      },
    ],
  },
  {
    id: "email-policy",
    label: "Email policy",
    href: "/admin/email-policy",
    description: "Jurisdiction profiles for outbound mail, and which version is in force",
    group: "Governance",
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
  {
    id: "audit",
    label: "Audit log",
    href: "/admin/audit",
    description: "Administrator activity, with actor and target",
    group: "Governance",
    aliases: ["log", "history", "activity", "trail", "who changed"],
  },
  {
    id: "retention",
    label: "Retention",
    href: "/admin/retention",
    description: "Retention windows and destructive cleanup",
    group: "Governance",
    writeRoles: ["owner", "ops"],
    aliases: ["cleanup", "purge", "delete", "data lifecycle"],
  },
  {
    id: "admin-access",
    label: "Admin access",
    href: "/admin/admin-access",
    description: "Roles, expiry, operational readiness, and audit integrity",
    group: "Governance",
    writeRoles: ["owner"],
    aliases: [
      "roles",
      "permissions",
      "rbac",
      "administrators",
      "readiness",
      "integrity",
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
      {
        id: "integrity",
        label: "Audit integrity",
        description: "Tamper-evidence for the audit log",
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
    group: "Customers" as const,
  },
  {
    id: "campaign-detail",
    pattern: /^\/admin\/email-campaigns\/[^/]+$/,
    label: "Campaign detail",
    description:
      "The copy this campaign sends, who has attested to what, and whether it may go out",
    parentLabel: "Email campaigns",
    parentHref: "/admin/email-campaigns",
    group: "Operations" as const,
  },
  {
    // The ops-observer page message link (docs/policy/sre-ops.md §3 rule 1).
    // Its path is fixed by scripts/ops-observer/content-guard-core.mjs, so it
    // lives under /admin/agents rather than beside its parent entry.
    id: "sre-ops-item",
    pattern: /^\/admin\/agents\/sre-ops\/items\/[^/]+$/,
    label: "Ops observer message",
    description: "What one page message was about: its signals, message kinds and times",
    parentLabel: "SRE agent",
    parentHref: "/admin/sre-ops",
    group: "Operations" as const,
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
  if (detail) {
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
  // the redirect confirms nothing the destination would not.
  "/admin/amux-intake": "/admin/amux-backlog?tab=ideas",
  "/admin/amux-board-import": "/admin/amux-backlog?tab=import",
  "/admin/amux-reconciliation": "/admin/amux-backlog?tab=reconciliation",
  "/admin/amux-backlog-metadata": "/admin/amux-backlog?tab=metadata",
  "/admin/amux-board-recommendation": "/admin/amux-promotion?tab=recommendation",
  "/admin/amux-board-promotion": "/admin/amux-promotion?tab=promotion",
  "/admin/amux-board-auto-promotion": "/admin/amux-promotion?tab=auto-promotion",
  "/admin/amux-cards": "/admin/amux-execution?tab=cards",
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
    href: page.href,
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
