/**
 * One published snapshot of the routing identity configuration.
 *
 * Dark. Nothing publishes a manifest and nothing reads one.
 *
 * ## What it is for
 *
 * The identity design forbids four things until this exists: enabling the
 * identity config writer, recording a canary, judging eligibility, and making
 * a deployment-level decision. All four share a failure mode -- a decision
 * made against configuration that has since moved, with no way afterwards to
 * say what it was made against.
 *
 * Mutable rows cannot answer "what was allowed at the time", and the residency
 * question puts a legal judgement on top of that answer. So a decision names a
 * manifest version, and a manifest version is published once and never edited.
 *
 * ## Why the digest is stored twice
 *
 * A record that names a manifest carries the version *and* the digest. That is
 * deliberate redundancy: the foreign key says which row, and the digest says
 * what that row contained when the decision was made. If the two ever
 * disagree, the disagreement is the finding -- a manifest was altered after
 * publication, which the append-only trigger is supposed to make impossible
 * and which the digest lets anybody detect without trusting the trigger.
 *
 * ## The digest covers a fixed list of fields, in a fixed order
 *
 * Not a generic canonicaliser over whatever object it is handed. A generic one
 * means a field added to the entry shape silently changes every digest, and a
 * field removed silently stops being covered -- in both cases without an edit
 * anybody reviews. The list here is written out, so changing what a manifest
 * commits to is a change to this file.
 *
 * Every field is length-prefixed before it is joined. Without that,
 * `["ab", "c"]` and `["a", "bc"]` produce the same string and therefore the
 * same digest, which is the ordinary way a digest over concatenated fields
 * stops meaning anything.
 */

import { createHash } from "node:crypto";

/**
 * One deployment as the manifest commits to it.
 *
 * Every field is part of the identity a decision needs to be attributable to:
 * where the request goes, which placement answers, what residency approval it
 * runs under, and whether its quality evidence is current. A field that a
 * decision does not depend on does not belong here -- it would change the
 * digest without changing what was decided.
 */
export type ManifestDeploymentEntry = {
    modelDeploymentId: string;
    providerEndpointId: string;
    logicalModelId: string;
    upstreamDeploymentName: string;
    /** Null where the placement declares none. */
    modelVersion: string | null;
    endpointResidencyClass: string;
    /** The approval version, not the approval's own id. */
    residencyApprovalVersion: string | null;
    qualityGateStatus: string;
    enabled: boolean;
};

const MANIFEST_ENTRY_FIELDS = [
    "modelDeploymentId",
    "providerEndpointId",
    "logicalModelId",
    "upstreamDeploymentName",
    "modelVersion",
    "endpointResidencyClass",
    "residencyApprovalVersion",
    "qualityGateStatus",
    "enabled",
] as const satisfies readonly (keyof ManifestDeploymentEntry)[];

/**
 * The exact field list a manifest digest covers, exported so a test can fail
 * when the entry type and the digest drift apart.
 */
export const MANIFEST_DIGEST_FIELDS: readonly string[] = MANIFEST_ENTRY_FIELDS;

const encodeField = (value: string | boolean | null): string => {
    // Three disjoint shapes, and the disjointness is the whole job.
    //
    // A string is `<length>:<value>`, so it always begins with a digit and a
    // boundary cannot be moved between two adjacent fields.
    //
    // `null` is `-:`, which no string can produce. An earlier version encoded
    // it as U+0000 and length-prefixed that, so a deployment declaring no
    // model version digested the same as one whose version was a single NUL
    // character. Exotic, and exactly the kind of thing a digest is supposed to
    // tell apart.
    //
    // A boolean is tagged, so `true` and the string "1" stay different. The
    // field order is fixed, so today only `enabled` is ever a boolean and the
    // two could not meet -- but that is a property of the list rather than of
    // the encoding, and the encoding should not depend on it.
    if (value === null) return "-:";
    if (typeof value === "boolean") return value ? "2:b1" : "2:b0";
    return `${value.length}:${value}`;
};

/**
 * The digest of a set of deployment entries.
 *
 * Entries are sorted by deployment id first, so the digest does not depend on
 * the order rows came back in. Two manifests with the same deployments in a
 * different order are the same manifest.
 */
export const manifestDigest = (
    entries: readonly ManifestDeploymentEntry[]
): string => {
    const sorted = [...entries].sort((left, right) =>
        left.modelDeploymentId < right.modelDeploymentId
            ? -1
            : left.modelDeploymentId > right.modelDeploymentId
              ? 1
              : 0
    );
    const hash = createHash("sha256");
    // The entry count goes in first, so a manifest of N entries can never
    // digest the same as one of N+1 whose extra entry encodes to nothing.
    hash.update(encodeField(String(sorted.length)));
    for (const entry of sorted) {
        for (const field of MANIFEST_ENTRY_FIELDS) {
            hash.update(encodeField(entry[field]));
        }
    }
    return hash.digest("hex");
};

export type ManifestInput = {
    version: number;
    digest: string;
    entries: readonly ManifestDeploymentEntry[];
    approvedBy?: string | null;
    approvedAt?: Date | null;
};

/**
 * Why a manifest is not publishable, or an empty list.
 *
 * The database holds the shape rules. What it cannot hold is that the digest
 * matches the entries, because it never sees them -- that check lives here and
 * is the reason a caller computes the digest rather than being handed one.
 */
export const manifestProblems = (input: ManifestInput): readonly string[] => {
    const problems: string[] = [];

    // Monotonic and starting at one. Zero would be indistinguishable from an
    // unset column in every report that reads it.
    if (!Number.isInteger(input.version) || input.version < 1) {
        problems.push("a manifest version is a whole number from one");
    }

    // An empty manifest is publishable in principle -- it says no deployment
    // is configured -- but not by accident, so it is stated rather than
    // inferred from an absent list.
    if (input.entries.length === 0) {
        problems.push("a manifest with no deployments is not published by omission");
    }

    const ids = new Set<string>();
    for (const entry of input.entries) {
        if (ids.has(entry.modelDeploymentId)) {
            problems.push(`deployment ${JSON.stringify(entry.modelDeploymentId)} appears twice`);
        }
        ids.add(entry.modelDeploymentId);
    }

    if (input.digest !== manifestDigest(input.entries)) {
        problems.push("the digest does not describe these deployments");
    }

    // A manifest is what a legal judgement about residency rests on, so it is
    // approved by a person and the record says who and when. An approval with
    // no time is one nobody can place against the version it approved.
    if (!input.approvedBy?.trim()) {
        problems.push("a manifest names who published it");
    }
    if (!input.approvedAt) {
        problems.push("a manifest says when it was published");
    }

    return problems;
};
