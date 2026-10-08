import type { Prisma } from "@prisma/client";

export const AMUX_EXECUTION_LANES = [
  "tomverse_backlog", "amux_backlog", "todo", "in_progress",
  "in_review", "attention", "archive",
] as const;
export type AmuxExecutionLane = (typeof AMUX_EXECUTION_LANES)[number];
export const AMUX_EXECUTION_PAGE_SIZE = 8;
export const AMUX_EXECUTION_MAX_PAGE = 10_000;

const hiddenCharacter = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\p{Cf}\p{Cs}]/gu;
const visibleCodePoint = (character: string) => {
  const codePoint = character.codePointAt(0)!;
  return `\\u{${codePoint.toString(16).toUpperCase()}}`;
};

/** Preserve ordinary line breaks for inspection while making hidden characters
 * explicit and unambiguous, including non-BMP format characters. */
export const amuxVisibleInspectionText = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(hiddenCharacter, visibleCodePoint);

/** A read-only rendering of worker text must expose invisible code points;
 * JSON escaping also distinguishes an actual control from a literal `\\u`.
 */
export const amuxVisibleUntrustedText = (value: string) =>
  JSON.stringify(value).replace(hiddenCharacter,
    (character) => {
      const codePoint = character.codePointAt(0)!;
      if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
      const offset = codePoint - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      return `\\u${high.toString(16)}\\u${low.toString(16)}`;
    });

const attention: Prisma.AmuxWorkItemWhereInput = {
  OR: [
    { status: "blocked" },
    { humanEscalations: { some: { status: { in: ["open", "acknowledged"] } } } },
  ],
};

export function amuxExecutionLaneWhere(lane: AmuxExecutionLane): Prisma.AmuxWorkItemWhereInput {
  const active = { archivedAt: null };
  if (lane === "attention") return { AND: [active, attention] };
  const ordinary = { NOT: attention };
  if (lane === "archive") return { OR: [
    { archivedAt: { not: null } },
    { AND: [active, ordinary, { status: { in: ["done", "cancelled"] } }] },
  ] };
  const status: Prisma.AmuxWorkItemWhereInput = lane === "tomverse_backlog"
    ? { status: "backlog" }
    : lane === "amux_backlog"
      ? { status: "todo", v22AssignmentId: null }
      : lane === "todo"
        ? { status: "todo", v22AssignmentId: { not: null } }
        : lane === "in_progress"
          ? { status: "doing" }
          : lane === "in_review"
            ? { status: "review" }
          : { status: "review" };
  return { AND: [active, ordinary, status] };
}

export function parseAmuxExecutionPage(raw: string | null): number | null {
  if (raw === null) return 0;
  if (!/^(0|[1-9][0-9]{0,4})$/.test(raw)) return null;
  const page = Number(raw);
  return page <= AMUX_EXECUTION_MAX_PAGE ? page : null;
}

export function parseAmuxExecutionLane(raw: string | null): AmuxExecutionLane | null {
  return AMUX_EXECUTION_LANES.find((lane) => lane === raw) ?? null;
}

export const AMUX_EXECUTION_VISIBLE_LANES = AMUX_EXECUTION_LANES.filter(
  (lane) => lane !== "archive",
);
