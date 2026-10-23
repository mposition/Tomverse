import { readAmuxOperatingScopeReply, type AmuxOperatingScope } from "./ideaOperatingScopeCore.ts";

/**
 * The Admin idea input, while session intake is on, offers the operating
 * scope's allowed repositories instead of a free-text list: a session idea
 * must name at least one repository and each must be inside that scope, so the
 * choice can only be made from it. Pure helpers; the panel only reads the
 * existing operating-scope GET.
 */
export type ScopeRepositoryRead =
  | { kind: "loading" }
  | { kind: "ready"; repositories: string[]; model?: AmuxOperatingScope["model"] }
  | { kind: "none" }
  | { kind: "error"; reauth: boolean };

export type ScopeRepositoryBlock = "loading" | "none" | "unavailable" | "empty";

/** One GET answer of the operating scope. Anything that is not the exact reply is an error. */
export function classifyScopeRepositoryRead(status: number, body: unknown): ScopeRepositoryRead {
  const reply = status >= 200 && status < 300 ? readAmuxOperatingScopeReply(body) : null;
  if (!reply) return { kind: "error", reauth: status === 428 };
  return reply.state === "none" ? { kind: "none" }
    : { kind: "ready", repositories: reply.scope.repositories, model: reply.scope.model };
}

/** Everything is selected by default: the picked list is the scope minus what the operator unchecked. */
export function pickedScopeRepositories(read: ScopeRepositoryRead, deselected: readonly string[]): string[] {
  return read.kind === "ready" ? read.repositories.filter((repository) => !deselected.includes(repository)) : [];
}

/** Why saving is closed, or null when at least one allowed repository is picked. */
export function scopeRepositoryBlock(read: ScopeRepositoryRead, picked: readonly string[]): ScopeRepositoryBlock | null {
  if (read.kind === "loading") return "loading";
  if (read.kind === "none") return "none";
  if (read.kind === "error") return "unavailable";
  return picked.length === 0 ? "empty" : null;
}

export function toggleScopeRepository(deselected: readonly string[], repository: string, checked: boolean): string[] {
  const rest = deselected.filter((entry) => entry !== repository);
  return checked ? rest : [...rest, repository];
}
