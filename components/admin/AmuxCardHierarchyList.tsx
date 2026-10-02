import type { AmuxAdminCardRow, AmuxAdminHierarchyNode } from "@/lib/amux/adminCardList";
import { projectAmuxAdminHierarchy, type AmuxAdminHierarchyItem } from "@/lib/amux/adminHierarchyCore";
import { adminAmuxCardsMessages } from "@/lib/adminMessages/amuxCards";

type HierarchyMessages = Pick<(typeof adminAmuxCardsMessages)["en"],
  "hierarchyScope" | "hierarchyUnlinked" | "hierarchyOutsideStory" | "hierarchyLevel">;

type Branch = { item: AmuxAdminHierarchyItem; children: Branch[] };

function nest(items: AmuxAdminHierarchyItem[]): Branch[] {
  const roots: Branch[] = [];
  const stack: Branch[] = [];
  for (const item of items) {
    const branch: Branch = { item, children: [] };
    while (stack.length > item.depth) stack.pop();
    if (stack.length === 0) roots.push(branch);
    else stack.at(-1)?.children.push(branch);
    stack.push(branch);
  }
  return roots;
}

function renderBranch(branch: Branch, messages: HierarchyMessages) {
  const { item } = branch;
  return <li key={`${item.kind}:${item.id}`}
    className="rounded border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700">
    <span className="sr-only">{messages.hierarchyLevel(item.depth + 1)}</span>
    <span className="font-medium">
      {item.kind === "outside_page_story" ? messages.hierarchyOutsideStory(item.id) : item.label}
    </span>
    {item.status ? <span className="ms-2 text-zinc-600 dark:text-zinc-400">
      {item.status}
    </span> : null}
    {branch.children.length > 0 ? <ol className="ms-5 mt-1 space-y-1">
      {branch.children.map((child) => renderBranch(child, messages))}
    </ol> : null}
  </li>;
}

export function AmuxCardHierarchyList({ rows, nodes, total, messages }: {
  rows: AmuxAdminCardRow[];
  nodes: AmuxAdminHierarchyNode[];
  total: number;
  messages: HierarchyMessages;
}) {
  const branches = nest(projectAmuxAdminHierarchy(rows, nodes));
  const unlinked = branches.find(({ item }) => item.kind === "unlinked");
  const linked = branches.filter(({ item }) => item.kind !== "unlinked");
  return (
    <div className="space-y-2" data-testid="amux-hierarchy-list">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {messages.hierarchyScope(rows.length, total)}
      </p>
      {linked.length > 0 ? <ol className="space-y-1">
        {linked.map((branch) => renderBranch(branch, messages))}
      </ol> : null}
      {unlinked ? <section aria-labelledby="amux-hierarchy-unlinked-heading">
        <h3 id="amux-hierarchy-unlinked-heading" className="mb-1 font-medium">
          {messages.hierarchyUnlinked}
        </h3>
        <ul className="space-y-1">
          {unlinked.children.map(({ item }) => <li key={item.id}
            className="rounded border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700">
            {item.label}
            {item.status ? <span className="ms-2 text-zinc-600 dark:text-zinc-400">
              {item.status}
            </span> : null}
          </li>)}
        </ul>
      </section> : null}
    </div>
  );
}
