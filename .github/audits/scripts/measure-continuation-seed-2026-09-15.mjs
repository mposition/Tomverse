// Read-only synthetic diagnostic. No database, network, provider, or file writes.
// Loads the selected checkout's actual pure functions using Node's TS stripper;
// only the seed core's module specifier is redirected to that checkout's estimator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (process.argv.length !== 3) throw new Error('Supply one source checkout path.');
const sourceRoot = resolve(process.argv[2]);
const sourcePaths = {
  estimator: 'lib/chatTokenEstimate.ts',
  core: 'lib/externalContinuationSeedCore.ts',
  prompt: 'lib/externalContinuationSeedPrompt.ts',
};
const raw = Object.fromEntries(Object.entries(sourcePaths).map(([key, path]) =>
  [key, readFileSync(join(sourceRoot, path), 'utf8')]));
const asModuleUrl = (source) => 'data:text/javascript;base64,' +
  Buffer.from(stripTypeScriptTypes(source, { mode: 'strip' })).toString('base64');
const estimatorUrl = asModuleUrl(raw.estimator);
const coreSpecifier = '"@/lib/chatTokenEstimate"';
assert.equal(raw.core.split(coreSpecifier).length, 2, 'Expected one estimator import');
const estimator = await import(estimatorUrl);
const core = await import(asModuleUrl(raw.core.replace(coreSpecifier, JSON.stringify(estimatorUrl))));
const prompt = await import(asModuleUrl(raw.prompt));
assert.equal(core.CONTINUATION_SEED_TOKEN_BUDGET, 3000);
assert.equal(core.CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT, 4000);
assert.equal(estimator.ACTIVE_ESTIMATOR_VERSION, 'generic_multilingual_v1');

const msg = (ordinal, role, content) => ({ ordinal, role, content, truncated: false });
const single = (content) => [msg(1, 'assistant', content)];
const exchanges = (character) => Array.from({ length: 20 }, (_, index) =>
  msg(index + 1, index % 2 === 0 ? 'user' : 'assistant',
    character.repeat(index % 2 === 0 ? 150 : 1200)));
const cases = [
  { id: 'hangul_2000', messages: single('가'.repeat(2000)), expected: 1 },
  { id: 'hangul_2001', messages: single('가'.repeat(2001)), expected: 0 },
  { id: 'hangul_4001', messages: single('가'.repeat(4001)), expected: 0 },
  { id: 'ascii_4001', messages: single('a'.repeat(4001)), expected: 1 },
  { id: 'hangul_10_exchanges_150_1200', messages: exchanges('가'), expected: 2 },
  { id: 'ascii_10_exchanges_150_1200', messages: exchanges('a'), expected: 16 },
  { id: 'newest_hangul_oversized_older_short', messages: [
    msg(1, 'user', '이전 질문'), msg(2, 'assistant', '가'.repeat(2001))], expected: 0 },
  { id: 'older_hangul_oversized_newest_short', messages: [
    msg(1, 'user', '짧은 질문'), msg(2, 'assistant', '가'.repeat(2001)),
    msg(3, 'user', '계속 설명해 주세요')], expected: 1 },
  { id: 'blank_only', messages: single('   \n'), expected: 0 },
  { id: 'excluded_role_only', messages: [msg(1, 'tool', 'data')], expected: 0 },
];
const evaluate = (entry, tokenBudget = 3000) => {
  const plan = core.planContinuationSeed({ messages: entry.messages, tokenBudget });
  const rendered = prompt.buildContinuationSeedPrompt({
    provider: 'chatgpt', importedAt: '2026-09-15T00:00:00.000Z', plan,
  });
  assert.equal(rendered.usedTurnCount, plan.turns.length);
  assert.equal(rendered.transcriptText === null, plan.turns.length === 0);
  assert.ok(plan.estimatedTokens <= tokenBudget);
  return {
    id: entry.id, tokenBudget,
    inputMessages: entry.messages.length,
    selectedMessages: plan.turns.length,
    selectedOrdinals: plan.turns.map((turn) => turn.ordinal),
    selectedCodePoints: plan.turns.reduce((sum, turn) => sum + [...turn.text].length, 0),
    estimatedSourceTokens: plan.estimatedTokens,
    estimatedRenderedSeedTokens: estimator.estimateTextTokens(rendered.rulesText ?? '') +
      estimator.estimateTextTokens(rendered.transcriptText ?? ''),
    omittedByBudgetCount: plan.omittedByBudgetCount,
    excludedByRoleCount: plan.excludedByRoleCount,
    truncatedCount: plan.truncatedCount,
    empty: plan.turns.length === 0,
  };
};
const baseline = cases.map((entry) => {
  const result = evaluate(entry);
  assert.equal(result.selectedMessages, entry.expected, entry.id);
  return result;
});
// A parameter sweep, not a change to the source constant or a proposed rollout.
const budgetSweep = [6000, 8000].flatMap((budget) =>
  cases.filter((entry) => ['hangul_4001', 'hangul_10_exchanges_150_1200',
    'ascii_10_exchanges_150_1200'].includes(entry.id)).map((entry) => evaluate(entry, budget)));
console.log(JSON.stringify({
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
  nodeVersion: process.version,
  sourceHashes: Object.fromEntries(Object.entries(sourcePaths).map(([key, path]) =>
    [path, createHash('sha256').update(raw[key]).digest('hex')])),
  scope: 'Synthetic estimator/selection cases only; not production prevalence, semantic quality, or actual provider tokens.',
  paidTurns: 0,
  baseline,
  budgetSweep,
}, null, 2));
