import { join } from "node:path";
import { resolveEndpoint, sha256, type SessionState } from "../../../tomverse-cli/src/runtime.js";
import type { Connection } from "./messages";
import type { ProjectRoot } from "./project-root";

export type HistoryScope = {
  home: string;
  legacyHome: string;
  root: string;
  base: string;
  origin: string;
  keyIdentity: string;
  keyPrefix: string;
};

export function codeHistoryScope(profile: string, accountId: string | null, project: ProjectRoot, connection: Connection): HistoryScope {
  const endpoint = resolveEndpoint({ endpoint: connection.endpoint, allowInsecureLocalhost: true }, {});
  const keyIdentity = sha256(connection.key);
  const legacy = [accountId ?? "fixture", project.path, connection.endpoint];
  if (accountId === null) legacy.push(connection.key);
  const namespace = sha256(JSON.stringify([accountId, project.path, project.identity, endpoint.base, keyIdentity]));
  return {
    home: join(profile, "code", namespace),
    legacyHome: join(profile, "code", sha256(JSON.stringify(legacy))),
    root: project.path, base: endpoint.base, origin: endpoint.origin,
    keyIdentity, keyPrefix: connection.key.slice(0, 12),
  };
}

export function matchesHistory(journal: Pick<SessionState, "workspace" | "endpointOrigin" | "endpointBase" | "keyPrefix" | "keyIdentity">,
  scope: HistoryScope, storage: string): boolean {
  if (journal.workspace?.root !== scope.root || journal.endpointOrigin !== scope.origin || journal.keyPrefix !== scope.keyPrefix) return false;
  if (storage === scope.home) return journal.endpointBase === scope.base && journal.keyIdentity === scope.keyIdentity;
  if (storage !== scope.legacyHome) return false;
  // The original storage name already binds the full configured endpoint.
  return (journal.endpointBase === undefined || journal.endpointBase === scope.base) &&
    (journal.keyIdentity === undefined || journal.keyIdentity === scope.keyIdentity);
}
