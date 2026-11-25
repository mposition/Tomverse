export type DiffStat = { added: number; removed: number; lines: number };

export function summarizeDiff(diff: string): DiffStat {
  let added = 0;
  let removed = 0;
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed, lines: lines.length };
}

export function visibleDiff(diff: string, cap = 800): { text: string; hidden: number } {
  const lines = diff.split("\n");
  if (cap <= 0) return { text: "", hidden: lines.length };
  if (lines.length <= cap) return { text: diff, hidden: 0 };
  return { text: lines.slice(0, cap).join("\n"), hidden: lines.length - cap };
}
