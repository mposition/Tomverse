#!/usr/bin/env node
// Renders the human-readable view of the Tomverse Chat release-gate registry.
//
// The registry YAML is the source of truth (governance.approvalSystemOfRecord),
// and governance.generatedMarkdownOnly says the readable table must come from
// it. That was a claim with nothing enforcing it: a threshold could be edited
// in a Markdown table and quietly disagree with the registry -- which is the
// same transcription drift that lost gate definitions three times while this
// release was still being planned.
//
// So the view is generated, committed (reviewers read gate changes as prose in
// the PR diff, not as YAML), and `--check` re-renders into memory and compares
// byte for byte. Hand-editing the view or forgetting to regenerate it after a
// registry change both fail the same way.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(repoRoot, 'docs', 'release-gates', 'tomverse-chat-v1.yaml');
const VIEW = path.join(repoRoot, 'docs', 'release-gates', 'tomverse-chat-v1.generated.md');

const checkOnly = process.argv.slice(2).includes('--check');

const OPERATOR_TEXT = { gte: '>=', lte: '<=', eq: '=' };

// Table cells are pipe-delimited; a stray pipe or newline in registry prose
// would silently break the row rather than the build.
const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function renderCriterion(criterion) {
  const operator = OPERATOR_TEXT[criterion.operator] ?? criterion.operator;
  return `\`${criterion.metric}\` ${operator} ${criterion.value}`;
}

function renderGate(gate) {
  const lines = [];
  lines.push(`#### ${gate.id} -- ${gate.title}`);
  lines.push('');
  lines.push(`- Owner: ${gate.owner}`);
  lines.push(`- Blocking: ${gate.blocking ? 'yes' : 'no'}`);
  if (gate.appliesWhen) lines.push(`- Applies when: \`${gate.appliesWhen}\``);
  lines.push(`- Status: ${gate.status}`);

  const approvals = (gate.approvedBy ?? []).map((entry) => `${entry.subject} (${entry.role})`);
  lines.push(`- Approved by: ${approvals.length > 0 ? approvals.join(', ') : 'not yet approved'}`);
  lines.push(`- Approved at: ${gate.approvedAt ?? 'not yet approved'}`);
  lines.push('');
  lines.push(`Why this gate exists: ${cell(gate.rationale)}`);
  lines.push('');
  lines.push('Criteria:');
  lines.push('');
  for (const criterion of gate.criteria) {
    lines.push(`- ${renderCriterion(criterion)}`);
    if (criterion.denominator) lines.push(`  - Denominator: ${cell(criterion.denominator)}`);
    if (criterion.measurementWindow) lines.push(`  - Measurement window: ${criterion.measurementWindow}`);
  }
  lines.push('');
  lines.push('Required evidence:');
  lines.push('');
  for (const item of gate.evidence) lines.push(`- ${cell(item)}`);

  const refs = gate.evidenceRefs ?? [];
  lines.push('');
  lines.push(`Evidence references: ${refs.length > 0 ? refs.map((r) => `\`${cell(r)}\``).join(', ') : 'none recorded'}`);
  return lines.join('\n');
}

function render(doc, sourceRelativePath) {
  const { metadata, governance, ownerRoles, gates } = doc;
  const blocking = gates.filter((gate) => gate.blocking);
  const conditional = gates.filter((gate) => gate.appliesWhen);

  const out = [];
  out.push('<!--');
  out.push('  GENERATED FILE -- DO NOT EDIT.');
  out.push(`  Source: ${sourceRelativePath}`);
  out.push('  Regenerate: npm run generate:tomverse-chat-release-gate-view');
  out.push('  CI check:   npm run check:tomverse-chat-release-gate-view');
  out.push('  Thresholds change only in the registry YAML, never here.');
  out.push('-->');
  out.push('');
  out.push(`# ${metadata.product} ${metadata.release} release gates`);
  out.push('');
  out.push(`- Registry status: ${metadata.status}`);
  out.push(`- Registry last updated: ${metadata.lastUpdated}`);
  out.push(`- Gates: ${gates.length} total, ${blocking.length} blocking, ${conditional.length} conditional`);
  out.push(`- Threshold changes require: ${governance.thresholdChangeRequires.join(', ')}`);
  out.push(`- Validator: \`${governance.validatorCommand}\``);
  out.push('');
  out.push(cell(governance.description));
  out.push('');

  out.push('## Owner roles');
  out.push('');
  out.push('| Role | Scope |');
  out.push('| --- | --- |');
  for (const [role, scope] of Object.entries(ownerRoles)) {
    out.push(`| \`${role}\` | ${cell(scope)} |`);
  }
  out.push('');

  out.push('## Threshold summary');
  out.push('');
  out.push('| Gate | Title | Owner | Blocking | Criteria | Status |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const gate of gates) {
    const criteria = gate.criteria.map(renderCriterion).join('; ');
    const applies = gate.appliesWhen ? `yes (when \`${gate.appliesWhen}\`)` : gate.blocking ? 'yes' : 'no';
    out.push(`| \`${gate.id}\` | ${cell(gate.title)} | ${gate.owner} | ${applies} | ${criteria} | ${gate.status} |`);
  }
  out.push('');

  out.push('## Release-mode approval rules');
  out.push('');
  for (const rule of governance.approvalPolicy.releaseModeRules) out.push(`- ${cell(rule)}`);
  if (governance.approvalPolicy.independentReviewerRule) {
    out.push(`- ${cell(governance.approvalPolicy.independentReviewerRule)}`);
  }
  out.push('');

  out.push('## Gate detail');
  out.push('');
  const categories = [...new Set(gates.map((gate) => gate.category))];
  for (const category of categories) {
    out.push(`### Category: ${category}`);
    out.push('');
    for (const gate of gates.filter((g) => g.category === category)) {
      out.push(renderGate(gate));
      out.push('');
    }
  }

  return `${out.join('\n').trimEnd()}\n`;
}

let doc;
try {
  doc = parse(readFileSync(REGISTRY, 'utf8'));
} catch (cause) {
  console.error(`FAIL cannot read registry ${path.relative(repoRoot, REGISTRY)}: ${cause.message}`);
  process.exit(1);
}

const rendered = render(doc, path.relative(repoRoot, REGISTRY).split(path.sep).join('/'));
const viewRelative = path.relative(repoRoot, VIEW).split(path.sep).join('/');

if (!checkOnly) {
  writeFileSync(VIEW, rendered, 'utf8');
  console.log(`Wrote ${viewRelative} (${doc.gates.length} gates)`);
  process.exit(0);
}

let onDisk;
try {
  onDisk = readFileSync(VIEW, 'utf8');
} catch {
  console.error(`FAIL ${viewRelative} is missing. Run: npm run generate:tomverse-chat-release-gate-view`);
  process.exit(1);
}

if (onDisk !== rendered) {
  console.error(
    `FAIL ${viewRelative} does not match the registry.\n` +
    '  Either the generated view was hand-edited, or the registry changed without regenerating it.\n' +
    '  Thresholds are owned by docs/release-gates/tomverse-chat-v1.yaml -- edit there, then run:\n' +
    '    npm run generate:tomverse-chat-release-gate-view',
  );
  process.exit(1);
}

console.log(`OK ${viewRelative} matches the registry (${doc.gates.length} gates)`);
