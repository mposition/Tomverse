import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { createAmuxV22ReadOnlyApiBroker,
  createAmuxV22ReadOnlyApiSnapshotManifest } from "./v22ReadOnlyApiBroker.mjs";
import { createAmuxV22ReadOnlyApiExecutor } from "./v22ReadOnlyApiExecutor.mjs";
import {
  AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  amuxV22ReadOnlyApiRepositoryScopeDigest,
  parseAmuxV22ReadOnlyApiExecutionFrame,
} from "./v22ReadOnlyApiProtocol.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_HOST_LIFETIME_MS = 30 * 60 * 1_000;
const FORBIDDEN_ENV = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_ADMIN_API_KEY", "ANTHROPIC_BASE_URL", "ENGINEERING_AGENT_ANTHROPIC_API_KEY",
  "FEEDBACK_AUTOFIX_ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  "PERPLEXITY_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR",
  "DATABASE_URL", "DIRECT_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL",
  "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING", "PGHOST", "PGPASSWORD",
  "AMUX_V4_KEY_STORE_ACCESS_KEY_ID", "AMUX_V4_KEY_STORE_SECRET_ACCESS_KEY",
  "AMUX_V4_CONTENT_MASTER_KEY_B64", "AMUX_V4_CONTENT_DIGEST_KEY_B64",
  "AMUX_DM_DIGEST_KEYS", "GITHUB_APP_PRIVATE_KEY", "NODE_OPTIONS", "NODE_PATH",
  "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
  "TOMVERSE_AMUX_V22_CLAUDE_BINARY", "TOMVERSE_AMUX_V22_CLAUDE_CONFIG_DIR",
  "TOMVERSE_AMUX_V22_WORKTREE", "TOMVERSE_AMUX_SYNC_SECRET", "TOMVERSE_INTERNAL_URL",
  "GITHUB_TOKEN", "GH_TOKEN"]);

const canonicalJson = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

export function amuxV22ReadOnlyApiLauncherConfigDigest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !WORKER.test(input.worker) ||
      [input.apiExecutionFrameDigest, input.credentialMetadataDigest,
        input.executorArtifactDigest, input.settingsDigest,
        input.repositoryScopeDigest, input.brokerPolicyDigest,
        input.toolSchemaDigest, input.snapshotDigest, input.gitProofDigest]
        .some(value => !DIGEST.test(value)) ||
      typeof input.credentialProfileId !== "string" ||
      input.credentialProfileId.length < 1 || input.credentialProfileId.length > 128 ||
      /[\0\r\n]/.test(input.credentialProfileId))
    throw new TypeError("invalid read-only API launcher metadata");
  return createHash("sha256")
    .update("amux-v22-read-only-api-launcher-config-v1\n")
    .update(canonicalJson({ version: 1, executorKind: "read_only_api_retry_v1",
      worker: input.worker, apiExecutionFrameDigest: input.apiExecutionFrameDigest,
      credentialProfileId: input.credentialProfileId,
      credentialMetadataDigest: input.credentialMetadataDigest,
      executorArtifactDigest: input.executorArtifactDigest,
      settingsDigest: input.settingsDigest,
      repositoryScopeDigest: input.repositoryScopeDigest,
      brokerPolicyDigest: input.brokerPolicyDigest,
      toolSchemaDigest: input.toolSchemaDigest,
      gitProofDigest: input.gitProofDigest,
      snapshotDigest: input.snapshotDigest }))
    .digest("hex");
}

async function readDedicatedKey(path, repositoryRoot, dependencies = {}) {
  const stat = dependencies.lstat ?? lstat;
  const resolveReal = dependencies.realpath ?? realpath;
  const openFile = dependencies.open ?? open;
  if (typeof path !== "string" || !isAbsolute(path))
    throw new TypeError("invalid dedicated credential source");
  const absolute = resolve(path);
  const [fileReal, rootReal] = await Promise.all([
    resolveReal(absolute), resolveReal(repositoryRoot),
  ]);
  const relation = relative(rootReal, fileReal);
  if (fileReal !== absolute || relation === "" ||
      (!relation.startsWith("..") && !isAbsolute(relation)))
    throw new TypeError("dedicated credential boundary violated");
  const before = await stat(absolute);
  const uid = dependencies.uid ?? process.getuid?.();
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.uid !== uid || (before.mode & 0o777) !== 0o600 ||
      before.size < 16 || before.size > 8_192)
    throw new TypeError("dedicated credential boundary violated");
  const handle = await openFile(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.ctimeMs !== before.ctimeMs)
      throw new TypeError("dedicated credential changed");
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead < 1) throw new TypeError("dedicated credential truncated");
      offset += bytesRead;
    }
    const key = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.ctimeMs !== opened.ctimeMs ||
        key.length < 16 || key.length > 8_192 || /[\0\r\n\t ]/.test(key))
      throw new TypeError("dedicated credential invalid");
    return key;
  } finally { bytes?.fill(0); await handle.close(); }
}

/** Builds the non-root runtime from a closed environment. No key/path/source
 * bytes are returned in capability, receipt or launcher proof metadata. */
export async function createAmuxV22ReadOnlyApiHost(environment, dependencies = {}) {
  if (!environment || typeof environment !== "object" ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED !== "true" ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_OPERATIONAL_GATES !== "true" ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_DEDICATED !== "true" ||
      FORBIDDEN_ENV.some(name => environment[name]))
    throw new TypeError("read-only API executor disabled");
  const worker = environment.TOMVERSE_AMUX_V22_WORKER;
  const repositoryRoot = environment.TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_ROOT;
  const sourceRevision = environment.TOMVERSE_AMUX_V22_READ_ONLY_API_SOURCE_REVISION;
  if (!WORKER.test(worker) || typeof repositoryRoot !== "string" ||
      !isAbsolute(repositoryRoot) || !REVISION.test(sourceRevision))
    throw new TypeError("invalid read-only API host configuration");
  const clock = dependencies.testOnly === true &&
    typeof dependencies.clock === "function" ? dependencies.clock : Date.now;
  const hostDeadlineAtMs = dependencies.testOnly === true
    ? dependencies.hostDeadlineAtMs
    : Number(environment.TOMVERSE_AMUX_V22_READ_ONLY_API_HOST_DEADLINE_AT_MS);
  const startedAtMs = clock();
  if (!Number.isSafeInteger(hostDeadlineAtMs) || hostDeadlineAtMs <= startedAtMs ||
      hostDeadlineAtMs - startedAtMs > MAX_HOST_LIFETIME_MS)
    throw new TypeError("invalid read-only API host deadline");
  let allowedPrefixes, frame;
  try {
    allowedPrefixes = JSON.parse(
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON);
    frame = parseAmuxV22ReadOnlyApiExecutionFrame(JSON.parse(
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON),
    { now: dependencies.now });
  } catch { throw new TypeError("invalid read-only API host configuration"); }
  if (!Array.isArray(allowedPrefixes) || allowedPrefixes.length < 1 ||
      allowedPrefixes.length > 32 ||
      allowedPrefixes.some(value => typeof value !== "string"))
    throw new TypeError("invalid read-only API repository scope");
  const repositoryScopeDigest = amuxV22ReadOnlyApiRepositoryScopeDigest({
    sourceRevision, allowedPrefixes,
  });
  if (frame.repositoryScopeDigest !== repositoryScopeDigest ||
      frame.settingsDigest !== AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST ||
      frame.brokerPolicyDigest !== AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST ||
      frame.toolSchemaDigest !== AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST)
    throw new TypeError("read-only API frame drift");
  const snapshotManifest = await createAmuxV22ReadOnlyApiSnapshotManifest({
    repositoryRoot, sourceRevision, allowedPrefixes,
  }, dependencies.brokerDependencies);
  const broker = createAmuxV22ReadOnlyApiBroker({ repositoryRoot, sourceRevision,
    allowedPrefixes, repositoryScopeDigest,
    brokerPolicyDigest: frame.brokerPolicyDigest,
    toolSchemaDigest: frame.toolSchemaDigest, snapshotManifest },
  dependencies.brokerDependencies);
  const apiKey = await readDedicatedKey(
    environment.TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE, repositoryRoot, dependencies);
  const runtime = { environment,
    operationalGatesSatisfied: true,
    credential: { verified: true, dedicated: true, apiKey,
      profileId: frame.credentialProfileId,
      metadataDigest: frame.credentialMetadataDigest },
    executorArtifactDigest: frame.executorArtifactDigest,
    settingsDigest: frame.settingsDigest, repositoryScopeDigest,
    brokerPolicyDigest: frame.brokerPolicyDigest,
    toolSchemaDigest: frame.toolSchemaDigest, broker, hostDeadlineAtMs };
  if (dependencies.testOnly === true) Object.assign(runtime, { testOnly: true,
    fetcher: dependencies.fetcher, clock: dependencies.clock,
    setTimer: dependencies.setTimer, clearTimer: dependencies.clearTimer });
  const executor = createAmuxV22ReadOnlyApiExecutor(runtime);
  const apiExecutionFrameDigest = amuxV22ReadOnlyApiExecutionFrameDigest(frame);
  const launcherConfigDigest = amuxV22ReadOnlyApiLauncherConfigDigest({ worker,
    apiExecutionFrameDigest, credentialProfileId: frame.credentialProfileId,
    credentialMetadataDigest: frame.credentialMetadataDigest,
    executorArtifactDigest: frame.executorArtifactDigest,
    settingsDigest: frame.settingsDigest, repositoryScopeDigest,
    brokerPolicyDigest: frame.brokerPolicyDigest,
    toolSchemaDigest: frame.toolSchemaDigest,
    gitProofDigest: snapshotManifest.gitProofDigest,
    snapshotDigest: snapshotManifest.snapshotDigest });
  return Object.freeze({ worker, frame, executor, apiExecutionFrameDigest,
    launcherConfigDigest, hostDeadlineAtMs,
    capabilities: () => executor.capabilities(frame, { now: dependencies.now }) });
}

/** Root preflight adapter. The installation-specific reader is deliberately
 * absent until a separately approved unit/key deployment exists. */
export async function inspectAmuxV22ReadOnlyApiLauncher(worker, frame, options = {}) {
  if (!WORKER.test(worker) || typeof options.readApiLauncherState !== "function")
    return { current: false };
  try {
    const parsed = parseAmuxV22ReadOnlyApiExecutionFrame(frame, { now: options.now });
    const state = await options.readApiLauncherState(worker);
    const frameDigest = amuxV22ReadOnlyApiExecutionFrameDigest(parsed);
    if (!state || state.enabled !== true || state.operationalGatesSatisfied !== true ||
        state.credentialDedicated !== true || state.worker !== worker ||
        state.apiExecutionFrameDigest !== frameDigest ||
        state.credentialProfileId !== parsed.credentialProfileId ||
        state.credentialMetadataDigest !== parsed.credentialMetadataDigest ||
        state.executorArtifactDigest !== parsed.executorArtifactDigest ||
        state.settingsDigest !== parsed.settingsDigest ||
        state.repositoryScopeDigest !== parsed.repositoryScopeDigest ||
        state.brokerPolicyDigest !== parsed.brokerPolicyDigest ||
        state.toolSchemaDigest !== parsed.toolSchemaDigest ||
        !DIGEST.test(state.gitProofDigest) ||
        !DIGEST.test(state.snapshotDigest))
      return { current: false };
    return { current: true, launcherConfigDigest:
      amuxV22ReadOnlyApiLauncherConfigDigest(state) };
  } catch { return { current: false }; }
}
