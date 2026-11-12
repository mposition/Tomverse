// Offline: compare the serialized user message only, not provider time or answer quality.
import assert from "node:assert/strict";
import { getEncoding } from "js-tiktoken";
import { autoLlmRouterCandidates, autoLlmRouterUserMessage } from "../lib/autoLlmRouterCore.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";

const tokenizer = getEncoding("o200k_base");
const questions = [
  "오늘 브리즈번 날씨 어때요?",
  "NASA 공식 출처에서 보이저 1호와 2호의 UTC 발사 날짜를 확인하고 어느 쪽이 며칠 먼저 발사됐는지 알려주세요.",
];
const pool = AVAILABLE_MODELS.filter(model => model.enabled !== false && !model.catalogDeleted);
const results = [];
for (const size of [2, 8, 17, 28]) {
  const ids = pool.slice(0, size).map(model => model.id);
  const candidates = autoLlmRouterCandidates(ids, pool, Object.fromEntries(ids.map((id, i) => [id, i + 1])));
  assert.equal(candidates.length, size);
  for (const [i, question] of questions.entries()) {
    const full = autoLlmRouterUserMessage(question, null, candidates);
    const compact = autoLlmRouterUserMessage(question, null, candidates, null, true);
    const decoded = JSON.parse(compact);
    const { columns, rows } = decoded.candidates;
    decoded.candidates = rows.map(row => Object.fromEntries(columns.map((col, index) => [col, row[index]])));
    assert.deepEqual(decoded, JSON.parse(full));
    results.push({ candidates: size, question: ["weather", "NASA"][i],
      originalTokens: tokenizer.encode(full).length, compactTokens: tokenizer.encode(compact).length });
  }
}
console.log(JSON.stringify({ scope: "offline router user-message tokens (o200k_base)", results }, null, 2));
