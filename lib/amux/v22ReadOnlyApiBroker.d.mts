export declare class AmuxV22ReadOnlyApiBrokerError extends Error {
  readonly code: string;
}

export type AmuxV22ReadOnlyApiBroker = Readonly<{
  sourceRevision: string;
  repositoryScopeDigest: string;
  snapshotDigest: string;
  execute(name: "Read" | "Grep" | "Glob", input: unknown): Promise<string>;
}>;

export type AmuxV22ReadOnlyApiSnapshotManifest = Readonly<{
  version: 1;
  sourceRevision: string;
  sourceTreeObjectId: string;
  repositoryScopeDigest: string;
  gitProofDigest: string;
  directories: readonly string[];
  files: readonly Readonly<{
    path: string;
    size: number;
    digest: string;
    objectId: string;
  }>[];
  snapshotDigest: string;
}>;

export declare function createAmuxV22ReadOnlyApiSnapshotManifest(config: {
  repositoryRoot: string;
  sourceRevision: string;
  allowedPrefixes: string[];
}, dependencies?: Record<string, unknown>): Promise<AmuxV22ReadOnlyApiSnapshotManifest>;

export declare function createAmuxV22ReadOnlyApiBroker(config: {
  repositoryRoot: string;
  sourceRevision: string;
  allowedPrefixes: string[];
  repositoryScopeDigest: string;
  brokerPolicyDigest: string;
  toolSchemaDigest: string;
  snapshotManifest: AmuxV22ReadOnlyApiSnapshotManifest;
}, dependencies?: Record<string, unknown>): AmuxV22ReadOnlyApiBroker;
