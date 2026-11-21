/**
 * What a CLI stream check does with a kind of event it has not seen (owner
 * direction 2026-11-21). A check stays strict only about what it guards: a
 * tool outside the role's list, a subagent, the permission mode, a missing or
 * malformed result, a line that is not JSON. A new kind is not one of those by
 * itself: on 2026-11-21 an Antigravity run (agy 1.5.4) that had read, run and
 * edited and then exited 0 lost its whole result to one `system_message` step
 * whose only fields were conversation_id, step_index, state, step_type and
 * duration_seconds.
 *
 * So an unseen kind passes, and is counted by name only, when neither its
 * name nor any key it carries (at any depth) names an action -- a tool, a
 * command, a file, a path, a URL, a search, a subagent, an MCP server, a
 * permission or a question to the user (Cursor's `interaction_query`). One
 * that does stays refused, as an unknown tool would be.
 * Values are never read: a model's text cannot make a kind pass or fail.
 */
const ACTION = /tool|subagent|collab|command|shell|exec|patch|change|diff|mcp|browser|web|url|fetch|search|write|edit|file|path|computer|image|task|plugin|skill|permission|interaction|approval|confirm|call|function|interpret|sandbox|spawn|process/i;
const NAME = /^[a-z][a-z0-9_.]{0,47}$/i;

/** True when an unseen kind must be refused: its name is not a short
 * identifier, or its name or one of its keys names an action. */
export function amuxCliUnknownKindActs(name, body) {
  if (typeof name !== "string" || !NAME.test(name) || ACTION.test(name)) return true;
  const stack = [body];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { stack.push(...value); continue; }
    for (const [key, child] of Object.entries(value)) {
      if (ACTION.test(key)) return true;
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return false;
}

/** The unseen kinds a run passed, by name and count: never their text. */
export function createAmuxCliUnknownKindLog() {
  const counts = new Map();
  return {
    note(name) { counts.set(name, (counts.get(name) ?? 0) + 1); },
    snapshot() { return Object.freeze(Object.fromEntries(counts)); },
    size() { return counts.size; },
  };
}

/** The log as one journal field: `a*2,b`, or "" when nothing was unseen. */
export function amuxCliUnknownKindSummary(snapshot) {
  return Object.entries(snapshot ?? {})
    .map(([name, count]) => count > 1 ? `${name}*${count}` : name).join(",");
}
