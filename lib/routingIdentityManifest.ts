/**
 * One published snapshot of the routing identity configuration.
 *
 * Dark. Nothing publishes a manifest and nothing reads one.
 *
 * ## What it is for
 *
 * The identity design forbids four things until this exists: enabling the
 * identity config writer, recording a canary, judging eligibility, and making
 * a deployment-level decision. All four share one failure -- a decision made
 * against configuration that has since moved, with no way afterwards to say
 * what it was made against.
 *
 * Mutable rows cannot answer "what was allowed at the time", and the residency
 * question puts a legal judgement on top of that answer. So a decision names a
 * manifest version, and a manifest version is published once and never edited.
 *
 * ## Verifying is not reconstructing
 *
 * The first draft stored a digest and a count and nothing else, and called
 * that an answer. It is not: a digest proves a set of values was not altered
 * *if you still have the values*, and `ModelDeployment` and `ProviderEndpoint`
 * are mutable rows that will have moved by the time anybody asks. An
 * independent review rejected it on exactly that.
 *
 * So a manifest publishes *entries*. Each one carries the values the decision
 * turned on, copied at publication, plus a foreign key to the residency
 * approval -- which is append-only, so its legal content is already immutable
 * and does not need copying. The digest is then a check on the entries rather
 * than a substitute for them.
 *
 * ## What the digest covers, and why each field is on the list
 *
 * The list is written out rather than derived, so changing what a manifest
 * commits to is a change to this file. It is also *wider* than the first
 * draft's, because the repository already says what identity means and the
 * first list was smaller than that.
 *
 * `model_deployment_gate_follows_identity()` refuses to leave a deployment
 * enabled when any of nine columns changes. Five of those were missing here,
 * and the gap was exploitable without a single forbidden write: disable the
 * deployment (the digest moves), change `capabilities` while it is disabled,
 * re-enable it and restore `qualityGateStatus`. Every digested value is back
 * where it started and the candidate filter reads different capabilities.
 *
 * `ProviderEndpoint` has no such trigger at all, so `gatewayProvider`,
 * `servingProvider`, `endpointUrl` and its own `enabled` change under a
 * stable id. Those decide where the request goes and who receives it, which
 * section 2.1's rule puts in the upper layer: swap the two rows, and if the
 * answer or its legality changes, it belongs here.
 *
 * Deliberately absent, each for a reason rather than an oversight:
 *
 * - `routingPolicyDigest` -- intent, not eligibility (section 4.1);
 * - `region`, `destinationRegions` -- derived from the approval this entry
 *   points at, and copying them would be a second answer to the same
 *   question;
 * - `resourceId`, `cloudAccountId` -- these name the resource and the billing
 *   account. The URL is what routes, and who pays is the layer below;
 * - anything credential, quota or price -- section 2.1 keeps those out of
 *   identity, and section 3 makes it a hard invariant.
 *
 * Pure: `node:crypto` and nothing else.
 */

import { createHash } from "node:crypto";

/**
 * One deployment as the manifest commits to it.
 *
 * Every field is either something a decision turns on, or the key to an
 * immutable row holding what the decision was allowed by.
 */
export type ManifestDeploymentEntry = {
    // --- the placement -----------------------------------------------------
    modelDeploymentId: string;
    logicalModelId: string;
    upstreamDeploymentName: string;
    /** Null where the placement declares none. */
    modelVersion: string | null;
    modelRevision: string | null;
    quantization: string | null;
    tokenizerRevision: string | null;
    /** Curation, never a measurement. */
    qualityTier: string | null;
    /**
     * The capability declarations, canonicalised to a string.
     *
     * The one field whose shape this module does not fix, because the
     * candidate filter reads whatever is declared. `canonicalCapabilities()`
     * turns it into bytes so the digest covers a capability added or removed
     * -- which is a decision change, and the thing a fixed field list would
     * otherwise miss.
     */
    capabilities: string;
    qualityGateStatus: string;
    /** ISO 8601, or null. Two placements whose evidence expires on different
     * days are not the same manifest. */
    qualityGateExpiresAt: string | null;
    deploymentEnabled: boolean;

    // --- the endpoint it is served from ------------------------------------
    providerEndpointId: string;
    gatewayProvider: string;
    servingProvider: string | null;
    endpointUrl: string | null;
    endpointResidencyClass: string;
    endpointEnabled: boolean;

    // --- what it was allowed by --------------------------------------------
    /**
     * The `EndpointResidencyApproval` row, by id -- that table has no version
     * column because its id *is* the version, and its rows are append-only.
     *
     * A key rather than a copy: the recipients, the regions, the enforcement
     * mechanism, the evidence and the dates are already immutable where they
     * are, and copying them here would be a second place they could disagree.
     * Null while an endpoint has no approval, which is every endpoint today.
     */
    residencyApprovalId: string | null;
};

const MANIFEST_ENTRY_FIELDS = [
    "modelDeploymentId",
    "logicalModelId",
    "upstreamDeploymentName",
    "modelVersion",
    "modelRevision",
    "quantization",
    "tokenizerRevision",
    "qualityTier",
    "capabilities",
    "qualityGateStatus",
    "qualityGateExpiresAt",
    "deploymentEnabled",
    "providerEndpointId",
    "gatewayProvider",
    "servingProvider",
    "endpointUrl",
    "endpointResidencyClass",
    "endpointEnabled",
    "residencyApprovalId",
] as const satisfies readonly (keyof ManifestDeploymentEntry)[];

/**
 * The exact field list a manifest digest covers.
 *
 * Exported so a test can compare it against the columns the schema's own
 * identity trigger names. `satisfies` above only checks that each name is a
 * key of the type; it cannot notice a column the type never mentioned, which
 * is how five of them went missing.
 */
export const MANIFEST_DIGEST_FIELDS: readonly string[] = MANIFEST_ENTRY_FIELDS;

/**
 * Capability declarations as bytes the digest can cover.
 *
 * A generic canonicaliser, and here that is what is wanted: the field is
 * open-ended, the filter reads whatever is declared, and a capability added
 * or removed has to move the digest. Everywhere else in this module the field
 * list is explicit for the opposite reason.
 *
 * Object keys are sorted; arrays keep their order, because an ordered list of
 * capabilities is not the same declaration as a differently ordered one.
 */
export const canonicalCapabilities = (value: unknown): string => {
    const canonical = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(canonical);
        if (node && typeof node === "object") {
            return Object.fromEntries(
                Object.entries(node as Record<string, unknown>)
                    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                    .map(([key, nested]) => [key, canonical(nested)])
            );
        }
        return node;
    };
    return JSON.stringify(canonical(value ?? null));
};

const encodeField = (value: string | boolean | null): string => {
    // Three disjoint shapes, and the disjointness is the whole job.
    //
    // A string is `<length>:<value>`, so it always begins with a digit and a
    // boundary cannot be moved between two adjacent fields.
    //
    // `null` is `-:`, which no string can produce. An earlier version encoded
    // it as U+0000 and length-prefixed that, so a deployment declaring no
    // model version digested the same as one whose version was a single NUL
    // character.
    //
    // A boolean is tagged, so `true` and the string "1" stay different.
    if (value === null) return "-:";
    if (typeof value === "boolean") return value ? "2:b1" : "2:b0";
    return `${value.length}:${value}`;
};

const encodeEntry = (entry: ManifestDeploymentEntry): string =>
    MANIFEST_ENTRY_FIELDS.map((field) => encodeField(entry[field])).join("");

/**
 * The digest of a set of deployment entries.
 *
 * Entries are sorted by their whole encoded form, so the digest does not
 * depend on the order rows came back in *and* does not depend on input order
 * when two entries share a deployment id. Sorting by the id alone left that
 * case order-sensitive; `manifestProblems()` refuses duplicates, but a digest
 * function that answers differently for the same set is worth not having.
 */
export const manifestDigest = (
    entries: readonly ManifestDeploymentEntry[]
): string => {
    const encoded = entries.map(encodeEntry).sort();
    const hash = createHash("sha256");
    // The count goes in first, so a manifest of N entries cannot digest the
    // same as one of N+1 whose extra entry encodes to nothing.
    hash.update(encodeField(String(encoded.length)));
    for (const entry of encoded) hash.update(entry);
    return hash.digest("hex");
};

export type ManifestInput = {
    version: number;
    digest: string;
    /**
     * Stored on the row and checked here against the entries.
     *
     * Without it a row could carry the hash of two entries beside a count of
     * one, and nothing reading the row alone could work out that the two
     * disagreed.
     */
    entryCount: number;
    entries: readonly ManifestDeploymentEntry[];
    approvedBy?: string | null;
    approvedAt?: Date | null;
};

/**
 * Whether a name says nothing.
 *
 * The character set is written out rather than left to `String.trim()`,
 * because the database has to refuse exactly the same strings: `trim()` strips
 * U+00A0 and every other Unicode space, while PostgreSQL's `btrim` and a
 * `[[:space:]]` class do not. A name of one non-breaking space was refused
 * here and accepted by the constraint.
 */
const BLANK_CHARACTERS = /^[ \t\n\r\f\v]*$/;

const blank = (value: string | null | undefined): boolean =>
    value === null || value === undefined || BLANK_CHARACTERS.test(value);

/**
 * Why a manifest is not publishable, or an empty list.
 *
 * The database holds the shape rules. What it cannot hold is that the digest
 * and the count describe the entries -- a CHECK sees one row at a time -- so
 * those live here, and a caller passes entries rather than being handed a
 * digest.
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

    if (input.entryCount !== input.entries.length) {
        problems.push("the count does not match these deployments");
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
    if (blank(input.approvedBy)) {
        problems.push("a manifest names who published it");
    }
    if (!input.approvedAt) {
        problems.push("a manifest says when it was published");
    }

    return problems;
};
