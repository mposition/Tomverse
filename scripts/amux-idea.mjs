import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AMUX_V4_ANALYSIS_PROMPT_VERSION, amuxAnalysisPromptWithNote,
  buildAmuxIdeaAnalysisPrompt } from "../lib/amux/ideaAnalysisPromptCore.ts";
import { deriveAmuxFeatureDisplayPrefix } from "../lib/amux/cardDisplayKeyBackfillCore.ts";
import { AMUX_SESSION_PAGE_NOTE } from "../lib/amux/ideaSessionAnswerCore.ts";
import {
  AMUX_SESSION_INTAKE_ORIGIN_ENV,
  amuxSessionIntakeEndpoint,
  prepareAmuxSessionIntakeSubmission,
  readAmuxSessionIntakeClientRequest,
  readAmuxSessionIntakeHierarchy,
  submitAmuxSessionIntakeClientRequest,
} from "../lib/amux/ideaSessionIntakeClientCore.ts";
import {
  AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV,
  isAmuxSessionIntakeClientSecret,
} from "../lib/amux/ideaSessionIntakeReadbackCore.ts";
import { inspectAmuxIdeaSessionPlan } from "../lib/amux/ideaSessionSubmissionCore.ts";

/**
 * One command every coding tool runs to put an idea, and optionally the plan
 * the session wrote for it, into AMUX (owner decision 2026-11-21):
 *
 *   npm run amux:idea -- submit --tool "<tool>" --provider "<provider>" \
 *     --title "<one line>" [--body <file.md>|-] [--plan <plan.json>|-] \
 *     [--repo owner/name]... [--pr owner/name#123]... [--no-repo] \
 *     [--session "<label>"] [--origin https://...]
 *   npm run amux:idea -- prompt --title "<one line>" [--body <file.md>|-]
 *   npm run amux:idea -- check --plan <plan.json>|-
 *   npm run amux:idea -- readback --request-id <uuid> [--origin https://...]
 *
 * `prompt` prints the analysis prompt the box would run for this idea; a
 * session that writes its own plan answers it with one JSON object. `check`
 * runs the same parser and content checks locally. With the credential and
 * origin set, `prompt`, `check` and `submit` first read the existing
 * Initiative / Epic / Feature nodes (owner decision 2026-11-22), so the prompt
 * lists them and a plan may attach to them; a ref to any other node is
 * refused. `check` and `submit` read them only for a plan that names an
 * existing node. Without them `prompt` runs offline with no existing nodes
 * and says so. `submit`
 * sends the idea (and plan) once; without --repo it names this checkout's
 * GitHub origin, and refuses (repository_unavailable) when there is none.
 * The client secret and the origin come from the environment only
 * (TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET,
 * TOMVERSE_AMUX_SESSION_INTAKE_ORIGIN) and are never printed.
 */

const FLAGS = {
  submit: { single: ["--title", "--body", "--plan", "--tool", "--provider", "--session",
    "--origin"], multiple: ["--repo", "--pr"], toggles: ["--no-repo"] },
  prompt: { single: ["--title", "--body"], multiple: [], toggles: [] },
  check: { single: ["--plan"], multiple: [], toggles: [] },
  readback: { single: ["--request-id", "--origin"], multiple: [], toggles: [] },
};

export function parseAmuxIdeaArgs(args) {
  const command = args[0];
  const allowed = Object.hasOwn(FLAGS, command) ? FLAGS[command] : null;
  if (!allowed) throw new Error("command_invalid");
  const flags = {};
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index];
    if (allowed.toggles.includes(name)) {
      if (Object.hasOwn(flags, name)) throw new Error("command_invalid");
      flags[name] = true;
      continue;
    }
    const value = args[index + 1];
    const known = allowed.single.includes(name) || allowed.multiple.includes(name);
    if (!known || value === undefined || value.startsWith("--")) throw new Error("command_invalid");
    if (allowed.multiple.includes(name)) (flags[name] ??= []).push(value);
    else if (Object.hasOwn(flags, name)) throw new Error("command_invalid");
    else flags[name] = value;
    index += 1;
  }
  if (flags["--body"] === "-" && flags["--plan"] === "-") throw new Error("command_invalid");
  if (flags["--no-repo"] && flags["--repo"]) throw new Error("command_invalid");
  return { command, flags };
}

const PULL = /^([A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]*)$/;

/** owner/name of a GitHub remote URL, or null. */
export function githubRepositoryOf(url) {
  const match = /(?:^|[/@])github\.com[:/]([A-Za-z0-9_.-]{1,64})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/
    .exec(typeof url === "string" ? url.trim() : "");
  return match ? `${match[1]}/${match[2]}` : null;
}

const defaultRepository = () => {
  try {
    return githubRepositoryOf(execFileSync("git", ["remote", "get-url", "origin"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
};

const readText = (path, dependencies) => {
  try {
    return dependencies.readInput
      ? dependencies.readInput(path)
      : readFileSync(path === "-" ? 0 : path, "utf8");
  } catch {
    throw new Error("input_unavailable");
  }
};

/** The idea text: its title line, then the body. The title is what the Admin
 * list shows (lib/amux/ideaTitleCore.ts reads the first line). */
export function amuxIdeaText(flags, dependencies = {}) {
  const title = typeof flags["--title"] === "string" ? flags["--title"].trim() : "";
  if (!title || /[\r\n]/.test(title)) throw new Error("metadata_incomplete");
  const body = flags["--body"] ? readText(flags["--body"], dependencies).trim() : "";
  return body ? `${title}\n\n${body}` : title;
}

const readPlan = (path, dependencies) => {
  try {
    return JSON.parse(readText(path, dependencies));
  } catch (error) {
    if (error instanceof Error && error.message === "input_unavailable") throw error;
    throw new Error("plan_rejected");
  }
};

// The local check names its verdict the same way the plan writer would.
const PLAN_CHECK_ID = "00000000-0000-4000-8000-000000000000";

class PlanRefusal extends Error {
  constructor(inspected) {
    super(inspected.code);
    this.inspected = inspected;
  }
}

const checkedPlan = (plan, existingNodes = []) => {
  const inspected = inspectAmuxIdeaSessionPlan(plan, PLAN_CHECK_ID, existingNodes);
  if (!inspected.ok) throw new PlanRefusal(inspected);
  return inspected.plan;
};

/** The existing hierarchy, or null when no credential and origin are set. A
 * configured client that cannot read it stops rather than check against none. */
async function existingHierarchy(flags, env, dependencies, required) {
  const secret = env[AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV];
  const origin = flags["--origin"] ?? env[AMUX_SESSION_INTAKE_ORIGIN_ENV];
  if (!required && (!isAmuxSessionIntakeClientSecret(secret) || !origin)) return null;
  return readAmuxSessionIntakeHierarchy({ endpoint: intakeEndpoint(flags, env),
    secret: intakeSecret(env), fetcher: dependencies.fetcher });
}

/** A new Feature with no displayPrefix still gets one when it is registered
 * (from its title, as the backfill does); check says so beforehand. */
export function amuxPlanWarnings(plan) {
  const units = Array.isArray(plan?.units) ? plan.units : [];
  return units.flatMap((unit) => unit?.kind === "node" && unit.level === "feature" &&
    !unit.displayPrefix ? [{ rule: "feature_display_prefix_missing", localId: unit.localId,
      registeredAs: deriveAmuxFeatureDisplayPrefix(typeof unit.title === "string"
        ? unit.title : null) ?? "FEAT<n>" }] : []);
}

/** The parent and Feature refs of a plan that are not its own units: the
 * existing nodes it attaches to. */
export function amuxPlanExistingRefs(plan) {
  const units = Array.isArray(plan?.units) ? plan.units : [];
  const local = new Set(units.map((unit) => unit?.localId));
  return [...new Set(units.flatMap((unit) => {
    const ref = unit?.kind === "node" ? unit.parentRef : unit?.kind === "card" ? unit.featureRef : null;
    return typeof ref === "string" && !local.has(ref) ? [ref] : [];
  }))];
}

const intakeEndpoint = (flags, env) => amuxSessionIntakeEndpoint(
  flags["--origin"] ?? env[AMUX_SESSION_INTAKE_ORIGIN_ENV] ?? "");

const intakeSecret = (env) => {
  const secret = env[AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV];
  if (!isAmuxSessionIntakeClientSecret(secret)) throw new Error("credential_unavailable");
  return secret;
};

export async function runAmuxIdeaCommand(args, env = process.env, dependencies = {}) {
  const { command, flags } = parseAmuxIdeaArgs(args);
  if (command === "prompt") {
    const text = amuxIdeaText(flags, dependencies);
    const existingNodes = await existingHierarchy(flags, env, dependencies, false);
    const built = buildAmuxIdeaAnalysisPrompt({ previewId: PLAN_CHECK_ID, chunkIndex: 0,
      revisionChunkIndex: 0, continuation: null,
      sourceTexts: [{ refId: "operator_idea", kind: "operator_idea", text }],
      permittedTargetRefs: existingNodes ?? [] });
    if (built.status !== "prompt_candidate") throw new Error("content_refused");
    return { output: "text", text: [
      existingNodes === null
        ? `Existing hierarchy not loaded: set ${AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV} and ${
          AMUX_SESSION_INTAKE_ORIGIN_ENV} so this prompt lists the existing Initiative/Epic/Feature nodes.`
        : `This prompt lists ${existingNodes.length} existing Initiative/Epic/Feature nodes; attach to them where the idea serves the same goal.`,
      "A coding session writes this plan itself: read the repository as the work needs,",
      "then answer the prompt below with exactly one JSON object and pass it as --plan.",
      `AMUX checks it with the parser and content rules of a box analysis answer (${
        AMUX_V4_ANALYSIS_PROMPT_VERSION}).`,
      "The operator approves the plan in the Admin idea before any card exists, unless",
      "automatic registration of session plans is switched on.",
      "",
      amuxAnalysisPromptWithNote(built.prompt, AMUX_SESSION_PAGE_NOTE),
    ].join("\n") };
  }
  if (command === "check") {
    if (!flags["--plan"]) throw new Error("command_invalid");
    const raw = readPlan(flags["--plan"], dependencies);
    // A plan that names no existing node is checked offline, as before; one
    // that does is checked against the hierarchy, and without a credential
    // every such ref is refused as unconfirmed.
    const existingRefs = amuxPlanExistingRefs(raw);
    const existingNodes = existingRefs.length === 0 ? null
      : await existingHierarchy(flags, env, dependencies, false);
    const plan = checkedPlan(raw, existingNodes ?? []);
    const warnings = amuxPlanWarnings(raw);
    return { output: "json", value: { status: "plan_ok", unitCount: plan.unitCount,
      ...(existingRefs.length ? { attachedToExisting: existingRefs.length } : {}),
      ...(warnings.length ? { warnings } : {}) } };
  }
  const secret = intakeSecret(env);
  const endpoint = intakeEndpoint(flags, env);
  const fetcher = dependencies.fetcher;
  if (command === "readback") {
    const requestId = flags["--request-id"];
    if (!requestId) throw new Error("request_id_invalid");
    return { output: "json", value: await readAmuxSessionIntakeClientRequest({
      endpoint, secret, requestId, fetcher }) };
  }
  const tool = flags["--tool"]?.trim();
  const provider = flags["--provider"]?.trim();
  if (!tool || !provider) throw new Error("metadata_incomplete");
  let repositories = flags["--no-repo"] ? [] : flags["--repo"];
  if (!repositories) {
    // An idea sent without the reference the operator expected could not be
    // analysed against the code; say so instead of sending none.
    const origin = (dependencies.defaultRepository ?? defaultRepository)();
    if (!origin) throw new Error("repository_unavailable");
    repositories = [origin];
  }
  const pullRequests = (flags["--pr"] ?? []).map((value) => {
    const match = PULL.exec(value);
    if (!match) throw new Error("schema_rejected");
    return { repository: match[1], number: Number(match[2]) };
  });
  let plan;
  let existingNodes = [];
  if (flags["--plan"]) {
    plan = readPlan(flags["--plan"], dependencies);
    if (amuxPlanExistingRefs(plan).length > 0) {
      existingNodes = await existingHierarchy(flags, env, dependencies, true);
    }
    checkedPlan(plan, existingNodes);
  }
  const inspected = prepareAmuxSessionIntakeSubmission({
    version: 1,
    input: { version: 1, idea: amuxIdeaText(flags, dependencies), repositories, pullRequests },
    source: { toolName: tool, modelProvider: provider,
      sessionDisplay: flags["--session"]?.trim() || `${tool} session` },
    ...(plan === undefined ? {} : { plan }),
  }, dependencies.createRequestId, existingNodes);
  // The request ID is known before the sole POST, so a lost reply is read back.
  await (dependencies.onPrepared ?? print)({ status: "dispatching",
    requestId: inspected.requestId, plan: inspected.plan ? "attached" : "none" });
  return { output: "json", value: await submitAmuxSessionIntakeClientRequest({
    endpoint, secret, inspected, fetcher }) };
}

const print = (value) => new Promise((resolvePrint, reject) => {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`,
    (error) => error ? reject(error) : resolvePrint());
});

const CLOSED_ERRORS = new Set(["command_invalid", "credential_unavailable", "origin_invalid",
  "request_id_invalid", "input_unavailable", "schema_rejected", "content_refused",
  "metadata_incomplete", "plan_rejected", "repository_unavailable", "hierarchy_unavailable"]);

/** What a failure may print: a closed code, and for a refused plan the
 * parser's own closed rule, field and unit position. Never input or secret. */
export function amuxIdeaErrorReport(error) {
  if (error instanceof PlanRefusal) {
    const { code, reason, detail } = error.inspected;
    return { error: code, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
  }
  return { error: error instanceof Error && CLOSED_ERRORS.has(error.message)
    ? error.message : "client_failed" };
}

async function main() {
  try {
    const result = await runAmuxIdeaCommand(process.argv.slice(2));
    if (result.output === "text") {
      await print(result.text);
      return;
    }
    await print(result.value);
    const state = result.value.state;
    process.exitCode = state === undefined || state === "committed" ? 0
      : state === "refused" ? 2 : 3;
  } catch (error) {
    console.error(JSON.stringify(amuxIdeaErrorReport(error)));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
