import { amuxUsageEndpoint } from "./amux-usage.mjs";
import { readJson } from "./fsutil.mjs";
import { isName } from "./assign.mjs";
import { STATUS_REPORT_SECRET_ENV } from "./status-report.mjs";

const DEFAULT_CONFIG_PATH = "/etc/review-orchestrator/config.json";

const DEFAULTS = {
  timeoutSeconds: 2400,
  waitMaxSeconds: 540,
  maxBundleBytes: 50 * 1024 * 1024,
  maxPromptDiffBytes: 300 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  // Bytes of objects the change introduces, after decompression: a small
  // bundle can carry a blob that inflates to gigabytes in the worktree.
  maxChangeBytes: 200 * 1024 * 1024,
  // Jobs with any review not yet done. A forced-command key cannot queue more.
  maxPendingJobs: 20,
  retentionDays: 30,
  // A base must be in the history of one of these protected branches: the
  // reviewer's instruction files come from the base, so a base the submitter
  // pushed to any other branch could carry instructions of its own.
  trustedBaseRefs: ["refs/heads/develop", "refs/heads/main"],
  pollMs: 2000,
};

/**
 * Glob to RegExp for `contractPaths`: `**` spans directories, `*` stays in one
 * segment. Nothing else is special.
 */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * `statusSnapshot` is optional: { dir }. The daemon writes a content-free
 * snapshot.json into `dir` once a minute for the separate status sender. It
 * takes no URL and no secret, because the review account holds no credential
 * for the app, and no interval, because the sender's staleness rule depends on
 * it (lib/status-report.mjs).
 */
function statusSnapshotProblem(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "an object with dir";
  const unknown = Object.keys(value).filter((key) => key !== "dir");
  if (unknown.length > 0) return `unknown field ${unknown[0]}`;
  if (typeof value.dir !== "string" || !value.dir.startsWith("/") || value.dir.split("/").includes("..")) {
    return "dir must be an absolute path";
  }
  return null;
}

/**
 * Validated configuration. Fails closed: an enabled provider without a known
 * vendor or without a command is a configuration error, not a provider that
 * silently never runs.
 */
export function validateConfig(raw) {
  const errors = [];
  const config = { ...DEFAULTS, ...raw };
  if (typeof config.stateDir !== "string" || config.stateDir === "") errors.push("stateDir");
  if (!config.repos || typeof config.repos !== "object") errors.push("repos");
  for (const [name, repo] of Object.entries(config.repos ?? {})) {
    if (!isName(name)) errors.push(`repos.${name}: name`);
    if (typeof repo?.url !== "string" || typeof repo?.mirror !== "string") {
      errors.push(`repos.${name}: url and mirror`);
    }
  }
  if (
    !Array.isArray(config.trustedBaseRefs) ||
    config.trustedBaseRefs.length === 0 ||
    !config.trustedBaseRefs.every((ref) => typeof ref === "string" && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref))
  ) {
    errors.push("trustedBaseRefs: one or more refs/heads/<branch>");
  }
  for (const key of ["maxChangeBytes", "maxPendingJobs", "maxStderrBytes", "retentionDays"]) {
    if (!(Number.isInteger(config[key]) && config[key] > 0)) errors.push(`${key}: positive integer`);
  }
  if (config.statusSnapshot !== undefined) {
    const problem = statusSnapshotProblem(config.statusSnapshot);
    if (problem) errors.push(`statusSnapshot: ${problem}`);
    else config.statusSnapshot = { dir: config.statusSnapshot.dir };
  }
  if (config.amuxUsageUrl !== undefined && !amuxUsageEndpoint(config.amuxUsageUrl)) {
    errors.push("amuxUsageUrl: an http(s) URL on a loopback host");
  }
  if (!Array.isArray(config.providers) || config.providers.length === 0) errors.push("providers");
  const ids = new Set();
  for (const provider of config.providers ?? []) {
    const label = `providers.${provider?.id}`;
    if (!isName(provider?.id) || ids.has(provider.id)) errors.push(`${label}: id`);
    ids.add(provider?.id);
    // The status-report secret belongs to the sender's own account. A reviewer
    // reads the change under review, which could ask it to print its environment.
    if (Array.isArray(provider?.passEnv) && provider.passEnv.includes(STATUS_REPORT_SECRET_ENV)) {
      errors.push(`${label}: passEnv must not carry ${STATUS_REPORT_SECRET_ENV}`);
    }
    if (provider?.enabled !== true) continue;
    if (!isName(provider.vendor) || provider.vendor === "unknown") {
      errors.push(`${label}: an enabled provider needs a measured vendor`);
    }
    if (typeof provider.command !== "string" || !Array.isArray(provider.args)) {
      errors.push(`${label}: command and args`);
    }
    if (provider.priority !== undefined && !(Number.isInteger(provider.priority) && provider.priority >= 0)) {
      errors.push(`${label}: priority must be a non-negative integer`);
    }
    if (provider.quotaProbe !== undefined && !["amux", "claude", "codex", "cursor", "copilot", "manual"].includes(provider.quotaProbe)) {
      errors.push(`${label}: quotaProbe must be amux, claude, codex, cursor, copilot or manual`);
    }
    if (provider.quotaProbe === "amux" && !amuxUsageEndpoint(config.amuxUsageUrl)) {
      errors.push(`${label}: quotaProbe amux needs amuxUsageUrl, an http(s) URL on this machine`);
    }
    if (provider.amuxProvider !== undefined && (provider.quotaProbe !== "amux" || !isName(provider.amuxProvider))) {
      errors.push(`${label}: amuxProvider names an AMUX usage provider, with quotaProbe amux`);
    }
    if (provider.quotaKey !== undefined && (provider.quotaProbe !== "copilot" ||
        typeof provider.quotaKey !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(provider.quotaKey))) {
      errors.push(`${label}: quotaKey must name a Copilot account quota snapshot`);
    }
    if (provider.promptNote !== undefined && !(typeof provider.promptNote === "string" && provider.promptNote.length <= 4000)) {
      errors.push(`${label}: promptNote must be a string of at most 4000 characters`);
    }
    if (provider.maxConcurrent !== undefined && !(Number.isInteger(provider.maxConcurrent) && provider.maxConcurrent >= 1)) {
      errors.push(`${label}: maxConcurrent`);
    }
  }
  config.contractPathMatchers = (config.contractPaths ?? []).map(globToRegExp);
  if (errors.length > 0) throw new Error(`config_invalid: ${errors.join("; ")}`);
  return config;
}

export function loadConfig(path = process.env.REVIEW_ORCH_CONFIG || DEFAULT_CONFIG_PATH) {
  return validateConfig(readJson(path));
}

/** Reviewer count after the contract-path floor: a contract change gets two. */
export function requiredReviewers(config, requested, files) {
  const touchesContract = files.some((file) => config.contractPathMatchers.some((re) => re.test(file)));
  return { reviewers: touchesContract ? Math.max(requested, 2) : requested, touchesContract };
}
