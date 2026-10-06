/**
 * The Agent office's teams and staff, without any copy.
 *
 * Names, roles and lines live in `lib/adminMessages/agentOffice.ts` under the
 * same ids, because the console speaks English and Korean
 * (docs/ui-contracts/admin-console-ia.md, "Language"). This file holds only
 * what is the same in both: ids, the room order, colours, ranks and the
 * record screen each team already has.
 *
 * The office is a shell. Nothing here reads an agent's state; the record
 * links are the only facts on the screen, and they point at routes that
 * exist in the route table today.
 */

/** Room order: four columns, two rows. Seven teams and the digest desk. */
export const AGENT_OFFICE_DEPT_IDS = [
  "engineering",
  "qa",
  "sre",
  "support",
  "marketing",
  "finance",
  "research",
  "digest",
] as const;

export type AgentOfficeDeptId = (typeof AGENT_OFFICE_DEPT_IDS)[number];

/** The seven agent teams. The digest desk is where their digests are read, not a team. */
export const AGENT_OFFICE_TEAM_IDS = AGENT_OFFICE_DEPT_IDS.filter(
  (id): id is Exclude<AgentOfficeDeptId, "digest"> => id !== "digest"
);

export type AgentOfficeDeptMeta = {
  id: AgentOfficeDeptId;
  icon: string;
  /** The policy that governs the team, as it is named in the repository. */
  policy: string | null;
  /**
   * The admin screen that holds this team's record today, or null when there
   * is none yet. A team without one is drawn as waiting on a link: the office
   * has nothing of its to connect to, and it says so instead of pretending.
   */
  recordHref: string | null;
};

export const AGENT_OFFICE_DEPTS: readonly AgentOfficeDeptMeta[] = [
  {
    id: "engineering",
    icon: "🛠️",
    policy: "docs/policy/engineering-agent.md",
    recordHref: "/admin/engineering-agent",
  },
  {
    id: "qa",
    icon: "🧪",
    policy: "docs/policy/qa-release-agent.md",
    recordHref: "/admin/agent-digests?tab=qa-release",
  },
  { id: "sre", icon: "📟", policy: "docs/policy/sre-ops.md", recordHref: null },
  { id: "support", icon: "🎧", policy: "docs/policy/support-triage.md", recordHref: null },
  {
    id: "marketing",
    icon: "📣",
    policy: "docs/policy/marketing-automation.md",
    recordHref: "/admin/marketing",
  },
  { id: "finance", icon: "🧾", policy: "docs/policy/billing-finance-ops.md", recordHref: null },
  {
    id: "research",
    icon: "🔭",
    policy: "docs/policy/product-research-agent.md",
    recordHref: "/admin/engineering-agent?tab=product-research",
  },
  { id: "digest", icon: "📋", policy: null, recordHref: "/admin/agent-digests" },
];

/** Teams with no record screen sit out the demo day as "waiting on a link". */
export const AGENT_OFFICE_BLOCKED_DEPTS: ReadonlySet<string> = new Set(
  AGENT_OFFICE_DEPTS.filter((dept) => dept.recordHref === null).map((dept) => dept.id)
);

export const agentOfficeDept = (id: string) =>
  AGENT_OFFICE_DEPTS.find((dept) => dept.id === id) ?? null;

export type AgentOfficeRank = "lead" | "member" | "operator";

export type AgentOfficeStaffMeta = {
  /** Key into the catalog's `staff` record, and the agent's id in the engine. */
  id: string;
  dept: AgentOfficeDeptId;
  rank: Exclude<AgentOfficeRank, "operator">;
  /** [hair, shirt, accent] -- the original office's pastel set. */
  colors: readonly [string, string, string];
};

export const AGENT_OFFICE_STAFF: readonly AgentOfficeStaffMeta[] = [
  { id: "engineering-lead", dept: "engineering", rank: "lead", colors: ["#2c2638", "#ff8fc0", "#ff8fc0"] },
  { id: "engineering-m1", dept: "engineering", rank: "member", colors: ["#4a3a2a", "#fff3b0", "#b8f0dd"] },
  { id: "engineering-m2", dept: "engineering", rank: "member", colors: ["#7a3f58", "#c9b8ff", "#ff8fc0"] },

  { id: "qa-lead", dept: "qa", rank: "lead", colors: ["#2d4b46", "#b8f0dd", "#b8f0dd"] },
  { id: "qa-m1", dept: "qa", rank: "member", colors: ["#463227", "#ffe6f2", "#b8f0dd"] },
  { id: "qa-m2", dept: "qa", rank: "member", colors: ["#6c3a55", "#c9b8ff", "#fff3b0"] },

  { id: "sre-lead", dept: "sre", rank: "lead", colors: ["#3b3b49", "#b8f0dd", "#b8f0dd"] },
  { id: "sre-m1", dept: "sre", rank: "member", colors: ["#573049", "#fff3b0", "#ff8fc0"] },
  { id: "sre-m2", dept: "sre", rank: "member", colors: ["#2e3a4a", "#ffe6f2", "#b8f0dd"] },

  { id: "support-lead", dept: "support", rank: "lead", colors: ["#563a32", "#b8f0dd", "#b8f0dd"] },
  { id: "support-m1", dept: "support", rank: "member", colors: ["#452d3f", "#c9b8ff", "#fff3b0"] },
  { id: "support-m2", dept: "support", rank: "member", colors: ["#8a4a3c", "#b8f0dd", "#ff8fc0"] },

  { id: "marketing-lead", dept: "marketing", rank: "lead", colors: ["#c26e4b", "#ff8fc0", "#fff3b0"] },
  { id: "marketing-m1", dept: "marketing", rank: "member", colors: ["#7b4a2f", "#b8f0dd", "#ff8fc0"] },
  { id: "marketing-m2", dept: "marketing", rank: "member", colors: ["#2c2638", "#fff3b0", "#c9b8ff"] },

  { id: "finance-lead", dept: "finance", rank: "lead", colors: ["#313b56", "#fff3b0", "#fff3b0"] },
  { id: "finance-m1", dept: "finance", rank: "member", colors: ["#4b3b2c", "#b8f0dd", "#c9b8ff"] },
  { id: "finance-m2", dept: "finance", rank: "member", colors: ["#3c3a4f", "#ffe6f2", "#c9b8ff"] },

  { id: "research-lead", dept: "research", rank: "lead", colors: ["#6b3d34", "#fff3b0", "#ff8fc0"] },
  { id: "research-m1", dept: "research", rank: "member", colors: ["#2f2a3d", "#c9b8ff", "#b8f0dd"] },
  { id: "research-m2", dept: "research", rank: "member", colors: ["#5a3450", "#fff3b0", "#ff8fc0"] },

  { id: "digest-lead", dept: "digest", rank: "lead", colors: ["#7a453c", "#c9b8ff", "#c9b8ff"] },
  { id: "digest-m1", dept: "digest", rank: "member", colors: ["#334a3a", "#ffe6f2", "#fff3b0"] },
];

/** The operator: the one person in the office, at the desk in the operator's room. */
export const AGENT_OFFICE_OPERATOR = {
  id: "operator",
  hair: "#42283a",
  shirt: "#ff8fc0",
  accent: "#fff3b0",
  skin: "#ffdcc4",
} as const;

/** The digest desk's lead answers the operator console, as the original office's secretary did. */
export const AGENT_OFFICE_NARRATOR_ID = "digest-lead";

/**
 * Words that point the operator console at one room, in both console
 * languages, most specific first. Names and callsigns are matched from the
 * catalog as well; these are the team words that are not names.
 */
export const AGENT_OFFICE_DEPT_KEYWORDS: readonly [AgentOfficeDeptId, readonly string[]][] = [
  ["qa", ["qa", "큐에이", "릴리스", "release", "ci 실패", "ci failure", "게이트", "gate"]],
  ["research", ["리서치", "research", "관측", "observation", "이슈 판정"]],
  ["engineering", ["엔지니어링", "engineering", "엔지", "patch", "패치", "t2", "초안 pr", "pull request"]],
  ["sre", ["sre", "운영팀", "모니터링", "monitoring", "dead-man", "heartbeat"]],
  ["support", ["고객지원", "support", "신고", "triage", "답변 초안"]],
  ["marketing", ["마케팅", "marketing", "guard", "게시", "소셜", "social", "seo"]],
  ["finance", ["재무", "과금", "finance", "billing", "가격", "price", "정산", "ledger"]],
  ["digest", ["다이제스트", "digest", "비서"]],
];
