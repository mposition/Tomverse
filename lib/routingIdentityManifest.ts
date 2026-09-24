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
 * - `region`, `destinationRegions` -- eligibility reads the approval, not
 *   these (section 15.3), and the binding that would make them derived
 *   does not exist yet: they are still independent columns on
 *   `ProviderEndpoint`. Digesting them would create the second answer that
 *   section is trying to prevent. Where there is no approval, what the
 *   reconstruction has to say is that there was none -- which
 *   `residencyApprovalId` being null says -- and section 4.1 already puts
 *   an endpoint with no enforceable pin outside constrained traffic;
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
    /**
     * The instant the quality evidence expires, or null.
     *
     * A `Date` rather than a string, and canonicalised to an ISO instant
     * before it reaches the digest. As a free string it was the one field
     * a row could not reproduce: `2026-12-01T00:00:00.000Z` and
     * `2026-12-01T00:00:00Z` are the same instant and digested
     * differently, the `TIMESTAMP(3)` column keeps only one of them, and a
     * string that is not a date at all digested fine and failed to insert.
     */
    qualityGateExpiresAt: Date | null;
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
        // `JSON.stringify` turns several distinct values into the same bytes
        // -- NaN, Infinity and -Infinity all become null, a Date becomes its
        // ISO string or `{}` depending on where it sits, a nested undefined
        // disappears. None can arrive from the jsonb column this reads, and
        // a digest that quietly agreed about two different declarations is
        // worth refusing rather than documenting.
        if (typeof node === "number" && !Number.isFinite(node)) {
            throw new TypeError(`capability value ${node} is not JSON`);
        }
        if (typeof node === "bigint" || typeof node === "function" || typeof node === "symbol") {
            throw new TypeError(`capability value of type ${typeof node} is not JSON`);
        }
        if (node instanceof Date) {
            throw new TypeError("a capability declaration holds no Date");
        }
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
    // A boolean is `~1` or `~0`. An earlier version wrote `2:b1`, which is
    // exactly what the string "b1" encodes to -- the per-field types meant
    // no two well typed entries could collide, but the comment claimed the
    // three shapes were disjoint and they were not. They are now: a string
    // begins with a digit, a null is `-`, a boolean is `~`.
    if (value === null) return "-:";
    if (typeof value === "boolean") return value ? "~1" : "~0";
    return `${value.length}:${value}`;
};

/**
 * One field's value as the digest sees it.
 *
 * Only the expiry needs normalising, and it needs it badly enough to be
 * worth a function: the column is a `TIMESTAMP(3)` and two spellings of one
 * instant have to digest the same, or a row cannot reproduce the digest
 * computed from it.
 */
const fieldValue = (
    entry: ManifestDeploymentEntry,
    field: (typeof MANIFEST_ENTRY_FIELDS)[number]
): string | boolean | null => {
    if (field !== "qualityGateExpiresAt") return entry[field];
    const expiry = entry.qualityGateExpiresAt;
    if (expiry === null) return null;
    // `toISOString()` throws on an invalid Date, and this function has to be
    // total: `manifestProblems()` computes the digest in order to compare it,
    // so a throw here would stop the validator reaching its own complaint
    // about the same value. A fixed marker instead -- distinct from null, so
    // an unreadable expiry does not digest as no expiry, and never present in
    // a published digest because publication refuses the entry.
    return Number.isNaN(expiry.getTime()) ? "not-an-instant" : expiry.toISOString();
};

const encodeEntry = (entry: ManifestDeploymentEntry): string =>
    MANIFEST_ENTRY_FIELDS.map((field) => encodeField(fieldValue(entry, field))).join("");

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

/** One approved ceiling, as the manifest cites it. */
export type CeilingApproval = {
    id: string;
    ceiling: number;
    approvedAt: Date;
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
    /**
     * The approved ceiling this manifest is published under.
     *
     * Section 8.5: size is controlled when the configuration is approved,
     * not when a turn runs. An earlier draft capped the candidate verdicts
     * written per run, and whichever cut you take there throws away either
     * the lowest-ranked candidates or a particular rejection reason -- the
     * answer to "why was this deployment not picked".
     *
     * **A separate approval, not a number supplied with the entries.** The
     * first version took `approvedCeiling` from the publisher in the same
     * call, and an independent review showed why that is not a ceiling: a
     * hundred deployments with a ceiling of a hundred passes. A limit the
     * publisher picks to fit is not the limit section 8.5 means.
     *
     * So this is the `RoutingSnapshotCeilingApproval` row the manifest
     * cites -- attributed, dated and immutable -- and the manifest stores
     * its id and a copy of the value. The database refuses a copy that does
     * not match the approval, and an approval dated after the publication.
     *
     * Null when none has been approved. There is no default, because a
     * ceiling is an approval and an absent approval is not an unlimited one.
     */
    ceilingApproval: CeilingApproval | null;
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

    // The ceiling comes from an approval the publisher cites, never from a
    // number supplied alongside the entries. Nothing here reads the
    // approval table -- this module does no I/O -- so the caller passes the
    // row, and the database refuses a manifest whose stored copy does not
    // match the row it cites.
    const approval = input.ceilingApproval;
    if (approval === null) {
        problems.push("a manifest is published under an approved ceiling");
    } else if (!Number.isInteger(approval.ceiling) || approval.ceiling < 1) {
        problems.push("an approved ceiling is a whole number from one");
    } else {
        if (input.entries.length > approval.ceiling) {
            // This function reports; it does not refuse a write. A publisher
            // that heeds it leaves the last approved snapshot standing, which
            // is section 8.5's behaviour -- but there is no publisher yet.
            // What the database refuses is an entry in a slot at or beyond
            // the manifest's `entryCount`, which the ceiling bounds.
            problems.push(
                `${input.entries.length} deployments is over the approved ceiling of ${approval.ceiling}`
            );
        }
        if (input.approvedAt && approval.approvedAt > input.approvedAt) {
            problems.push("the ceiling was approved after this manifest was published");
        }
    }
    const ids = new Set<string>();
    for (const entry of input.entries) {
        if (ids.has(entry.modelDeploymentId)) {
            problems.push(`deployment ${JSON.stringify(entry.modelDeploymentId)} appears twice`);
        }
        ids.add(entry.modelDeploymentId);
        // An invalid Date digests as nothing and would throw on the way to
        // the column. Refused here so the publish path says which entry.
        const expiry = entry.qualityGateExpiresAt;
        if (expiry !== null && Number.isNaN(expiry.getTime())) {
            problems.push(
                `deployment ${JSON.stringify(entry.modelDeploymentId)} has an expiry that is not an instant`
            );
        }
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
