/**
 * The Agent office's teams and staff, without any copy.
 *
 * Names, roles and lines live in `lib/adminMessages/agentOffice.ts` under the
 * same ids, because the console speaks English and Korean
 * (docs/ui-contracts/admin-console-ia.md, "Language"). This file holds only
 * what is the same in both: ids, the room order, colours, ranks and the
 * record screen each team already has.
 *
 * The office is a shell. Nothing here reads an agent's state. The record
 * links point at routes in the console's route table, and a link is kept only
 * while that route -- and its `?tab=` section -- is there: a branch that does
 * not carry a team's screen yet (`main`, before a release brings it) draws
 * the team as waiting on a link rather than linking to a page that 404s.
 */

import { ADMIN_NAVIGATION } from "@/lib/adminNavigation";

/**
 * Room order. The eight teams fill the two rows of team rooms in this order; the
 * digest desk sits in the top row beside the operator's office.
 */
export const AGENT_OFFICE_DEPT_IDS = [
  "engineering",
  "qa",
  "sre",
  "support",
  "marketing",
  "finance",
  "trust",
  "research",
  "digest",
] as const;

export type AgentOfficeDeptId = (typeof AGENT_OFFICE_DEPT_IDS)[number];

/** The eight agent teams. The digest desk is where their digests are read, not a team. */
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

/** Whether the console has the page, and the `?tab=` section, a record link names. */
export function consoleHasRecord(href: string): boolean {
  const [path, query] = href.split("?");
  const item = ADMIN_NAVIGATION.find((entry) => entry.href === path);
  if (!item) return false;
  const tab = new URLSearchParams(query ?? "").get("tab");
  return tab === null || (item.tabs ?? []).some((entry) => entry.id === tab);
}

const linkIfOnConsole = (href: string | null) => (href !== null && consoleHasRecord(href) ? href : null);

/** Each team's record screen as declared; see AGENT_OFFICE_DEPTS for what is linked. */
const DECLARED_DEPTS: readonly AgentOfficeDeptMeta[] = [
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
  { id: "sre", icon: "📟", policy: "docs/policy/sre-ops.md", recordHref: "/admin/sre-ops" },
  { id: "support", icon: "🎧", policy: "docs/policy/support-triage.md", recordHref: null },
  {
    id: "marketing",
    icon: "📣",
    policy: "docs/policy/marketing-automation.md",
    recordHref: "/admin/marketing",
  },
  {
    id: "finance",
    icon: "🧾",
    policy: "docs/policy/billing-finance-ops.md",
    recordHref: "/admin/agent-digests?tab=billing-finance-ops",
  },
  // Its policy is not on develop yet, so there is no path to name.
  { id: "trust", icon: "🛡️", policy: null, recordHref: null },
  {
    id: "research",
    icon: "🔭",
    policy: "docs/policy/product-research-agent.md",
    recordHref: "/admin/engineering-agent?tab=product-research",
  },
  { id: "digest", icon: "📋", policy: null, recordHref: "/admin/agent-digests" },
];

/** Each team's declared record link, before the route table is consulted. */
export const AGENT_OFFICE_DECLARED_RECORD_HREFS: Readonly<Record<string, string | null>> = Object.fromEntries(
  DECLARED_DEPTS.map((dept) => [dept.id, dept.recordHref])
);

export const AGENT_OFFICE_DEPTS: readonly AgentOfficeDeptMeta[] = DECLARED_DEPTS.map((dept) => ({
  ...dept,
  recordHref: linkIfOnConsole(dept.recordHref),
}));

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
  /** [hair, shirt, accent] -- soft blues, slate, mint and amber, not the original's pink. */
  colors: readonly [string, string, string];
};

export const AGENT_OFFICE_STAFF: readonly AgentOfficeStaffMeta[] = [
  { id: "engineering-lead", dept: "engineering", rank: "lead", colors: ["#2c2638", "#93c5fd", "#93c5fd"] },
  { id: "engineering-m1", dept: "engineering", rank: "member", colors: ["#4a3a2a", "#fde68a", "#b8f0dd"] },
  { id: "engineering-m2", dept: "engineering", rank: "member", colors: ["#7a3f58", "#bae6fd", "#93c5fd"] },

  { id: "qa-lead", dept: "qa", rank: "lead", colors: ["#2d4b46", "#b8f0dd", "#b8f0dd"] },
  { id: "qa-m1", dept: "qa", rank: "member", colors: ["#463227", "#e4e4e7", "#b8f0dd"] },
  { id: "qa-m2", dept: "qa", rank: "member", colors: ["#6c3a55", "#bae6fd", "#fde68a"] },

  { id: "sre-lead", dept: "sre", rank: "lead", colors: ["#3b3b49", "#b8f0dd", "#b8f0dd"] },
  { id: "sre-m1", dept: "sre", rank: "member", colors: ["#573049", "#fde68a", "#93c5fd"] },
  { id: "sre-m2", dept: "sre", rank: "member", colors: ["#2e3a4a", "#e4e4e7", "#b8f0dd"] },

  { id: "support-lead", dept: "support", rank: "lead", colors: ["#563a32", "#b8f0dd", "#b8f0dd"] },
  { id: "support-m1", dept: "support", rank: "member", colors: ["#452d3f", "#bae6fd", "#fde68a"] },
  { id: "support-m2", dept: "support", rank: "member", colors: ["#8a4a3c", "#b8f0dd", "#93c5fd"] },

  { id: "marketing-lead", dept: "marketing", rank: "lead", colors: ["#c26e4b", "#93c5fd", "#fde68a"] },
  { id: "marketing-m1", dept: "marketing", rank: "member", colors: ["#7b4a2f", "#b8f0dd", "#93c5fd"] },
  { id: "marketing-m2", dept: "marketing", rank: "member", colors: ["#2c2638", "#fde68a", "#bae6fd"] },

  { id: "finance-lead", dept: "finance", rank: "lead", colors: ["#313b56", "#fde68a", "#fde68a"] },
  { id: "finance-m1", dept: "finance", rank: "member", colors: ["#4b3b2c", "#b8f0dd", "#bae6fd"] },
  { id: "finance-m2", dept: "finance", rank: "member", colors: ["#3c3a4f", "#e4e4e7", "#bae6fd"] },

  { id: "trust-lead", dept: "trust", rank: "lead", colors: ["#2d4b46", "#cbd5e1", "#bae6fd"] },
  { id: "trust-m1", dept: "trust", rank: "member", colors: ["#6b4a2f", "#b8f0dd", "#fde68a"] },
  { id: "trust-m2", dept: "trust", rank: "member", colors: ["#452d3f", "#fde68a", "#b8f0dd"] },

  { id: "research-lead", dept: "research", rank: "lead", colors: ["#6b3d34", "#fde68a", "#93c5fd"] },
  { id: "research-m1", dept: "research", rank: "member", colors: ["#2f2a3d", "#bae6fd", "#b8f0dd"] },
  { id: "research-m2", dept: "research", rank: "member", colors: ["#5a3450", "#fde68a", "#93c5fd"] },

  { id: "digest-lead", dept: "digest", rank: "lead", colors: ["#7a453c", "#bae6fd", "#bae6fd"] },
  { id: "digest-m1", dept: "digest", rank: "member", colors: ["#334a3a", "#e4e4e7", "#fde68a"] },
];

/** The operator: the one person in the office, at the desk in the operator's room. */
export const AGENT_OFFICE_OPERATOR = {
  id: "operator",
  hair: "#27272a",
  shirt: "#2563eb",
  accent: "#fde68a",
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
  ["trust", ["신뢰", "안전", "trust", "safety", "컴플라이언스", "compliance", "dsr", "개인정보 요청"]],
  ["digest", ["다이제스트", "digest", "비서"]],
];

/** The AMUX execution room's record screen, while the console has it. */
export const AGENT_OFFICE_AMUX_RECORD_HREF = linkIfOnConsole("/admin/amux-execution");

/**
 * Clothes for the AMUX workers, by desk: the office's palette, not the
 * original's pink. [hair, shirt, accent].
 */
export const AGENT_OFFICE_WORKER_COLORS: readonly (readonly [string, string, string])[] = [
  ["#2c2638", "#bae6fd", "#93c5fd"],
  ["#463227", "#b8f0dd", "#b8f0dd"],
  ["#313b56", "#fde68a", "#fde68a"],
  ["#2d4b46", "#e4e4e7", "#bae6fd"],
  ["#4a3a2a", "#93c5fd", "#b8f0dd"],
  ["#334a3a", "#cbd5e1", "#fde68a"],
  ["#3b3b49", "#b8f0dd", "#93c5fd"],
  ["#2f2a3d", "#fde68a", "#bae6fd"],
];

/** Skin tones for the AMUX workers, by desk. */
export const AGENT_OFFICE_WORKER_SKINS: readonly string[] = ["#ffdcc4", "#f7cdae", "#ffe3cf", "#eec39f"];
