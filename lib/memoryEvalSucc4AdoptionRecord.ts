/**
 * The unified adoption record a successor dataset is frozen against.
 *
 * docs/ops/memory-extraction-eval-dataset.md §7.1a. A successor's cases arrive
 * two ways -- inherited from the source dataset's adopted batches, and written
 * as replacement tranches -- and only the first half already has an adoption
 * record. Rather than copy a batch record per tranche, §7.1a allows one
 * document, and this module is what reads it.
 *
 * ## What this module refuses to infer
 *
 * Adoption. The record's judgement cells are read, never derived: a tranche
 * whose verdict cell is empty is not adopted, and no amount of provenance
 * elsewhere in the tree makes it so. `movedBecause` and
 * `settledByExistingContract` are written by whoever drafted the replacements,
 * so treating them as adoption would be the drafter adopting its own work --
 * the structure docs/ops/memory-extraction-eval-dataset.md §6.2 exists to
 * prevent.
 *
 * So the five conditions split cleanly: 1 to 3 are facts about the tree and an
 * agent can make them true, 4 and 5 are a person's marks and an agent cannot.
 * Until someone writes them the check reports MISS, which is the whole design.
 */

import { readFileSync } from "node:fs";

/** One tranche row as the record states it. */
export type Succ4AdoptionTrancheRow = {
    trancheId: string;
    caseCount: number;
    componentDigest: string;
};

export type Succ4AdoptionRecord = {
    /** Tranche rows from the composition table. */
    tranches: readonly Succ4AdoptionTrancheRow[];
    /** `ai-draft:tool/model/version` per tranche, from the drafting table. */
    draftedBy: Readonly<Record<string, string>>;
    /** `adopted` / `rejected` per tranche, or absent while unfilled. */
    verdicts: Readonly<Record<string, string>>;
    /** The reviewer named in the role table, or "" while unfilled. */
    reviewer: string;
    /** The draft-disagreement cells, "" while unfilled. */
    disagreement: {
        judged: string;
        rejected: string;
        rate: string;
        unresolved: string;
    };
    signature: { reviewer: string; approvedAt: string; signature: string };
};

/** A markdown table cell is unfilled when it is empty or a placeholder. */
export const isUnfilled = (value: string): boolean =>
    value.trim().length === 0 || /^\*\(.*\)\*$/.test(value.trim());

const rowsOf = (source: string, heading: RegExp): string[][] => {
    const section = source.split(heading)[1];
    if (section === undefined) return [];
    const lines = section.split("\n");
    const rows: string[][] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) {
            if (rows.length > 0) break;
            continue;
        }
        const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
        if (cells.every((cell) => /^-*$/.test(cell))) continue;
        rows.push(cells);
    }
    return rows;
};

const unbacktick = (value: string): string => value.replace(/`/g, "").trim();

/** Reads the record. Parsing only -- nothing here decides anything. */
export function parseSucc4AdoptionRecord(source: string): Succ4AdoptionRecord {
    const composition = rowsOf(source, /## 3\. [^\n]*\n/).slice(1);
    const drafting = rowsOf(source, /### 3\.2 [^\n]*\n/).slice(1);
    const roles = rowsOf(source, /## 4\. [^\n]*\n/).slice(1);
    const disagreementRows = rowsOf(source, /## 5\. [^\n]*\n/).slice(1);
    const verdictRows = rowsOf(source, /## 6\. [^\n]*\n/).slice(1);
    const signatureRows = rowsOf(source, /## 7\. [^\n]*\n/).slice(1);

    const labelled = (rows: string[][], label: string): string => {
        const row = rows.find((cells) => unbacktick(cells[0]) === label);
        return row ? row[1] ?? "" : "";
    };

    return {
        tranches: composition.map((cells) => ({
            trancheId: unbacktick(cells[0]),
            caseCount: Number.parseInt(cells[1] ?? "", 10),
            componentDigest: unbacktick(cells[3] ?? ""),
        })),
        draftedBy: Object.fromEntries(
            drafting.map((cells) => [unbacktick(cells[0]), unbacktick(cells[1] ?? "")])
        ),
        verdicts: Object.fromEntries(
            verdictRows.map((cells) => [
                unbacktick(cells[0]),
                (cells[1] ?? "").trim(),
            ])
        ),
        reviewer: labelled(roles, "\uac80\uc218 \u00b7 \ucc44\ud0dd \ud310\uc815"),
        disagreement: {
            judged: labelled(disagreementRows, "\ud310\uc815 \uac74\uc218"),
            rejected: labelled(disagreementRows, "\ubc18\ub824 \uac74\uc218"),
            rate: labelled(disagreementRows, "\ube44\uc728"),
            unresolved: labelled(disagreementRows, "\ubbf8\uacb0"),
        },
        signature: {
            reviewer: labelled(signatureRows, "\uac80\ud1a0\uc790"),
            approvedAt: labelled(signatureRows, "\uc2b9\uc778\uc77c"),
            signature: labelled(signatureRows, "\uc11c\uba85"),
        },
    };
}

export type Succ4AdoptionCondition = {
    condition: string;
    detail: string;
    ok: boolean;
};

/**
 * The five conditions of docs/ops/memory-extraction-eval-dataset.md §7.1a.
 *
 * Pure, so the check can be tested against a record that is deliberately
 * wrong. A checker only ever exercised against the one document that happens
 * to pass says nothing about what it would do with one that does not.
 */
export function succ4AdoptionConditions(input: {
    record: Succ4AdoptionRecord;
    /** Cases inherited from the source, by the source batch that holds them. */
    inherited: readonly { sourceBatchId: string; caseCount: number }[];
    /** Source batches that actually carry an adoption record on disk. */
    sourceBatchIdsWithRecord: readonly string[];
    /** The tranches as the live tree holds them. */
    liveTranches: readonly Succ4AdoptionTrancheRow[];
    /** Replacement cases in the dataset, for the arithmetic. */
    replacementCount: number;
}): readonly Succ4AdoptionCondition[] {
    const { record, inherited, sourceBatchIdsWithRecord, liveTranches, replacementCount } =
        input;
    const results: Succ4AdoptionCondition[] = [];
    const check = (condition: string, detail: string, ok: boolean) =>
        results.push({ condition, detail, ok });

    /* --- 1: the inherited half is covered by the source's own records ------ */
    {
        const withRecord = new Set(sourceBatchIdsWithRecord);
        const uncovered = inherited.filter(
            (component) => !withRecord.has(component.sourceBatchId)
        );
        const covered = inherited
            .filter((component) => withRecord.has(component.sourceBatchId))
            .reduce((total, component) => total + component.caseCount, 0);
        check(
            "inherited cases covered by the source's adoption records",
            uncovered.length === 0
                ? `${covered} cases across ${inherited.length} source batches`
                : `no record for ${uncovered.map((c) => c.sourceBatchId).join(", ")}`,
            uncovered.length === 0
        );
    }

    /* --- 2: the record's tranches are exactly the tree's ------------------- */
    {
        const recorded = record.tranches.map((t) => t.trancheId).sort();
        const live = liveTranches.map((t) => t.trancheId).sort();
        const sameIds = recorded.join(",") === live.join(",");
        const recordedTotal = record.tranches.reduce(
            (total, t) => total + (Number.isFinite(t.caseCount) ? t.caseCount : 0),
            0
        );
        const ok = sameIds && recordedTotal === replacementCount;
        check(
            "the record's tranches are exactly the replacements",
            ok
                ? `${record.tranches.length} tranches, ${recordedTotal} cases`
                : !sameIds
                  ? `recorded ${recorded.join(", ") || "none"}; tree has ${live.join(", ")}`
                  : `recorded ${recordedTotal} cases, the dataset holds ${replacementCount}`,
            ok
        );
    }

    /* --- 3: every recorded digest is the live one ------------------------- */
    {
        const liveById = new Map(liveTranches.map((t) => [t.trancheId, t]));
        const moved = record.tranches.filter((t) => {
            const live = liveById.get(t.trancheId);
            return !live || live.componentDigest !== t.componentDigest;
        });
        check(
            "every recorded tranche digest matches the tree",
            moved.length === 0
                ? `${record.tranches.length}/${record.tranches.length}`
                : `moved: ${moved.map((t) => t.trancheId).join(", ")}`,
            moved.length === 0
        );
    }

    /* --- 4: drafting source, reviewer, disagreement, verdicts all written -- */
    {
        const missing: string[] = [];
        for (const tranche of record.tranches) {
            const drafted = record.draftedBy[tranche.trancheId] ?? "";
            if (!/^ai-draft:[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(drafted)) {
                missing.push(`${tranche.trancheId} drafting source`);
            }
        }
        if (isUnfilled(record.reviewer)) missing.push("reviewer");
        for (const [label, value] of Object.entries(record.disagreement)) {
            if (isUnfilled(value)) missing.push(`disagreement ${label}`);
        }
        for (const tranche of record.tranches) {
            if (isUnfilled(record.verdicts[tranche.trancheId] ?? "")) {
                missing.push(`${tranche.trancheId} verdict`);
            }
        }
        for (const [label, value] of Object.entries(record.signature)) {
            if (isUnfilled(value)) missing.push(`signature ${label}`);
        }
        check(
            "drafting source, reviewer, disagreement and verdicts written",
            missing.length === 0
                ? "every cell filled"
                : `${missing.length} unfilled: ${missing.slice(0, 6).join(", ")}` +
                      (missing.length > 6 ? ` and ${missing.length - 6} more` : ""),
            missing.length === 0
        );
    }

    /* --- 5: nothing unadopted, nothing unrecorded ------------------------- */
    {
        const liveIds = liveTranches.map((t) => t.trancheId);
        const unrecorded = liveIds.filter(
            (id) => !record.tranches.some((t) => t.trancheId === id)
        );
        const notAdopted = liveIds.filter((id) => {
            const verdict = (record.verdicts[id] ?? "").trim();
            return verdict !== "adopted";
        });
        const ok = unrecorded.length === 0 && notAdopted.length === 0;
        check(
            "every tranche recorded and adopted",
            ok
                ? `${liveIds.length}/${liveIds.length} adopted`
                : [
                      unrecorded.length > 0
                          ? `unrecorded: ${unrecorded.join(", ")}`
                          : "",
                      notAdopted.length > 0
                          ? `not adopted: ${notAdopted.join(", ")}`
                          : "",
                  ]
                      .filter(Boolean)
                      .join("; "),
            ok
        );
    }

    return results;
}

/** Reads the record from disk. Separated so the conditions stay pure. */
export function readSucc4AdoptionRecord(path: string): Succ4AdoptionRecord {
    return parseSucc4AdoptionRecord(readFileSync(path, "utf8"));
}
