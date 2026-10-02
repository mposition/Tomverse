// The decisions the observation runner makes before and around its IO.
//
// Separated from the script so they can be tested without git, a network or a
// clock: which variables the service may have, whether this process is allowed
// to submit, and how its two deadlines relate to the route's own limit.
//
// Railway's cron skips the next run while one is still going and never ends the
// one that hung, so a run that stops making progress silently stops every run
// after it. The deadlines here are what make that impossible: the process ends
// at its hard deadline whatever state it is in, and a normal finish clears both
// timers instead of waiting for them.

/** Variables the Agent project's IaC declares for this service, and nothing else. */
export const DECLARED_SERVICE_VARIABLES = [
  "PRODUCT_RESEARCH_AGENT_ENABLED",
  "PRODUCT_RESEARCH_INGEST_URL",
  "PRODUCT_RESEARCH_INGEST_SECRET",
  "PRODUCT_RESEARCH_GITHUB_READ_TOKEN",
  // The builder needs git in the deployed image; the deployed image has none.
  "RAILPACK_DEPLOY_APT_PACKAGES",
];

/**
 * Names the container itself provides.
 *
 * Deliberately short and extended only by what S0 observed in the real image:
 * the point of the check below is that an unexpected *name* stops the run, and
 * a generous list defeats it. `RAILWAY_` is matched by prefix because the
 * platform adds to that family on its own.
 */
export const SYSTEM_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "HOSTNAME",
  "PWD",
  "SHLVL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_VERSION",
  "NODE_ENV",
  "NPM_CONFIG_CACHE",
  "NIXPACKS_PATH",
  "RAILPACK_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // The rest of what `npm run` adds, which has no shared prefix: the
  // directory npm was invoked from, the node binary it found, two values it
  // copies out of its own config, and the shell's last-argument variable.
  "INIT_CWD",
  "NODE",
  "COLOR",
  "EDITOR",
  "_",
];

/**
 * Families the container and the process launcher add to on their own.
 *
 * `RAILWAY_` is the platform's. `npm_` is there because the service's start
 * command is `npm run`, and npm puts twenty-odd of its own variables into the
 * child -- a run that refused them would refuse every correctly configured
 * production run before it planned anything. Allowing the family is only an
 * allowance of *names*: a value shaped like a database connection string is
 * still refused whatever it is called.
 */
export const SYSTEM_ENVIRONMENT_PREFIXES = ["RAILWAY_", "npm_"];

/**
 * Names Windows provides to every child process whatever environment is passed.
 *
 * The deployed service is Linux and never sees these, so this list widens
 * nothing there -- it exists so the runner can be exercised on a developer
 * machine, where Node adds them back even to an environment built from
 * nothing. Chosen by platform rather than merged into the list above, because
 * the list above is what says a product database credential cannot be here and
 * every name added to it costs some of that.
 */
export const WINDOWS_ENVIRONMENT_NAMES = [
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SystemDrive",
  "SYSTEMROOT",
  "SystemRoot",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

/** The system names to allow on this platform. */
export const systemNamesForPlatform = (platform) =>
  platform === "win32"
    ? [...SYSTEM_ENVIRONMENT_NAMES, ...WINDOWS_ENVIRONMENT_NAMES]
    : SYSTEM_ENVIRONMENT_NAMES;

/**
 * Value shapes that say a database credential reached this service.
 *
 * The real boundary is the Agent project: it holds no database service and no
 * shared variables, so there is nothing for a reference variable to resolve to.
 * This check is the accident -- a connection string pasted into a variable by
 * hand -- and it is not evidence of the boundary.
 */
const DATABASE_URL_SHAPES =
  /^(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis(s)?|prisma(\+postgres)?|jdbc|libsql):/i;

/** Hosts a submission URL may reach over plain http, and only over http. */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

const SECRET_VARIABLE_NAMES = new Set([
  "PRODUCT_RESEARCH_INGEST_SECRET",
  "PRODUCT_RESEARCH_GITHUB_READ_TOKEN",
]);

/**
 * What is wrong with this process's environment, by name only.
 *
 * Never returns a value. A problem report is printed and stored, and a
 * credential in it would be the leak the check exists to prevent.
 */
export const environmentProblems = (
  env,
  { declared = DECLARED_SERVICE_VARIABLES, systemNames = SYSTEM_ENVIRONMENT_NAMES } = {}
) => {
  const problems = [];
  const allowed = new Set([...declared, ...systemNames]);

  for (const [name, value] of Object.entries(env)) {
    const known =
      allowed.has(name) ||
      SYSTEM_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (!known) {
      problems.push(`${name} is not a variable this service declares`);
      continue;
    }
    if (typeof value === "string" && DATABASE_URL_SHAPES.test(value.trim())) {
      problems.push(`${name} holds what looks like a database connection string`);
    }
  }

  return problems;
};

/** The UTC instant the cron is scheduled for, and how long after it a run may submit. */
export const OBSERVATION_SLOT_UTC = { hour: 21, minute: 30 };
export const SLOT_WINDOW_MS = 60 * 60 * 1000;

/** The slot a moment belongs to: today's scheduled instant, in UTC. */
export const slotForInstant = (instant) => {
  const slot = new Date(instant);
  slot.setUTCHours(OBSERVATION_SLOT_UTC.hour, OBSERVATION_SLOT_UTC.minute, 0, 0);
  // Before today's slot the run belongs to yesterday's: a cron that fires at
  // 21:30 and finishes at 21:31 is in the same slot, and one that somehow runs
  // at 00:05 is still answering for the slot that just passed.
  if (instant < slot.getTime()) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot.toISOString();
};

/** Whether a moment is inside the window the slot accepts a submission in. */
export const withinSlotWindow = (instant, slotIso, windowMs = SLOT_WINDOW_MS) => {
  const slot = Date.parse(slotIso);
  return instant >= slot && instant < slot + windowMs;
};

/**
 * The timings of one run.
 *
 * `submitAbortMs` has to be at least the route's own `maxDuration`, or the
 * runner gives up on a request the route is still allowed to be serving and a
 * slow healthy run is recorded as a failure -- `tests/cronClientTimeouts.test.mjs`
 * holds that for every cron runner in this repository. And a submission may
 * only start while there is time for it to finish before the hard deadline,
 * because a process killed mid-request is the one case where the run does not
 * know whether its row exists.
 */
export const DEFAULT_RUN_TIMINGS = {
  hardMs: 15 * 60 * 1000,
  prepareMs: 14 * 60 * 1000,
  submitAbortMs: 40 * 1000,
  routeMaxDurationMs: 30 * 1000,
  submitMarginMs: 10 * 1000,
};

export const runTimingProblems = (timings = DEFAULT_RUN_TIMINGS) => {
  const problems = [];
  if (timings.submitAbortMs < timings.routeMaxDurationMs) {
    problems.push("the runner would give up before the route is allowed to finish");
  }
  if (timings.prepareMs >= timings.hardMs) {
    problems.push("preparation has no time to be cut short before the hard deadline");
  }
  if (
    timings.prepareMs + timings.submitAbortMs + timings.submitMarginMs >
    timings.hardMs
  ) {
    problems.push("a timeout envelope could not be submitted before the hard deadline");
  }
  return problems;
};

/**
 * What the run does, decided from the environment alone.
 *
 * Dark is not a failure: an unset switch means the service exists and is not
 * meant to do anything, so it does no clone, no GitHub call and no submission.
 */
export const planRun = (env, options = {}) => {
  if (!env.PRODUCT_RESEARCH_AGENT_ENABLED) return { mode: "dark" };

  const problems = environmentProblems(env, options);

  const url = env.PRODUCT_RESEARCH_INGEST_URL ?? "";
  const secret = env.PRODUCT_RESEARCH_INGEST_SECRET ?? "";
  const token = env.PRODUCT_RESEARCH_GITHUB_READ_TOKEN ?? "";

  if (!url) problems.push("PRODUCT_RESEARCH_INGEST_URL is not set");
  else {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed) problems.push("PRODUCT_RESEARCH_INGEST_URL is not a URL");
    else if (parsed.protocol !== "https:") {
      // The loopback exception is for a local route served without TLS, so it
      // is an exception to `https` only -- not to HTTP. A scheme fetch() will
      // not speak reaches the run as a failed submission rather than as the
      // configuration mistake it is.
      const loopbackHttp =
        parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.includes(parsed.hostname);
      if (!loopbackHttp) problems.push("PRODUCT_RESEARCH_INGEST_URL is not https");
    }
  }

  // Length only: the value never leaves this process except as a header.
  if (!secret) problems.push("PRODUCT_RESEARCH_INGEST_SECRET is not set");
  else if (secret.length < 32) {
    problems.push("PRODUCT_RESEARCH_INGEST_SECRET is shorter than 32 characters");
  }
  if (!token) problems.push("PRODUCT_RESEARCH_GITHUB_READ_TOKEN is not set");

  if (problems.length > 0) return { mode: "config", problems };
  return { mode: "run", config: { ingestUrl: url, ingestSecret: secret, githubToken: token } };
};

/** Variable names whose values may never be printed, logged or stored. */
export const isSecretVariableName = (name) => SECRET_VARIABLE_NAMES.has(name);

/**
 * The run's single state, in one direction.
 *
 * Two things can decide to submit: the run that finished preparing, and the
 * watchdog that gave up on it. Exactly one of them may, and whichever starts
 * first wins -- a second submission after an unknown outcome is how the same
 * slot gets two different answers.
 */
export const createRunState = () => {
  let state = "PREPARE";
  let exitCode = null;

  return {
    get state() {
      return state;
    },
    get exitCode() {
      return exitCode;
    },
    /** True exactly once, for whoever gets there first. */
    beginSubmit() {
      if (state !== "PREPARE") return false;
      state = "SUBMITTING";
      return true;
    },
    /** Ends the run. The caller clears its timers here, not in a timer. */
    finish(code) {
      if (state === "DONE") return false;
      state = "DONE";
      exitCode = code;
      return true;
    },
    /** What a watchdog firing at this moment is allowed to do. */
    watchdogAction(kind) {
      if (state === "DONE") return "nothing";
      if (kind === "hard") return "exit";
      return state === "PREPARE" ? "submit-timeout" : "nothing";
    },
  };
};

/**
 * The git version the clone this agent makes needs.
 *
 * `--filter=blob:none` arrived in git 2.19. The probe reports the version it
 * found rather than asking git whether it understands the flag: `git clone
 * --filter=... --help` opens a manual page, and its exit status says whether
 * the manual opened, not whether the filter works.
 */
export const MINIMUM_GIT_VERSION = [2, 19, 0];

/** The three numbers in `git version 2.55.0.windows.3`, or null. */
export const parseGitVersion = (output) => {
  const match = /\bgit version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(output ?? ""));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
};

/** Whether this git can make the bare partial clone the run depends on. */
export const gitSupportsPartialClone = (output, minimum = MINIMUM_GIT_VERSION) => {
  const version = parseGitVersion(output);
  if (!version) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] > minimum[index]) return true;
    if (version[index] < minimum[index]) return false;
  }
  return true;
};
