/**
 * Read-only search choreography for a repository-owned commit witness.
 * The injected adapter must be a trusted, authenticated GitHub collector:
 * observations supplied by a model, browser, or request body are not proof.
 * This module has no network, credentials, database write, or transfer path.
 */
export type AmuxOwnedRefNamespace = "refs/heads/" | "refs/tags/";

export type AmuxListedRef = {
  name: string;
  objectType: "commit" | "tag";
  objectSha: string;
  protected: boolean | null;
};

export type AmuxOwnedRefPage = {
  repositoryId: number;
  refs: readonly AmuxListedRef[];
  hasNextPage: boolean;
  endCursor: string | null;
};

export type AmuxGitTagObservation = {
  repositoryId: number;
  sha: string;
  targetType: "commit" | "tag" | "tree" | "blob";
  targetSha: string;
};

export type AmuxCommitComparison = {
  repositoryId: number;
  /** Resolved commit SHA reported by GitHub, never echoed request arguments. */
  baseSha: string;
  /** Resolved commit SHA reported by GitHub, never echoed request arguments. */
  headSha: string;
  status: "ahead" | "behind" | "diverged" | "identical";
  aheadBy: number;
  behindBy: number;
};

export type AmuxOwnedRefSearchAdapter = {
  listRefs: (namespace: AmuxOwnedRefNamespace, after: string | null) => Promise<AmuxOwnedRefPage>;
  readTag: (sha: string) => Promise<AmuxGitTagObservation>;
  compareCommits: (baseSha: string, headSha: string) => Promise<AmuxCommitComparison>;
  /** Encode the returned ref name as data in the GitHub URL, not as a raw path. */
  readRef: (name: string) => Promise<AmuxListedRef & { repositoryId: number }>;
};

export type AmuxOwnedRefSearchLimits = {
  maxPages: number;
  maxRefs: number;
  maxComparisons: number;
  maxTagDepth: number;
};

export type AmuxOwnedRefSearchResult =
  | {
      status: "verified_witness";
      witness: {
        repositoryId: number;
        name: string;
        protected: boolean | null;
        refObjectSha: string;
        refCommitSha: string;
      };
      inspectedRefs: number;
    }
  | { status: "hold"; reason: string; inspectedRefs: number };

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const validSha = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const nonNegative = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const validRef = (name: unknown, namespace: AmuxOwnedRefNamespace): name is string =>
  typeof name === "string" && name.startsWith(namespace) &&
  name.length > namespace.length && name.length <= 512 &&
  !/[\x00-\x1f\x7f]/.test(name);
const validListed = (ref: AmuxListedRef, namespace: AmuxOwnedRefNamespace) =>
  ref && validRef(ref.name, namespace) && validSha(ref.objectSha) &&
  (ref.objectType === "commit" || (namespace === "refs/tags/" && ref.objectType === "tag")) &&
  (ref.protected === true || ref.protected === false || ref.protected === null);
const validLimits = (limits: AmuxOwnedRefSearchLimits) =>
  limits && positive(limits.maxPages) && positive(limits.maxRefs) &&
  positive(limits.maxComparisons) && positive(limits.maxTagDepth);

/** A positive witness is sufficient; a negative or incomplete search is never a denial of reachability. */
export async function searchAmuxOwnedRefWitness(
  repositoryId: number,
  targetCommitSha: string,
  limits: AmuxOwnedRefSearchLimits,
  adapter: AmuxOwnedRefSearchAdapter,
): Promise<AmuxOwnedRefSearchResult> {
  let inspectedRefs = 0;
  const hold = (reason: string): AmuxOwnedRefSearchResult => ({ status: "hold", reason, inspectedRefs });
  if (!positive(repositoryId) || !validSha(targetCommitSha) || !validLimits(limits) ||
      !adapter || typeof adapter.listRefs !== "function" || typeof adapter.readTag !== "function" ||
      typeof adapter.compareCommits !== "function" || typeof adapter.readRef !== "function") {
    return hold("invalid_search_contract");
  }

  let pageCount = 0;
  let comparisonCount = 0;
  const seenRefs = new Set<string>();
  try {
    for (const namespace of ["refs/heads/", "refs/tags/"] as const) {
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      while (true) {
        if (++pageCount > limits.maxPages) return hold("search_limit");
        const page = await adapter.listRefs(namespace, cursor);
        if (!page || page.repositoryId !== repositoryId || !Array.isArray(page.refs) ||
            typeof page.hasNextPage !== "boolean" ||
            (page.endCursor !== null && (typeof page.endCursor !== "string" || !page.endCursor))) {
          return hold("page_unverified");
        }
        for (const ref of page.refs) {
          if (!validListed(ref, namespace) || seenRefs.has(ref.name)) return hold("page_unverified");
          seenRefs.add(ref.name);
          if (inspectedRefs >= limits.maxRefs) return hold("search_limit");
          inspectedRefs++;
          if (ref.objectSha.length !== targetCommitSha.length) return hold("ref_unverified");

          let refCommitSha = ref.objectSha;
          if (ref.objectType === "tag") {
            const seenTags = new Set<string>();
            let resolved = false;
            for (let depth = 0; depth < limits.maxTagDepth; depth++) {
              if (seenTags.has(refCommitSha)) return hold("tag_unverified");
              seenTags.add(refCommitSha);
              const tag = await adapter.readTag(refCommitSha);
              if (!tag || tag.repositoryId !== repositoryId || tag.sha !== refCommitSha ||
                  !validSha(tag.targetSha) || tag.targetSha.length !== targetCommitSha.length) {
                return hold("tag_unverified");
              }
              if (tag.targetType === "tree" || tag.targetType === "blob") {
                resolved = true;
                refCommitSha = "";
                break;
              }
              if (tag.targetType !== "tag" && tag.targetType !== "commit") {
                return hold("tag_unverified");
              }
              refCommitSha = tag.targetSha;
              if (tag.targetType === "commit") {
                resolved = true;
                break;
              }
            }
            if (!resolved) return hold("tag_unverified");
            if (!refCommitSha) continue;
          }
          if (refCommitSha.length !== targetCommitSha.length) return hold("ref_unverified");
          if (++comparisonCount > limits.maxComparisons) return hold("search_limit");
          const comparison = await adapter.compareCommits(targetCommitSha, refCommitSha);
          if (!comparison || comparison.repositoryId !== repositoryId ||
              comparison.baseSha !== targetCommitSha || comparison.headSha !== refCommitSha ||
              !nonNegative(comparison.aheadBy) || !nonNegative(comparison.behindBy) ||
              !["ahead", "behind", "diverged", "identical"].includes(comparison.status)) {
            return hold("comparison_unverified");
          }
          const isWitness = comparison.behindBy === 0 &&
            (comparison.status === "identical" && comparison.aheadBy === 0 ||
             comparison.status === "ahead" && comparison.aheadBy > 0);
          if (!isWitness) continue;
          const refreshed = await adapter.readRef(ref.name);
          if (!validListed(refreshed, namespace) || refreshed.repositoryId !== repositoryId ||
              refreshed.name !== ref.name || refreshed.objectType !== ref.objectType ||
              refreshed.objectSha !== ref.objectSha) {
            return hold("ref_changed");
          }
          return {
            status: "verified_witness",
            witness: {
              repositoryId, name: ref.name, protected: refreshed.protected,
              refObjectSha: ref.objectSha, refCommitSha,
            },
            inspectedRefs,
          };
        }
        if (!page.hasNextPage) break;
        if (!page.endCursor || page.endCursor === cursor || seenCursors.has(page.endCursor)) {
          return hold("page_unverified");
        }
        seenCursors.add(page.endCursor);
        cursor = page.endCursor;
      }
    }
    return hold("no_verified_witness");
  } catch {
    return hold("collector_unavailable");
  }
}
