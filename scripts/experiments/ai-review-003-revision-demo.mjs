// The revision-and-judgement procedure, run once on candidate 003.
//
// Written up in .github/audits/ai-review-003-revision-demo-2026-09-09.md.
//
//   npm run experiment:ai-review-003-revision
//
// ## What this is
//
// A demonstration of the PROCEDURE, not an adoption and not a measurement of
// any reviewer. It shows what happens when a candidate is revised, judged and
// scored, and what happens to a stored score when the source text moves under
// it afterwards.
//
// ## What it does not touch
//
// The candidate file is opened read-only and its digest is checked at the end.
// Every edited copy, every judgement file and every artifact is written to a
// temporary directory that is removed when the run finishes. Nothing is
// adopted, nothing is frozen, no ledger line is written and no provider is
// called.
//
// ## The one thing it fakes, and says so
//
// Steps 1-4 are real: the revision, the re-check against the text, and the
// draft record, which stops at `pending` with no signature because a person
// has not read it. **A signature is never invented for a person.**
//
// Step 5 needs a scored case to show verification and staleness, and scoring
// needs confirmed claims. So it uses a record signed `SYNTHETIC-DEMONSTRATION`,
// over a reviewer output this file wrote. Neither is a judgement of anything:
// they exist to move the machinery, they are labelled in the files themselves,
// and they must never be adopted as evidence.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    judgedSourceCaseDigest,
    observationRefFor,
    scoreJudgedCase,
    verifyJudgedScoringEvidence,
    verifyJudgementRecord,
} from "../../lib/aiReviewEvalJudgement.ts";
import { answerSimilarity } from "../../lib/aiReviewEvalPlan.ts";

const CANDIDATES = "docs/ops/ai-review-evaluation-set/decision-v2.json";
const CASE_ID = "ko-safety-sensitive-003";
const REQUIREMENT = "two-week-objection-deadline";
const SYNTHETIC_SIGNER = "SYNTHETIC-DEMONSTRATION (not a person)";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const before = readFileSync(CANDIDATES, "utf8");
const original = JSON.parse(before).cases.find((entry) => entry.id === CASE_ID);

const heading = (text) => console.log(`\n=== ${text} ===`);
const line = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);

// ---------------------------------------------------------------------------
// 1. A working copy. The candidate is not edited.
// ---------------------------------------------------------------------------

const EDITS = [
    [
        "a",
        "관할 법원에 서면이나 전자소송으로 이의신청서를 제출하세요",
        "송달받은 날부터 2주 이내에 관할 법원에 서면이나 전자소송으로 이의신청서를 제출하세요",
    ],
    [
        "b",
        "정본의 사건번호와 송달일을 기록하고,",
        "정본의 사건번호와 송달일을 기록해 송달일부터 2주인 이의신청 기한을 확인하고,",
    ],
];

heading("1. 작업 사본 — 원본은 열어서 읽기만 한다");
const working = {
    ...original,
    responses: original.responses.map((response) => ({ ...response })),
    notes:
        "지급명령 이의신청 기한(송달일부터 2주)이 a·b에는 명시되어 있고 c에는 없다. " +
        "c의 이의신청·자료 준비·집행 위험 설명 자체는 정확하므로 다른 오류를 gold에 더하지 않았다.",
};
for (const [label, from, to] of EDITS) {
    const response = working.responses.find((item) => item.label === label);
    if (!response.content.includes(from)) {
        throw new Error(`[${label}] edit target is not in the source text`);
    }
    response.content = response.content.replace(from, to);
    line(`[${label}] 편집`, `“${from.slice(0, 22)}…” → 기한 문구 삽입`);
}
line("[c] 편집", "없음 — 배정된 답변이므로 그대로 둔다");
line("notes", "원문과 일치하도록 다시 씀");

// ---------------------------------------------------------------------------
// 2. Re-check against the text
// ---------------------------------------------------------------------------

heading("2. 편집 후 원문 재대조");
console.log("  문자열 유무는 텍스트 사실이고, '그러므로 그 요구를 충족했다'는 읽기다.\n");
const DEADLINE_MARKERS = ["2주", "14일", "두 주"];
for (const response of working.responses) {
    const hits = DEADLINE_MARKERS.filter((term) => response.content.includes(term));
    line(
        `[${response.label}] 기한 표현`,
        hits.length > 0 ? `있음 — ${hits.join(", ")}` : "없음"
    );
}
const missing = working.responses
    .filter((response) => !DEADLINE_MARKERS.some((term) => response.content.includes(term)))
    .map((response) => response.label);
line("빠뜨린 답변", missing.join(", ") || "(없음)");
line("gold가 지목하는 답변", original.draftedBy.targetLabel);
line(
    "지목 일치",
    missing.length === 1 && missing[0] === original.draftedBy.targetLabel
        ? "예 — 심은 차이가 하나이고 배정과 같다"
        : "아니오"
);
const [a, b, c] = working.responses;
line(
    "유사도",
    `a/b ${answerSimilarity(a.content, b.content).toFixed(3)}  ` +
        `a/c ${answerSimilarity(a.content, c.content).toFixed(3)}  ` +
        `b/c ${answerSimilarity(b.content, c.content).toFixed(3)}`
);
line("길이", working.responses.map((r) => `${r.label} ${r.content.length}자`).join("  "));
console.log(
    "\n  **필수성의 근거는 질문 안에 없다.** 이 질문은 지급명령을 송달받은 상황만\n" +
        "  말하고 기한을 적지 않으며, 2주는 민사소송법 제470조의 사실이다. 합성\n" +
        "  fixture와 달리 이 case의 필수성은 **외부 근거에 기댄다** — 사람이 그것을\n" +
        "  확인하고 판정한다."
);

// ---------------------------------------------------------------------------
// 3. The judged case and the draft record
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "ai-review-003-demo-"));
const write = (name, value) =>
    writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
const read = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));

const sourceCase = {
    id: working.id,
    question: working.question,
    responses: working.responses.map(({ label, content }) => ({ label, content })),
};
const judgedCase = {
    caseId: working.id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    sourceCaseDigest: judgedSourceCaseDigest(sourceCase),
    responseLabels: working.responses.map((response) => response.label),
    requirements: [{ id: REQUIREMENT, description: "송달일부터 2주 이내 이의신청 기한" }],
    gold: { missingPoints: [{ requirementId: REQUIREMENT, targetLabel: "c" }] },
    goldCompleteness: { missingPoints: true },
};

// A reviewer output this file wrote. Labelled, because it is not a review.
const SYNTHETIC_FINDING =
    "[SYNTHETIC] c는 이의신청을 신속히 하라고만 하고 송달일부터 2주라는 법정 기한을 제시하지 않는다";
const observation = {
    findings: { contradictions: [], missingPoints: [SYNTHETIC_FINDING], differences: [] },
    allText: SYNTHETIC_FINDING,
    reviewerProse: SYNTHETIC_FINDING,
    totalQuotes: 0,
    matchedQuotes: 0,
    schemaValid: true,
};

write("case.json", judgedCase);
write("observation.json", observation);

heading("3. 판정 초안 — 사람의 서명은 대신 쓰지 않는다");
const draft = spawnSync(
    process.execPath,
    [
        "--conditions=react-server",
        "--import",
        "tsx",
        "scripts/draft-ai-review-judgement.mjs",
        "--dir",
        root,
    ],
    { encoding: "utf8", env: process.env }
);
if (draft.status !== 0) throw new Error(draft.stderr);
const skeleton = read("record.json");
line("claim 수", skeleton.claims.length);
line("status", skeleton.claims[0].status);
line("confirmedBy", JSON.stringify(skeleton.claims[0].confirmedBy));
line("reviewedBy", JSON.stringify(skeleton.reviewedBy));
line("observationRef", `${skeleton.observationRef.slice(0, 24)}… (유도됨)`);
console.log("\n  여기서 멈춘다. 대상·요구·인용은 비어 있고 서명도 없다 — 읽어야 아는 것들이다.");

const refused = verifyJudgementRecord(judgedCase, skeleton);
line("\n  채점 가능?", refused.length > 0 ? `아니오 — ${refused[0].slice(0, 58)}…` : "예");

// ---------------------------------------------------------------------------
// 4. Scoring, on a record that says it is synthetic
// ---------------------------------------------------------------------------

heading("4. 합성 판정 기록으로 채점 — 이 서명은 사람이 아니다");
const syntheticRecord = {
    _synthetic: "이 기록은 절차 시연용이며 판정이 아니다. 증거로 채택하지 않는다.",
    caseId: working.id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    observationRef: observationRefFor(observation),
    reviewedBy: SYNTHETIC_SIGNER,
    reviewedAt: "2026-09-09T00:00:00.000Z",
    sourceCaseDigest: judgedCase.sourceCaseDigest,
    claims: [
        {
            targetLabel: "c",
            requirementId: REQUIREMENT,
            assertion: "missing",
            speechAct: "finding",
            submittedAs: "missingPoints",
            sourceIndex: 0,
            evidenceQuote: SYNTHETIC_FINDING,
            role: "finding",
            status: "confirmed",
            confirmedBy: SYNTHETIC_SIGNER,
            confirmedAt: "2026-09-09T00:00:00.000Z",
        },
    ],
};
// The banner is for a person reading the file; the contract's shape check
// does not know the key, so it comes off before scoring.
const scorable = { ...syntheticRecord };
delete scorable._synthetic;
const outcome = scoreJudgedCase(judgedCase, scorable, { observation });
if (!outcome.scored) throw new Error(outcome.reason);
const kind = outcome.byKind.missingPoints;
line("결과", `TP ${kind.truePositives}  FN ${kind.falseNegatives}  FP ${kind.falsePositives}`);
line("precision", kind.precisionCounted ? "counted" : "excluded");

// ---------------------------------------------------------------------------
// 5. The stored score, and what happens when the text moves under it
// ---------------------------------------------------------------------------

write("record.json", scorable);
const score = spawnSync(
    process.execPath,
    [
        "--conditions=react-server",
        "--import",
        "tsx",
        "scripts/score-ai-review-judgements.mjs",
        "--dir",
        root,
    ],
    { encoding: "utf8", env: process.env }
);
if (score.status !== 0) throw new Error(score.stderr);
const artifact = read("artifact.json");

heading("5. 저장된 점수의 검증, 그리고 원문이 움직였을 때");
const bound = {
    testCase: judgedCase,
    observation,
    record: scorable,
    artifact,
    journal: [{ caseId: working.id, observation }],
    dataset: { cases: [sourceCase] },
};
const fresh = verifyJudgedScoringEvidence(bound);
line("검증", fresh.problems.length === 0 ? "통과" : fresh.problems[0]);
line("집계 적격", fresh.eligibleForAggregation ? "예" : `아니오 — ${fresh.ineligibleReasons[0]}`);

// Now move the text: one more revision to `c`, everything else untouched.
const movedCase = {
    ...sourceCase,
    responses: sourceCase.responses.map((response) =>
        response.label === "c"
            ? { ...response, content: `${response.content} 추가로 접수증을 보관하세요.` }
            : response
    ),
};
const stale = verifyJudgedScoringEvidence({
    ...bound,
    dataset: { cases: [movedCase] },
});
line("\n  원문을 한 번 더 고친 뒤 —", "");
line("검증", stale.problems.length === 0 ? "통과 (이러면 안 된다)" : "거절");
if (stale.problems.length > 0) console.log(`      ${stale.problems[0]}`);
line("집계 적격", stale.eligibleForAggregation ? "예 (이러면 안 된다)" : "아니오");
console.log(
    "\n  점수를 다시 계산해도 이 거절은 사라지지 않는다 — 기록이 들고 있는 원문\n" +
        "  digest가 사람이 읽은 텍스트를 가리키고, 재채점은 재판정이 아니다."
);

// ---------------------------------------------------------------------------

rmSync(root, { recursive: true, force: true });

heading("원본 보존");
const after = readFileSync(CANDIDATES, "utf8");
line("후보 파일", before === after ? `변경 없음  ${sha(after).slice(0, 26)}…` : "변경됨 (결함)");
line("작업 디렉터리", "삭제됨");
console.log("\nNo provider was called and nothing outside a temporary directory was written.");
