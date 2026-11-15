/**
 * The Decision Maker's develop merge of a review pull request (owner decision
 * 2026-11-13: "develop 병합 권한은 DM에게 승인합니다. main은 안됩니다.", "1~4까지
 * DM에게 자동으로 하도록 승인합니다."). A review pull request the Decision
 * Maker approved from the owner queue (lib/amux/dmOwnerSettlementService.ts,
 * kind `t2_pr`) is marked ready by the app, its CI runs, and the QA-release
 * merge lane merges it into develop -- never main, never a deploy. Which
 * changes take this path is the merge scope's (owner decision 2026-11-15,
 * QA_RELEASE_DM_MERGE_SCOPE_ENV): by default every product path on no block
 * list, with the approved patch's changed lines free of the alarms below;
 * with the kill switch, only the allow list of 2026-11-13. One path or line
 * outside leaves the pull request to a person.
 *
 * Pure: the switch, which paths a patch changes, whether CI admission's line
 * leaves room, and whether a pull request read fresh is still the change the
 * Decision Maker approved. Default off; off, nothing here is consulted.
 */

import { DECISION_VALUE_ALARMS } from "../agentPushPolicy.ts";
import { CI_ADMISSION_HOLD_LABEL, ciRunKey } from "../ciAdmissionCore.ts";
import {
  qaReleaseDmApprovedHumanPaths, qaReleaseDmMergeAllowed, qaReleaseDmMergeInAllowList, type QaReleaseDmMergeScope,
} from "../qaReleaseMergeLaneExclusionCore.ts";

/** Default off. On, the app marks Decision Maker approved review pull requests ready and the lane may merge them into develop. */
export const AMUX_DM_T2_MERGE_ENV = "TOMVERSE_AMUX_DM_T2_MERGE";
export const amuxDmT2MergeEnabled = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  env[AMUX_DM_T2_MERGE_ENV] === "enabled";

/** The engineering agent's own branches; nothing else is ever marked ready or merged on a Decision Maker approval. */
export const AMUX_DM_T2_MERGE_HEAD = /^agent\/engineering\/[0-9]{1,20}$/;

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Every path a unified diff names, both sides of a rename; null when it names
 * none, which judges nothing.
 */
export function amuxDmT2MergePatchPaths(patch: string | null): string[] | null {
  if (typeof patch !== "string") return null;
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.replace(/\r$/, ""));
    if (!header) continue;
    paths.add(header[1]!);
    paths.add(header[2]!);
  }
  return paths.size > 0 ? [...paths] : null;
}

export type AmuxDmT2MergeGate =
  | { pass: true }
  | { pass: false; reason: "outside_dm_merge_allowlist" | "paths_unreadable"; paths: string[] };

/**
 * Whether a change may take the automatic path: every one of its paths is one
 * the merge scope lets through (qaReleaseDmMergeAllowed), and its paths could
 * be read at all. Anything else is left to a person. Without a scope, the
 * allow list, the narrower rule.
 */
export function amuxDmT2MergeGate(paths: readonly string[] | null,
  scope: QaReleaseDmMergeScope = "allowlist"): AmuxDmT2MergeGate {
  if (paths === null || paths.length === 0) return { pass: false, reason: "paths_unreadable", paths: [] };
  const human = qaReleaseDmApprovedHumanPaths(paths, [], scope);
  return human.length === 0 ? { pass: true } : { pass: false, reason: "outside_dm_merge_allowlist", paths: human.slice(0, 20) };
}

/**
 * What a path cannot say (review r-20261113-134019-5d8f82: a list of what a
 * revert cannot undo always misses one, such as a spending cap inside an
 * ordinary file). In the block list scope a changed line, or the function a
 * hunk sits in as Git names it after `@@`, that matches one of these leaves
 * the change to a person: the values AGENTS.md reserves for a person
 * (lib/agentPushPolicy.ts), the words of money, environment and stored
 * switches (a default-off switch turned on is a paid call enabled), deletion
 * and raw SQL, authentication and secrets, mail, and whose data a query or a
 * check is about (an ownership condition dropped from a removed line). Cheap
 * and loose by design: a false alarm only means a person merges.
 */
export const AMUX_DM_T2_MERGE_CONTENT_ALARMS: readonly RegExp[] = [
  ...DECISION_VALUE_ALARMS,
  /credit|billing|stripe|pric(?:e|ing)|budget|spend|cost|ledger|quota|entitlement|reservation|refund|discount|promotion|payment|invoice|checkout|subscription/i,
  /[a-z]Cents\b|\bcents\b|\b(?:AUD|USD)\b/,
  /\bprocess\.env\b|\bTOMVERSE_[A-Z0-9_]+|\benv\s*\[|\b[A-Z][A-Z0-9_]*_ENV\b|\bappSetting\b|\bAppSetting\b/,
  /\b(?:delete\w*|purge\w*|erase\w*|wipe\w*|truncate)\b|\.delete(?:Many)?\s*\(|\$executeRaw|\$queryRawUnsafe|\bdrop\s+(?:table|column|schema|index|trigger|function)\b/i,
  /\b(?:auth\w*|session\w*|secret\w*|token|password\w*|cookie\w*|csrf\w*|permission\w*|api_?key\w*|bearer|credential\w*|reauth\w*|require(?:Admin|User|Session|Auth)\w*)\b/i,
  /\b(?:send\w*(?:Email|Mail)\w*|mail\w*|resend|smtp|webhook\w*|notify\w*)\b/i,
  /\w*(?:userid|ownerid|tenantid|accountid|organizationid|orgid|createdbyid|authorid|memberid)\b|\b(?:user|owner|session|viewer|actor|member)\.id\b|\bsession\.user\b|\bis(?:Admin|Owner|Member)\b|\bvisibility\b|\bisPublic\b/i,
  // Anything leaving Tomverse by a call of its own (review r-20261115-115539-709020: a route that posts the
  // request body to an outside URL with fetch): the network, another process, code assembled at run time.
  /\bfetch\b|https?:\/\/|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\b(?:axios|undici|node-fetch|got)\b|\bhttps?\.(?:request|get)\s*\(|\bnet\.(?:connect|createConnection)\b|\bdgram\b|\bchild_process\b|\b(?:exec|execFile|execSync|spawn|spawnSync|fork)\s*\(|\beval\s*\(|\bFunction\s*\(|\bimport\s*\(\s*[^"'`\s]|\b(?:import|require)\s*\(\s*`[^`]*\$\{|\bglobalThis\b|\bprocess\.\w|\brequire\s*\(\s*[^"'`\s]/,
  // A Node built-in named anywhere (review r-20261115-120924-b09623: `import { request } from "node:https"`).
  /["'`]node:[a-z_/]+["'`]|["'`](?:https?|http2|net|tls|dgram|dns|child_process|fs|fs\/promises|worker_threads|cluster|vm|inspector)["'`]/,
  // An import written so the specifier check below cannot read it (review r-20261115-122232-b03aef:
  // `from /* storage */ "@/lib/r2"`): a comment right after the keyword, or a specifier built by `+`.
  /\b(?:from|import|require)\s*\(?\s*\/[*/]|\b(?:require|import)\s*\(\s*["'`][^"'`\n]*["'`]\s*\+/,
  // Data at rest: the database (any query decides whose rows it reads or writes) and the file system.
  /\b(?:prisma|tx|db|client)\.[a-z]\w*\.(?:find\w*|create\w*|update\w*|upsert|delete\w*|count|aggregate|groupBy)\s*\(|\$queryRaw|@prisma\/client|@\/lib\/prisma\b|\b(?:writeFile|appendFile|unlink|rmdir|rm|mkdir|rename|copyFile|createWriteStream)(?:Sync)?\s*\(/,
  /\bdangerouslySetInnerHTML\b/,
  /^Subproject commit [0-9a-f]+$/,
];

/**
 * Read on every line of a hunk, unchanged context included, and on the
 * function Git names after `@@` (review r-20261115-112039-771ce1: an
 * ownership check weakened with no keyword on the changed line, right above
 * an unchanged `throw new ApiSecurityError`): a change beside an
 * authorization or ownership check, or inside a function named for one, is a
 * security boundary change and stays a person's.
 */
export const AMUX_DM_T2_MERGE_HUNK_ALARMS: readonly RegExp[] = [
  /ApiSecurityError|\bforbidden\b|\bunauthori[sz]ed\b|\bnotFound\s*\(|\bstatus:\s*40[134]\b|\brequire(?:User|Admin|Session|Auth|Owner|Member|Access)\w*|\bassert\w*(?:Owner|Access|Permission|Member)\w*|\bgetServerSession\b|\bauth\s*\(\s*\)|owned|ownership|\bcan(?:Read|Write|Edit|Access|View|Delete|Manage)\w*/i,
  /\w*(?:userid|ownerid|tenantid|accountid|organizationid|orgid|createdbyid|authorid|memberid)\b|\b(?:user|owner|session|viewer|actor|member)\.id\b|\bsession\.user\b|\bis(?:Admin|Owner|Member)\b/i,
  // Access itself: a grant, a lock, a guard (review r-20261115-112803-cbb35d: `return access.granted` -> `return true`).
  /access|grant|unlock|\block\w*|guard|\bdeny|denied|restrict|\bprivate\b|verif/i,
];

/**
 * Read over the whole text of every changed file outside the allow list, at
 * the approved head (review r-20261115-112803-cbb35d: an access check made a
 * no-op with no alarm on its lines or beside them). A file that says
 * anything any alarm above listens for -- money, the environment and stored
 * switches, deletion and raw SQL, authentication, secrets, mail, ownership,
 * access -- anywhere in it takes part in what a person decides, and stays a
 * person's. What the block list scope newly merges is code that says none of
 * it; the gate cannot see a file that never names such a thing but is
 * called by one that does (lib/amux/dmT2MergeCore.ts header).
 */
export const AMUX_DM_T2_MERGE_FILE_ALARMS: readonly RegExp[] = [
  ...AMUX_DM_T2_MERGE_CONTENT_ALARMS.filter((alarm) => !alarm.source.startsWith("^")),
  ...AMUX_DM_T2_MERGE_HUNK_ALARMS,
];

/**
 * The packages a newly admitted file may import (review
 * r-20261115-120924-b09623: a word list cannot know what an imported name
 * does). Anything else from npm, and every Node built-in, leaves the file to
 * a person: a package can reach the network, a process or the disk under a
 * name no alarm lists. `next/headers` (the request's cookies and headers) is
 * not among them.
 */
export const AMUX_DM_T2_MERGE_SAFE_IMPORTS: readonly string[] = [
  "react", "react-dom", "react/jsx-runtime", "next/link", "next/image", "next/navigation", "next/dynamic", "next/server",
  "zod", "clsx", "server-only", "client-only",
];

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

/** Where a repository import points, or null when it leaves the repository. */
function resolveRepoImport(fromPath: string, specifier: string): string | null {
  const segments = specifier.startsWith("@/") ? specifier.slice(2).split("/") :
    [...fromPath.split("/").slice(0, -1), ...specifier.split("/")];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

/**
 * The imports of a file that leave it to a person: a Node built-in, a package
 * outside AMUX_DM_T2_MERGE_SAFE_IMPORTS, or a repository module that the
 * block list scope would not merge on its path (control plane, a block list
 * pattern, a block name) under any of the names it could resolve to -- a file
 * that calls into what a person decides takes part in it.
 */
export function amuxDmT2MergeImportAlarms(path: string, text: string): string[] {
  const alarms: string[] = [];
  // The app has no parser at run time (typescript is a dev dependency), so the specifiers are read twice:
  // from the text as it is, and with every comment removed blindly (a comment-like run inside a string is
  // removed too). What either reading names counts; an import neither can read sounds the alarm above.
  const uncommented = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const specifiers = new Set([...text.matchAll(IMPORT_SPECIFIER), ...uncommented.matchAll(IMPORT_SPECIFIER)]
    .map((match) => match[1]!));
  for (const specifier of specifiers) {
    if (specifier.startsWith("@/") || specifier.startsWith(".")) {
      const target = resolveRepoImport(path, specifier);
      if (target === null || SOURCE_EXTENSIONS.some((ext) => !qaReleaseDmMergeAllowed(target + ext, [], "blocklist"))) {
        alarms.push(specifier);
      }
    } else if (!AMUX_DM_T2_MERGE_SAFE_IMPORTS.includes(specifier)) {
      alarms.push(specifier);
    }
  }
  return alarms;
}

/**
 * The changed paths whose whole text the block list scope must read: every
 * path outside the allow list of 2026-11-13. None in the allow list scope.
 */
export function amuxDmT2MergeFilesToRead(paths: readonly string[] | null, scope: QaReleaseDmMergeScope = "allowlist"): string[] {
  if (scope !== "blocklist" || paths === null) return [];
  return [...new Set(paths.filter((path) => !qaReleaseDmMergeInAllowList(path)))];
}

/**
 * The whole-file check: every path amuxDmT2MergeFilesToRead names was read
 * (null -- gone, not text, too large -- or unread is a person's) and its
 * text sounds no AMUX_DM_T2_MERGE_FILE_ALARMS alarm. Passes in the allow list
 * scope, which judges paths alone.
 */
export function amuxDmT2MergeFileGate(paths: readonly string[] | null, files: ReadonlyMap<string, string | null> | null | undefined,
  scope: QaReleaseDmMergeScope = "allowlist"): AmuxDmT2MergeGate {
  if (scope !== "blocklist") return { pass: true };
  if (paths === null || paths.length === 0) return { pass: false, reason: "paths_unreadable", paths: [] };
  const needed = amuxDmT2MergeFilesToRead(paths, scope);
  const unread = needed.filter((path) => typeof files?.get(path) !== "string");
  if (unread.length > 0) return { pass: false, reason: "paths_unreadable", paths: unread.slice(0, 20) };
  const alarmed = needed.filter((path) => {
    const text = files!.get(path)!;
    return AMUX_DM_T2_MERGE_FILE_ALARMS.some((alarm) => alarm.test(text)) || amuxDmT2MergeImportAlarms(path, text).length > 0;
  });
  return alarmed.length === 0 ? { pass: true } : { pass: false, reason: "outside_dm_merge_allowlist", paths: alarmed.slice(0, 20) };
}

/** A file header line that says the change is not reviewable text: binary, or a mode other than a plain file. */
const NOT_PLAIN_TEXT = /^(?:GIT binary patch|Binary files .* differ)$|^(?:old|new|deleted|new file|deleted file) mode (?!100644$)\d+$|^index [0-9a-f]+\.\.[0-9a-f]+ (?!100644$)\d+$/;

/**
 * The files of a unified diff that the block list scope leaves to a person
 * for what they say rather than where they are: a changed line or the hunk's
 * function that sounds an alarm (AMUX_DM_T2_MERGE_CONTENT_ALARMS), any hunk
 * line beside an authorization or ownership check
 * (AMUX_DM_T2_MERGE_HUNK_ALARMS), or a header that is not plain text
 * (binary, executable bit, symlink, submodule). A file inside the allow list
 * of 2026-11-13 on both sides is judged by its path alone, as it always was.
 */
export function amuxDmT2MergeContentAlarmPaths(patch: string): string[] {
  const flagged = new Set<string>();
  let path: string | null = null;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      const judged = !(qaReleaseDmMergeInAllowList(header[1]!) && qaReleaseDmMergeInAllowList(header[2]!));
      path = judged ? header[2]! : null;
      inHunk = false;
      continue;
    }
    if (path === null || flagged.has(path)) continue;
    let changed: string | null = null;
    let context: string | null = null;
    if (line.startsWith("@@")) {
      inHunk = true;
      changed = line.replace(/^@@[^@]*@@/, "");
    } else if (!inHunk) {
      if (NOT_PLAIN_TEXT.test(line)) flagged.add(path);
      continue;
    } else if (line.startsWith("+") || line.startsWith("-")) {
      changed = line.slice(1);
    } else if (line.startsWith(" ")) {
      context = line.slice(1);
    }
    const text = changed ?? context;
    if (text === null) continue;
    if (AMUX_DM_T2_MERGE_HUNK_ALARMS.some((alarm) => alarm.test(text)) ||
        (changed !== null && AMUX_DM_T2_MERGE_CONTENT_ALARMS.some((alarm) => alarm.test(changed)))) {
      flagged.add(path);
    }
  }
  return [...flagged];
}

/**
 * The approved patch judged whole: its paths in that scope, and in the block
 * list scope what its lines say too (amuxDmT2MergeContentAlarmPaths). What the
 * owner-queue settlement checks before it records an approval; the ready step,
 * the merge lane's list and its consume check it again on the stored patch.
 */
export function amuxDmT2MergePatchGate(patch: string | null,
  scope: QaReleaseDmMergeScope = "allowlist"): AmuxDmT2MergeGate {
  const gate = amuxDmT2MergeGate(amuxDmT2MergePatchPaths(patch), scope);
  if (!gate.pass || scope !== "blocklist" || patch === null) return gate;
  const alarmed = amuxDmT2MergeContentAlarmPaths(patch);
  return alarmed.length === 0 ? gate : { pass: false, reason: "outside_dm_merge_allowlist", paths: alarmed.slice(0, 20) };
}

/** Line statuses of a draft that still waits for runners: the line goes first. */
const LINE_WAITING = new Set(["waiting", "checking", "next", "updating"]);

/**
 * Whether CI admission's line leaves room now for one more develop pull
 * request's CI. A Decision Maker ready is a person's ready
 * (lib/ciAdmissionCore.ts): nothing is reserved, so this only says whether
 * there is room at this moment -- no draft in the line waits for runners, and
 * the whole need fits beside every run counted. It never jumps the line.
 */
export function amuxDmT2MergeRoomBesideLine(input: {
  queue: readonly { draft: boolean; status: string }[];
  used: number;
  capacity: number;
  need: number;
}): boolean {
  if (input.queue.some((entry) => entry.draft && LINE_WAITING.has(entry.status))) return false;
  return Number.isFinite(input.used) && input.used + input.need <= input.capacity;
}

/** How long a Decision Maker ready holds the next one back while its CI has not shown on GitHub. */
export const AMUX_DM_T2_MERGE_READY_SETTLE_MS = 10 * 60 * 1000;

/**
 * Whether an earlier Decision Maker ready still holds the next one back: one
 * made within AMUX_DM_T2_MERGE_READY_SETTLE_MS whose head has no CI run queued
 * or in progress on GitHub yet. Its CI, once it shows, is counted as running;
 * until then the next ready waits, so what can overflow the runners is one
 * pull request's CI, as when a person marks one ready by hand.
 */
export function amuxDmT2MergeReadyInFlight(input: {
  readies: readonly { prNumber: number; headSha: string; atMs: number }[];
  /** The ciRunKey (lib/ciAdmissionCore.ts) of every pull_request run queued or in progress. */
  running: ReadonlySet<string>;
  nowMs: number;
}): boolean {
  return input.readies.some((ready) => input.nowMs - ready.atMs < AMUX_DM_T2_MERGE_READY_SETTLE_MS &&
    !input.running.has(ciRunKey(ready.prNumber, ready.headSha)));
}

export type AmuxDmT2MergeApproved = {
  prNumber: number; headRef: string; approvedHeadSha: string; approvedDiffDigest: string;
};

/** The pull request as CI admission's App reads it now; `fork` when its head is not this repository's. */
export type AmuxDmT2MergePullNow = {
  open: boolean; draft: boolean; base: string; head: string; headSha: string; fork: boolean;
  /** Its labels as read: a person's ci:hold (CI_ADMISSION_HOLD_LABEL) is never readied past. */
  labels?: readonly string[];
};

/** The pull request's change as the engineering agent's read-only token reads it now. */
export type AmuxDmT2MergeChangeNow = {
  state: "open" | "closed"; baseRef: string; headRef: string; headSha: string;
  diffDigest: string | null; changedFiles: string[] | null;
  /** The head is in another repository than the base (a fork), or that could not be read. */
  crossRepository: boolean;
};

export type AmuxDmT2MergeSkipReason = "pull_closed" | "fork_pr" | "base_not_develop" | "branch_moved" | "head_moved" |
  "diff_unreadable" | "diff_changed" | "paths_unreadable" | "outside_dm_merge_allowlist" | "ci_hold";

/**
 * Whether a pull request's change, read fresh from GitHub, is still the one
 * the Decision Maker approved: open, into develop, on the approved branch and
 * head, its diff byte for byte the approved one (a merge base that moved with
 * develop changes it), and every path one the merge scope lets through. In
 * the block list scope the approved patch, as stored, must pass too, lines
 * and all (amuxDmT2MergePatchGate); none stored does not. Anything unread or
 * different does not hold. What the app checks before it marks a pull request
 * ready and every time it tells the merge lane of one.
 */
export function amuxDmT2MergeChangeVerdict(input: {
  approved: AmuxDmT2MergeApproved;
  change: AmuxDmT2MergeChangeNow;
  /** Without one, the allow list. */
  scope?: QaReleaseDmMergeScope;
  /** The patch the publisher applied, as the engineering agent stored it; read in the block list scope only. */
  patch?: string | null;
  /** The whole text at the approved head of every path amuxDmT2MergeFilesToRead names; block list scope only. */
  files?: ReadonlyMap<string, string | null> | null;
}): { holds: true } | { holds: false; reason: AmuxDmT2MergeSkipReason; paths?: string[] } {
  const { approved, change } = input;
  const scope = input.scope ?? "allowlist";
  if (!SHA.test(approved.approvedHeadSha) || !DIGEST.test(approved.approvedDiffDigest) ||
      !AMUX_DM_T2_MERGE_HEAD.test(approved.headRef)) return { holds: false, reason: "head_moved" };
  if (change.state !== "open") return { holds: false, reason: "pull_closed" };
  // A fork's pull request is never on the automatic path (review r-20261113-141554-d75157).
  if (change.crossRepository !== false) return { holds: false, reason: "fork_pr" };
  if (change.baseRef !== "develop") return { holds: false, reason: "base_not_develop" };
  if (change.headRef !== approved.headRef) return { holds: false, reason: "branch_moved" };
  if (change.headSha !== approved.approvedHeadSha) return { holds: false, reason: "head_moved" };
  if (change.diffDigest === null) return { holds: false, reason: "diff_unreadable" };
  if (change.diffDigest !== approved.approvedDiffDigest) return { holds: false, reason: "diff_changed" };
  const gate = amuxDmT2MergeGate(change.changedFiles, scope);
  if (!gate.pass) return { holds: false, reason: gate.reason, paths: gate.paths };
  if (scope !== "blocklist") return { holds: true };
  const patch = amuxDmT2MergePatchGate(input.patch ?? null, scope);
  if (!patch.pass) return { holds: false, reason: patch.reason, paths: patch.paths };
  const files = amuxDmT2MergeFileGate(change.changedFiles, input.files, scope);
  return files.pass ? { holds: true } : { holds: false, reason: files.reason, paths: files.paths };
}

export type AmuxDmT2MergeReadyVerdict =
  | { verdict: "ready" }
  | { verdict: "already_ready" }
  | { verdict: "skip"; reason: AmuxDmT2MergeSkipReason; paths?: string[] };

/**
 * Whether a Decision Maker approved pull request, read fresh from GitHub just
 * before the write, may be marked ready: CI admission's App sees it open, into
 * develop, on the approved branch and head, and its change still holds
 * (amuxDmT2MergeChangeVerdict). A pull request already ready needs nothing.
 * Anything unread or different is skipped this round and read again later.
 */
export function amuxDmT2MergeReadyVerdict(input: {
  approved: AmuxDmT2MergeApproved;
  pull: AmuxDmT2MergePullNow | null;
  change: AmuxDmT2MergeChangeNow;
  scope?: QaReleaseDmMergeScope;
  patch?: string | null;
  files?: ReadonlyMap<string, string | null> | null;
}): AmuxDmT2MergeReadyVerdict {
  const { approved, pull, change } = input;
  if (!SHA.test(approved.approvedHeadSha) || !DIGEST.test(approved.approvedDiffDigest) ||
      !AMUX_DM_T2_MERGE_HEAD.test(approved.headRef)) return { verdict: "skip", reason: "head_moved" };
  if (pull === null || !pull.open) return { verdict: "skip", reason: "pull_closed" };
  if (pull.fork !== false) return { verdict: "skip", reason: "fork_pr" };
  if (pull.base !== "develop") return { verdict: "skip", reason: "base_not_develop" };
  if (pull.head !== approved.headRef) return { verdict: "skip", reason: "branch_moved" };
  if (pull.headSha !== approved.approvedHeadSha) return { verdict: "skip", reason: "head_moved" };
  if (!pull.draft) return { verdict: "already_ready" };
  // A person's hold stands: ci:hold is lifted only by a person (AGENTS.md), and a ready would start CI past it.
  if ((pull.labels ?? []).includes(CI_ADMISSION_HOLD_LABEL)) return { verdict: "skip", reason: "ci_hold" };
  const held = amuxDmT2MergeChangeVerdict({ approved, change, scope: input.scope, patch: input.patch, files: input.files });
  return held.holds ? { verdict: "ready" } :
    { verdict: "skip", reason: held.reason, ...(held.paths ? { paths: held.paths } : {}) };
}
