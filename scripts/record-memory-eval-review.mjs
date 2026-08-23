/**
 * Transcribes a reported review into a batch record.
 *
 *   npm run record:memory-eval-review -- --batch=batch-011 \
 *     --verdict=채택 --diversity=충분 --setup=같음 \
 *     --reviewed-on=2026-08-23 --reviewer=mposition --drafter=ai-draft:claude-code
 *
 * docs/ops/memory-extraction-eval-dataset.md §6.3 and AGENTS.md「기록을 채우는
 * 경계는 관측과 판정입니다」: the judgement is the reviewer's, and moving what
 * they reported into the record is not. Doing that by hand once is fine; doing
 * it twenty times is how two records end up saying the same thing differently.
 *
 * What this does NOT do:
 *
 *   * decide anything. Every value comes from the command line, and there is
 *     no default for a judgement -- `--verdict`, `--diversity`, `--setup` and
 *     `--reviewed-on` are all required, because a default here would be the
 *     script having an opinion about a review it did not perform.
 *   * overwrite a verdict. A record that already carries one is refused; the
 *     reviewer's cells are the one thing regeneration must never eat.
 *   * mark anything as confirmed. Every value it writes is tagged
 *     `*(전사 — 확인 필요)*`, and the note it adds above the verdicts says in
 *     the file itself that a person has to confirm each line.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import {
    parseBatchRecord,
    CASE_VERDICTS,
    BATCH_DECISIONS,
} from "../lib/memoryEvalBatchRecord.ts";

const argValue = (name) => {
    const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : "";
};

const batchId = argValue("batch");
const batch = CANDIDATE_BATCHES.find((entry) => entry.id === batchId);
if (!batch) {
    console.error(
        `--batch must name a batch awaiting review. Known: ${CANDIDATE_BATCHES.map(
            (entry) => entry.id
        ).join(", ") || "(none)"}`
    );
    process.exit(1);
}

const verdict = argValue("verdict");
const diversity = argValue("diversity");
const setup = argValue("setup");
const reviewedOn = argValue("reviewed-on");
const reviewer = argValue("reviewer");
const drafter = argValue("drafter");

const problems = [];
if (!CASE_VERDICTS.includes(verdict)) {
    problems.push(`--verdict must be one of ${CASE_VERDICTS.join(" / ")}`);
}
if (verdict !== "채택") {
    // A rejection is not a bulk operation: §6.4 wants a reason per case so the
    // redraft has something to answer, and §6.3 sends the whole batch back to
    // full review. Both are decisions a per-case sheet has to carry.
    problems.push(
        "this script writes a uniform 채택 only. A rejection needs its reason " +
            "on the case, and it sends the batch to full re-review " +
            "(docs/ops/memory-extraction-eval-dataset.md §6.3, §6.4) -- fill " +
            "those by hand."
    );
}
if (!BATCH_DECISIONS.includes(argValue("decision") || verdict)) {
    problems.push(`the batch decision must be one of ${BATCH_DECISIONS.join(" / ")}`);
}
if (!diversity) problems.push("--diversity is required (§6.5 is a person's call)");
if (!["같음", "다름"].includes(setup)) {
    problems.push("--setup must be 같음 or 다름 (§6.3)");
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedOn)) {
    problems.push("--reviewed-on must be YYYY-MM-DD");
}
if (!reviewer) problems.push("--reviewer is required (§7.1)");
if (!drafter) problems.push("--drafter is required (§7.1)");
if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    process.exit(1);
}

const path = batch.record;
const original = readFileSync(path, "utf8");

const existing = parseBatchRecord(original);
const alreadyJudged = existing.cases.filter((entry) => entry.verdict !== null);
if (alreadyJudged.length > 0) {
    console.error(
        `error: ${path} already carries ${alreadyJudged.length} verdict(s). ` +
            "Refusing to overwrite a review. Edit it by hand if it needs correcting."
    );
    process.exit(1);
}

const tag = "*(전사 — 확인 필요)*";
const notice = [
    "",
    "> **아래 판정란은 에이전트가 옮겨 적은 전사입니다.** " +
        `${reviewedOn} 대화에서 운영자가 보고한`,
    `> 판정(${verdict} · 다양성 ${diversity} · 초안 구성 ${setup})을 그대로 옮긴 것이고, 지어낸 값은`,
    "> 없습니다. `AGENTS.md`「기록을 채우는 경계는 관측과 판정입니다」에 따라",
    "> **판정은 사람의 것**이므로, 운영자가 각 줄을 확인한 뒤 확정합니다. 확인 전에는",
    "> 채워져 있어도 검수가 성립하지 않습니다.",
].join("\n");

const anchor = "오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.";
if (!original.includes(anchor)) {
    console.error(`error: ${path} does not look like a generated review sheet.`);
    process.exit(1);
}

let updated = original.replace(anchor, `${anchor}\n${notice}`);

const emptyVerdictRows = (updated.match(/\|\s{2}\|\s{2}\|/g) ?? []).length;
if (emptyVerdictRows === 0) {
    console.error(`error: ${path} has no empty verdict rows to fill.`);
    process.exit(1);
}
updated = updated.replaceAll("|  |  |", `| ${verdict} ${tag} | — |`);

const fill = (label, value) => {
    const pattern = new RegExp(
        `\\| (${label}[^|]*) \\|\\s*\\|`.replace(/\s+/g, "\\s*")
    );
    if (!pattern.test(updated)) {
        console.error(`error: could not find an empty「${label}」row in ${path}.`);
        process.exit(1);
    }
    updated = updated.replace(pattern, (_match, cell) => `| ${cell.trimEnd()} | ${value} ${tag} |`);
};

fill("batch 채택 여부", `**${verdict}**`);
fill("다양성 판정", diversity);
fill("검수 완료일", reviewedOn);
fill("검수자", reviewer);
fill("초안 구성이 직전 batch와 같은가", setup);

// The drafter row ships with a placeholder rather than an empty cell.
updated = updated.replace(
    /\| (초안 생성자[^|]*) \| \*\(운영자 기입\)\* \|/,
    `| $1 | \`${drafter}\` ${tag} |`
);

writeFileSync(path, updated);
console.log(
    `wrote ${path}: ${emptyVerdictRows} verdict(s) ${verdict}, ` +
        `diversity ${diversity}, setup ${setup}, reviewed ${reviewedOn}`
);
