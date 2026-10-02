import type { AmuxAdminCardRow, AmuxAdminHierarchyNode } from "@/lib/amux/adminCardList";
import { projectAmuxAdminHierarchy } from "@/lib/amux/adminHierarchyCore";
import { adminAmuxCardsMessages } from "@/lib/adminMessages/amuxCards";

type HierarchyMessages = Pick<(typeof adminAmuxCardsMessages)["en"],
  "hierarchyScope" | "hierarchyUnlinked" | "hierarchyOutsideStory" | "hierarchyLevel">;

export function AmuxCardHierarchyList({ rows, nodes, total, messages }: {
  rows: AmuxAdminCardRow[];
  nodes: AmuxAdminHierarchyNode[];
  total: number;
  messages: HierarchyMessages;
}) {
  const hierarchy = projectAmuxAdminHierarchy(rows, nodes);
  return (
    <div className="space-y-2" data-testid="amux-hierarchy-list">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {messages.hierarchyScope(rows.length, total)}
      </p>
      <ol className="space-y-1">
        {hierarchy.map((item) => <li key={`${item.kind}:${item.id}`}
          className="rounded border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
          style={{ marginInlineStart: `${item.depth * 1.25}rem` }}>
          <span className="sr-only">{messages.hierarchyLevel(item.depth + 1)}</span>
          <span className="font-medium">
            {item.kind === "unlinked" ? messages.hierarchyUnlinked :
              item.kind === "outside_page_story" ? messages.hierarchyOutsideStory(item.id) :
                item.label}
          </span>
          {item.status ? <span className="ms-2 text-zinc-600 dark:text-zinc-400">
            {item.status}
          </span> : null}
        </li>)}
      </ol>
    </div>
  );
}
