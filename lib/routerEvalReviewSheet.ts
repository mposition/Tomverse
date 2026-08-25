/**
 * The batch review sheet a person judges Router evaluation candidates from.
 *
 * Modelled on `docs/ops/memory-extraction-eval-batches/batch-001-durable-facts-ko.md`,
 * and on the one property that sheet has which matters more than its layout:
 * **the reviewer opens one file.** A sheet that says "see the JSON for the
 * prompts" is a sheet that gets reviewed by skimming, and a skimmed review is
 * how a drafter's systematic flaw gets adopted 210 times.
 *
 * What the sheet is allowed to decide: nothing. It carries the machine checks
 * that were already run, ranks where to look for template reuse, and leaves a
 * verdict column empty. Adoption is reserved for a person by
 * docs/ops/tomverse-chat-router-evaluation-set.md §8, §11, so this file never
 * writes a verdict and the generator never sets `status: adopted`.
 *
 * Pure: it takes a set and a batch id and returns Markdown. The script reads
 * and writes the files.
 */

import {
  CELL_LANGUAGES,
  UNRECORDED_PROVENANCE,
  type EvalSet,
  type EvalSetItem,
} from "./routerQualityEvalSet.ts";
import { rankNearDuplicates, type NearDuplicatePairing } from "./nearDuplicateText.ts";

export type ReviewSheetInput = {
  set: EvalSet;
  batchId: string;
  /**
   * Every item already in the corpus, batch included.
   *
   * The near-duplicate ranking runs over this rather than over the batch
   * alone. A drafter that reuses a template across two batches produces two
   * batches that each look varied and a corpus that repeats itself, and a
   * within-batch comparison cannot see it.
   */
  corpus: readonly EvalSetItem[];
  /** How many near-duplicate pairs to list. Advisory, so a shortlist. */
  nearDuplicateLimit?: number;
};

const cellKey = (item: EvalSetItem) => `${item.stratum}/${item.cell}`;

/** Exact repeats: the same prompt text twice, whatever the ids say. */
export const duplicatePrompts = (
  items: readonly EvalSetItem[]
): readonly { prompt: string; ids: readonly string[] }[] => {
  const byPrompt = new Map<string, string[]>();
  for (const item of items) {
    const key = item.prompt.normalize("NFC").trim().toLowerCase();
    byPrompt.set(key, [...(byPrompt.get(key) ?? []), item.id]);
  }
  return [...byPrompt.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([prompt, ids]) => ({ prompt, ids }));
};

export const batchItems = (set: EvalSet, batchId: string): readonly EvalSetItem[] =>
  set.items.filter((item) => item.draftProvenance?.batchId === batchId);

/**
 * Near-duplicate pairs touching this batch, ranked over the whole corpus.
 *
 * Pairs entirely outside the batch are dropped after ranking, not before: the
 * reviewer of batch 007 is not being asked to re-judge batches 001 to 006, but
 * a batch-007 item that repeats a batch-003 item is exactly what they need to
 * see.
 */
export const batchNearDuplicates = (
  input: ReviewSheetInput
): readonly NearDuplicatePairing[] => {
  const inBatch = new Set(batchItems(input.set, input.batchId).map((item) => item.id));
  return rankNearDuplicates(
    input.corpus.map((item) => ({
      id: item.id,
      cell: cellKey(item),
      segments: [item.prompt],
    }))
  )
    .filter((pair) => inBatch.has(pair.a) || inBatch.has(pair.b))
    .slice(0, input.nearDuplicateLimit ?? 10);
};

const escapeCell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");

const quoted = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

export function renderReviewSheet(input: ReviewSheetInput): string {
  const items = batchItems(input.set, input.batchId);
  if (items.length === 0) {
    throw new Error(
      `No item in ${input.set.version} carries draftProvenance.batchId "${input.batchId}".`
    );
  }

  const cells = [...new Set(items.map(cellKey))];
  const provenance = items[0].draftProvenance;
  const duplicates = duplicatePrompts(input.corpus);
  const batchIds = new Set(items.map((item) => item.id));
  const duplicatesTouchingBatch = duplicates.filter((entry) =>
    entry.ids.some((id) => batchIds.has(id))
  );
  const languageMismatches = items.filter((item) => {
    const expected = CELL_LANGUAGES[item.cell];
    return (
      !expected ||
      item.language?.prompt !== expected.prompt ||
      item.language?.expectedResponse !== expected.expectedResponse
    );
  });
  const adopted = items.filter((item) => item.status === "adopted");
  const nearDuplicates = batchNearDuplicates(input);
  const drafterIsRoutableFamily =
    provenance !== undefined && provenance.provider !== UNRECORDED_PROVENANCE;

  const lines: string[] = [];

  lines.push(`# ${input.batchId} — \`${cells.join("`, `")}\` 검수 시트`);
  lines.push("");
  lines.push(
    `> **자동 생성 파일입니다.** \`npm run make:router-eval-review-sheet -- --batch=${input.batchId}\``
  );
  lines.push(
    "> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다."
  );
  lines.push("");
  lines.push("## 당신이 해야 하는 일");
  lines.push("");
  lines.push(
    `**후보 ${items.length}건 판정 + batch 채택 결정 1건.** 그게 전부입니다.`
  );
  lines.push("");
  lines.push(
    "아래 §후보에 prompt 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**"
  );
  lines.push("");
  lines.push(
    "판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **「수정 후 채택」은 없습니다** — "
  );
  lines.push(
    "반려된 prompt는 고쳐서 채택하지 않고 **새 id로 다시 씁니다**. 그래야 반려 기록이 실제로"
  );
  lines.push("반려된 것을 계속 가리킵니다.");
  lines.push("");
  lines.push(
    "채택은 이 시트로 확정되지 않습니다. `status: adopted`와 `adoptedBy`·`adoptedAt`은 사람이"
  );
  lines.push(
    "기입하는 값이고, 에이전트 산출물은 어떤 경우에도 `status: candidate`입니다."
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 초안 출처");
  lines.push("");
  if (provenance) {
    lines.push("| 항목 | 값 |");
    lines.push("|---|---|");
    lines.push(`| provider | \`${escapeCell(provenance.provider)}\` |`);
    lines.push(`| modelId (Tomverse) | \`${escapeCell(provenance.modelId)}\` |`);
    lines.push(
      `| 요청한 api model | \`${escapeCell(provenance.requestedApiModel ?? "기록 없음")}\`` +
        `${/latest$/.test(provenance.requestedApiModel ?? "") ? " — **이동형 별칭**" : ""} |`
    );
    lines.push(
      `| 응답이 밝힌 version | ${provenance.modelVersion ? `\`${escapeCell(provenance.modelVersion)}\`` : "*제공자가 반환하지 않음 — 추측하지 않았습니다*"} |`
    );
    lines.push(
      `| 생성 파라미터 | \`${escapeCell(JSON.stringify(provenance.generationParameters ?? {}))}\` |`
    );
    lines.push(
      `| promptTemplate | \`${escapeCell(provenance.promptTemplateVersion)}\` (\`${escapeCell(provenance.promptTemplateHash)}\`) |`
    );
    lines.push(
      `| generatorCommit | ${provenance.generatorCommit ? `\`${escapeCell(provenance.generatorCommit)}\`` : "*기록 없음*"} |`
    );
    lines.push(`| draftedAt | ${escapeCell(provenance.draftedAt)} |`);
    lines.push("");
  }
  if (/latest$/.test(provenance?.requestedApiModel ?? "")) {
    lines.push(
      "> **요청한 이름이 이동형 별칭입니다.** 제공자가 이 별칭 뒤의 모델을 바꿀 수 있으므로,"
    );
    lines.push(
      "> 같은 wave의 ko·en batch가 서로 다른 version에서 나왔을 수 있습니다. 그렇다면 두 언어의"
    );
    lines.push(
      "> 차이로 읽히는 것이 실은 두 모델의 차이일 수 있습니다. 위 「응답이 밝힌 version」을 wave의"
    );
    lines.push("> 다른 batch와 대조해 주세요.");
    lines.push("");
  }
  if (!drafterIsRoutableFamily) {
    lines.push(
      "> **이 batch의 초안 생성자를 재구성할 수 없습니다.** provider가 `unrecorded`입니다."
    );
    lines.push(
      "> 절차 문서는 초안 생성 모델을 검수자가 저울질해야 할 교란 요인으로 규정하는데,"
    );
    lines.push(
      "> 이 항목들은 그 저울질을 할 수 없습니다. 그 사유만으로 반려하셔도 됩니다."
    );
    lines.push("");
  }
  lines.push(
    "*\"A set drafted by a routable model measures how well that model handles its own"
  );
  lines.push(
    "phrasing.\"* 초안 모델과 같은 계열이 라우팅 후보에 있다면, 그 계열에 유리한 문체·문제"
  );
  lines.push("구성이 아닌지 특히 보아 주세요.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 자동 검사 — 에이전트가 이미 돌렸습니다");
  lines.push("");
  lines.push(
    "형식 요건은 전부 기계로 확인했습니다. 검수자는 **좋은 prompt인가**만 보시면 됩니다."
  );
  lines.push("");
  lines.push("| 검사 | 범위 | 결과 |");
  lines.push("|---|---|---|");
  lines.push(
    `| exact duplicate prompt | corpus 전체 ${input.corpus.length}건 | ${duplicatesTouchingBatch.length === 0 ? "0건" : `**${duplicatesTouchingBatch.length}건 — 아래 참조**`} |`
  );
  lines.push(
    `| cell ↔ language 정합성 | batch ${items.length}건 | ${languageMismatches.length === 0 ? "전건 통과" : `**${languageMismatches.length}건 불일치**`} |`
  );
  lines.push(
    `| status: candidate | batch ${items.length}건 | ${adopted.length === 0 ? "전건 candidate" : `**${adopted.length}건이 이미 adopted — 에이전트가 채택했다면 규칙 위반**`} |`
  );
  lines.push("");
  if (duplicatesTouchingBatch.length > 0) {
    for (const entry of duplicatesTouchingBatch) {
      lines.push(`- 동일 prompt: ${entry.ids.map((id) => `\`${id}\``).join(", ")}`);
    }
    lines.push("");
  }
  lines.push(
    `### near-duplicate 상위 ${nearDuplicates.length}쌍 (corpus ${input.corpus.length}건 대상)`
  );
  lines.push("");
  lines.push(
    "**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다."
  );
  lines.push(
    "같은 cell 안에서만 비교합니다 — 다른 cell은 다르라고 나눠 놓은 것이라 유사도가 낮은 게"
  );
  lines.push("당연하고, 그 값은 아무것도 말해주지 않습니다."
  );
  lines.push("");
  lines.push(
    "**이 batch 안에서만이 아니라 이미 쌓인 corpus 전체와 비교했습니다.** batch마다 따로 보면"
  );
  lines.push("각 batch는 다양해 보이는데 corpus는 같은 틀을 반복하는 상태를 놓칩니다.");
  lines.push("");
  if (nearDuplicates.length === 0) {
    lines.push("비교할 쌍이 없습니다 (이 cell에 다른 항목이 아직 없습니다).");
  } else {
    lines.push("| token | shape | 쌍 | cell |");
    lines.push("|---|---|---|---|");
    for (const pair of nearDuplicates) {
      lines.push(
        `| ${pair.token.toFixed(2)} | ${pair.shape.toFixed(2)} | \`${pair.a}\` ~ \`${pair.b}\` | ${escapeCell(pair.cell)} |`
      );
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`## 후보 — 판정할 ${items.length}건`);
  lines.push("");

  for (const item of items) {
    lines.push(`### ${item.id}`);
    lines.push("");
    const facts = [
      `\`${item.stratum}/${item.cell}\``,
      `prompt \`${item.language?.prompt ?? "?"}\` → answer \`${item.language?.expectedResponse ?? "?"}\``,
      `source \`${item.source}\``,
    ];
    if (item.webSearchRequested) facts.push("**웹 검색 필요**");
    if (item.attachments?.length) {
      facts.push(
        `첨부 ${item.attachments.map((attachment) => `\`${attachment.mediaType}\``).join(", ")}`
      );
    }
    if (item.replaces) facts.push(`\`${item.replaces}\` 대체`);
    lines.push(facts.join(" · "));
    lines.push("");
    lines.push(quoted(item.prompt));
    lines.push("");
    if (item.notes) {
      lines.push(`*초안 메모: ${item.notes}*`);
      lines.push("");
    }
    lines.push("**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->");
    lines.push("");
    lines.push("**사유**: <!-- 반려일 때만 -->");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## batch 채택 결정");
  lines.push("");
  lines.push(
    "**20%를 보고 아무 말도 하지 않는 것은 채택이 아닙니다.** 판정을 채우신 뒤 아래를 기입해 주세요."
  );
  lines.push("");
  lines.push("| 항목 | 값 |");
  lines.push("|---|---|");
  lines.push("| 검수자 | |");
  lines.push("| 검수일 | |");
  lines.push("| 채택 건수 | |");
  lines.push("| 반려 건수 | |");
  lines.push("| batch 결정 | <!-- 채택 / 전건 재검수 / 폐기 --> |");
  lines.push("");
  lines.push(
    `반려가 나오면 그 항목은 새 id로 다시 씁니다. cell 목표는 **채택본** 기준이므로, 반려분은`
  );
  lines.push("목표 수에 포함되지 않습니다.");
  lines.push("");

  return lines.join("\n");
}
