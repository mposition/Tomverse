#!/usr/bin/env node
// Validates the canonical Tomverse Chat release-gate registry
// (docs/release-gates/tomverse-chat-v1.yaml). The registry is the single
// source of truth for release thresholds (governance.approvalSystemOfRecord),
// so a structurally broken or hand-degraded file must fail the build before
// any prose document can quietly diverge from it.
//
// Draft mode (default) checks structure: required fields, unique IDs, known
// owners, statuses, operators, and criteria shapes. Release mode
// (--release, or metadata.status: release) additionally enforces
// governance.approvalPolicy.releaseModeRules: every applicable blocking gate
// approved, dual approval from distinct people covering both roles, an RFC
// 3339 approvedAt, and non-empty evidenceRefs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY = path.join(repoRoot, 'docs', 'release-gates', 'tomverse-chat-v1.yaml');

const args = process.argv.slice(2);
const releaseFlag = args.includes('--release');
const fileArg = args.find((a) => !a.startsWith('--'));
const registryPath = fileArg ? path.resolve(fileArg) : DEFAULT_REGISTRY;

const ALLOWED_OPERATORS = new Set(['gte', 'lte', 'eq']);
const GATE_ID_PATTERN = /^[A-Z]+-\d{2}$/;
const METRIC_PATTERN = /^[a-z][a-z0-9_]*$/;
// RFC 3339 with an explicit offset; Date.parse alone accepts too much.
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const errors = [];
const where = (gate, message) => errors.push(gate ? `${gate}: ${message}` : message);

let doc;
try {
  doc = parse(readFileSync(registryPath, 'utf8'));
} catch (cause) {
  console.error(`FAIL ${registryPath}\n  unreadable or invalid YAML: ${cause.message}`);
  process.exit(1);
}

if (!doc || typeof doc !== 'object') {
  console.error(`FAIL ${registryPath}\n  registry root must be a mapping`);
  process.exit(1);
}

if (doc.schemaVersion !== 1) where(null, `unsupported schemaVersion ${doc.schemaVersion}`);

const metadata = doc.metadata ?? {};
for (const field of ['product', 'release', 'lastUpdated']) {
  if (!metadata[field]) where(null, `metadata.${field} is missing`);
}
if (!['draft', 'release'].includes(metadata.status)) {
  where(null, `metadata.status must be draft or release, got ${JSON.stringify(metadata.status)}`);
}
if (metadata.sourceOfTruth !== true) where(null, 'metadata.sourceOfTruth must be true');

const governance = doc.governance ?? {};
const requiredFields = governance.requiredFields;
if (!Array.isArray(requiredFields) || requiredFields.length === 0) {
  where(null, 'governance.requiredFields must be a non-empty list');
}
const approvalPolicy = governance.approvalPolicy ?? {};
const allowedStatuses = new Set(approvalPolicy.allowedStatuses ?? []);
if (allowedStatuses.size === 0) {
  where(null, 'governance.approvalPolicy.allowedStatuses must be a non-empty list');
}
const approverRoles = new Set(approvalPolicy.approvedByEntrySchema?.roles ?? []);
if (!approverRoles.has('gate-owner') || !approverRoles.has('independent-reviewer')) {
  where(null, 'approvedByEntrySchema.roles must include gate-owner and independent-reviewer');
}

const ownerRoles = new Set(Object.keys(doc.ownerRoles ?? {}));
if (ownerRoles.size === 0) where(null, 'ownerRoles must define at least one owner');

const gates = doc.gates;
if (!Array.isArray(gates) || gates.length === 0) {
  where(null, 'gates must be a non-empty list');
}

const releaseMode = releaseFlag || metadata.status === 'release';
const seenIds = new Set();

for (const [index, gate] of (gates ?? []).entries()) {
  const label = gate?.id ?? `gates[${index}]`;

  if (!gate || typeof gate !== 'object') {
    where(label, 'gate entry must be a mapping');
    continue;
  }

  for (const field of requiredFields ?? []) {
    if (!(field in gate)) where(label, `missing required field "${field}"`);
  }

  if (typeof gate.id !== 'string' || !GATE_ID_PATTERN.test(gate.id)) {
    where(label, `id must match ${GATE_ID_PATTERN}`);
  } else if (seenIds.has(gate.id)) {
    where(label, 'duplicate gate id');
  } else {
    seenIds.add(gate.id);
  }

  if (typeof gate.blocking !== 'boolean') where(label, 'blocking must be a boolean');
  if (!ownerRoles.has(gate.owner)) where(label, `owner "${gate.owner}" is not in ownerRoles`);
  if (!allowedStatuses.has(gate.status)) where(label, `status "${gate.status}" is not an allowed status`);
  if (typeof gate.rationale !== 'string' || gate.rationale.trim().length < 20) {
    where(label, 'rationale must state the original intent (min 20 chars)');
  }

  if (!Array.isArray(gate.criteria) || gate.criteria.length === 0) {
    where(label, 'criteria must be a non-empty list');
  } else {
    for (const [ci, criterion] of gate.criteria.entries()) {
      if (!criterion || typeof criterion !== 'object') {
        where(label, `criteria[${ci}] must be a mapping`);
        continue;
      }
      if (typeof criterion.metric !== 'string' || !METRIC_PATTERN.test(criterion.metric)) {
        where(label, `criteria[${ci}].metric must be a snake_case identifier`);
      }
      if (!ALLOWED_OPERATORS.has(criterion.operator)) {
        where(label, `criteria[${ci}].operator "${criterion.operator}" is not one of ${[...ALLOWED_OPERATORS].join('/')}`);
      }
      if (typeof criterion.value !== 'number' || Number.isNaN(criterion.value)) {
        where(label, `criteria[${ci}].value must be a number`);
      }
    }
  }

  if (!Array.isArray(gate.evidence) || gate.evidence.length === 0 ||
      gate.evidence.some((e) => typeof e !== 'string' || e.trim() === '')) {
    where(label, 'evidence must be a non-empty list of strings');
  }

  if ('appliesWhen' in gate && (typeof gate.appliesWhen !== 'string' || gate.appliesWhen.trim() === '')) {
    where(label, 'appliesWhen, when present, must be a non-empty string');
  }
  if (gate.status === 'not-applicable' && !gate.appliesWhen) {
    where(label, 'status not-applicable requires an appliesWhen condition');
  }

  if (!Array.isArray(gate.approvedBy)) {
    where(label, 'approvedBy must be a list');
  } else {
    for (const [ai, entry] of gate.approvedBy.entries()) {
      if (!entry || typeof entry !== 'object' || typeof entry.subject !== 'string' || entry.subject.trim() === '') {
        where(label, `approvedBy[${ai}] must have a non-empty subject`);
        continue;
      }
      if (!approverRoles.has(entry.role)) {
        where(label, `approvedBy[${ai}].role "${entry.role}" is not an allowed role`);
      }
    }
  }

  if (gate.approvedAt !== null && (typeof gate.approvedAt !== 'string' || !RFC3339_PATTERN.test(gate.approvedAt))) {
    where(label, 'approvedAt must be null or an RFC 3339 timestamp');
  }
  if (!Array.isArray(gate.evidenceRefs)) where(label, 'evidenceRefs must be a list');

  if (releaseMode && gate.blocking === true) {
    if (gate.status === 'not-applicable') {
      const hasIndependent = (gate.approvedBy ?? []).some((e) => e?.role === 'independent-reviewer');
      if (!hasIndependent) where(label, 'release mode: not-applicable requires an independent-reviewer approval');
      if (!Array.isArray(gate.evidenceRefs) || gate.evidenceRefs.length === 0) {
        where(label, 'release mode: not-applicable requires an applicability evidence reference');
      }
      continue;
    }
    if (gate.status !== 'approved') {
      where(label, `release mode: blocking gate must be approved or not-applicable, got "${gate.status}"`);
      continue;
    }
    const owners = (gate.approvedBy ?? []).filter((e) => e?.role === 'gate-owner');
    const reviewers = (gate.approvedBy ?? []).filter((e) => e?.role === 'independent-reviewer');
    if (owners.length === 0) where(label, 'release mode: missing gate-owner approval');
    if (reviewers.length === 0) where(label, 'release mode: missing independent-reviewer approval');
    if (owners.some((o) => reviewers.some((r) => r.subject === o.subject))) {
      where(label, 'release mode: gate-owner and independent-reviewer must be different people');
    }
    if (gate.approvedAt === null) where(label, 'release mode: approvedAt must be set');
    if (!Array.isArray(gate.evidenceRefs) || gate.evidenceRefs.length === 0) {
      where(label, 'release mode: evidenceRefs must be non-empty');
    }
  }
}

if (errors.length > 0) {
  console.error(`FAIL ${path.relative(repoRoot, registryPath)} (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  `OK ${path.relative(repoRoot, registryPath)}: ${gates.length} gates, ` +
  `${gates.filter((g) => g.blocking).length} blocking, mode=${releaseMode ? 'release' : 'draft'}`,
);
