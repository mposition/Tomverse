/**
 * The variable-name comparison O3 of §12 (3) in
 * `docs/policy/trust-safety-compliance-agent.md` assigns to
 * `npm run report:trust-safety-railway-variables`, so an operator runs a
 * command and signs rather than reading a dashboard.
 *
 * ## What it compares
 *
 * Three sets of **names**, never values:
 *
 *  - what §4 of that policy allows the runner service to hold, which is exactly
 *    `TRUST_SAFETY_OBSERVER_SECRET` and `TRUST_SAFETY_OBSERVER_URL`;
 *  - what `.railway/agent-runners.ts` declares for it, that file being the one
 *    declaration site §4 fixes;
 *  - what Railway actually has, per environment.
 *
 * ## Values never enter
 *
 * O3 says to discard them, and §4 says the ping URL must not appear in a log, a
 * manifest or a route response. So the comparison takes name lists, and nothing
 * in this file can hold a value: a caller that passed one would have nowhere to
 * put it.
 *
 * ## Two things it cannot judge
 *
 * §4 names them and requires the manifest to print both as operational
 * confirmation rather than leaving them out: whether a name Railway injects is
 * a credential, and how far the same variable is exposed at the build stage.
 * A report that silently omitted what it cannot see would read as a clean bill.
 *
 * ## Pure
 *
 * No filesystem, no network, no clock. Name lists in, findings out.
 */

/** §4: the runner service holds these two, and that is all. */
export const RUNNER_ALLOWED_NAMES = Object.freeze([
  "TRUST_SAFETY_OBSERVER_SECRET",
  "TRUST_SAFETY_OBSERVER_URL",
]);

/** §4: the ping URL lives in the app's variables, never the runner's. */
export const APP_ONLY_NAMES = Object.freeze(["TRUST_SAFETY_OBSERVER_PING_URL"]);

/**
 * §4 names these four as what the runner must not be given. The list is a
 * prefix match on purpose: a token is rarely spelled the same way twice, and
 * widening the list is an amendment to that policy rather than a change here.
 */
export const RUNNER_FORBIDDEN_PATTERNS = Object.freeze([
  { pattern: /^DATABASE_URL$|^DIRECT_DATABASE_URL$|^TEST_DATABASE_URL$/, because: "a product database credential" },
  { pattern: /^(GITHUB|GH)_/, because: "a GitHub token" },
  {
    pattern: /^(ANTHROPIC|OPENAI|GOOGLE_GENERATIVE_AI|XAI|DEEPSEEK|MISTRAL|MOONSHOT|MINIMAX|PERPLEXITY|ZHIPU|GROQ|DASHSCOPE|NOVA|FAL)_/,
    because: "an LLM provider key",
  },
  { pattern: /^TRUST_SAFETY_OBSERVER_PING_URL$/, because: "the dead-man ping URL, which §4 keeps in the app alone" },
]);

export const UNJUDGED = Object.freeze([
  "Whether a name Railway injects of its own accord is a credential. This reads names, and a name does not say what it holds.",
  "How far the same variable is exposed at the build stage. Railway reports a service's variables, not which of them a build sees.",
]);

const asSet = (names) => (names === undefined ? undefined : new Set(names));
const sorted = (set) => [...set].sort();

const forbiddenReason = (name) =>
  RUNNER_FORBIDDEN_PATTERNS.find((entry) => entry.pattern.test(name))?.because;

/**
 * One environment's comparison.
 *
 * `declared` is what `.railway/agent-runners.ts` says, `effective` what Railway
 * answered. Either being undefined is a fact that could not be read, and this
 * says so rather than treating an absence as an empty set -- an empty set
 * matches an empty allowlist and would read as a pass.
 */
export const compareEnvironment = ({ environment, declared, effective }) => {
  const findings = [];
  const add = (id, title, ok, because) => findings.push({ id, title, ok, because });

  const declaredSet = asSet(declared);
  const effectiveSet = asSet(effective);

  add(
    "declared",
    "the runner is declared for this environment",
    declaredSet === undefined ? undefined : declaredSet.size > 0,
    declaredSet === undefined
      ? "the declaration site could not be read"
      : declaredSet.size === 0
        ? "`.railway/agent-runners.ts` declares no variables for this environment, so no resource is created for it"
        : `declares ${sorted(declaredSet).join(", ")}`,
  );

  add(
    "declared-allowed",
    "every declared name is one §4 allows",
    declaredSet === undefined
      ? undefined
      : sorted(declaredSet).every((name) => RUNNER_ALLOWED_NAMES.includes(name)),
    declaredSet === undefined
      ? "the declaration site could not be read"
      : sorted(declaredSet)
          .filter((name) => !RUNNER_ALLOWED_NAMES.includes(name))
          .map((name) => `${name}${forbiddenReason(name) ? ` (${forbiddenReason(name)})` : ""}`)
          .join(", ") || "all declared names are allowed",
  );

  add(
    "declared-complete",
    "both names §4 requires are declared",
    declaredSet === undefined
      ? undefined
      : RUNNER_ALLOWED_NAMES.every((name) => declaredSet.has(name)),
    declaredSet === undefined
      ? "the declaration site could not be read"
      : RUNNER_ALLOWED_NAMES.filter((name) => !declaredSet.has(name)).join(", ") ||
        "both are declared",
  );

  add(
    "effective-matches-declared",
    "Railway holds exactly the declared names",
    declaredSet === undefined || effectiveSet === undefined
      ? undefined
      : sorted(declaredSet).join(",") === sorted(effectiveSet).join(","),
    declaredSet === undefined || effectiveSet === undefined
      ? "the declaration site or Railway's answer could not be read"
      : (() => {
          const missing = sorted(declaredSet).filter((name) => !effectiveSet.has(name));
          const extra = sorted(effectiveSet).filter((name) => !declaredSet.has(name));
          if (missing.length === 0 && extra.length === 0) return "they match";
          return [
            missing.length ? `declared but not set: ${missing.join(", ")}` : "",
            extra.length ? `set but not declared: ${extra.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ");
        })(),
  );

  add(
    "effective-forbidden",
    "Railway holds none of the names §4 refuses the runner",
    effectiveSet === undefined
      ? undefined
      : sorted(effectiveSet).every((name) => forbiddenReason(name) === undefined),
    effectiveSet === undefined
      ? "Railway's answer could not be read"
      : sorted(effectiveSet)
          .filter((name) => forbiddenReason(name) !== undefined)
          .map((name) => `${name}: ${forbiddenReason(name)}`)
          .join("; ") || "none of them is present",
  );

  const verdict = findings.every((finding) => finding.ok === true)
    ? "match"
    : findings.some((finding) => finding.ok === false)
      ? "mismatch"
      : "unreadable";

  return { environment, verdict, findings };
};

/**
 * The manifest O3 asks for: a per-environment comparison, and the two things
 * nobody can judge from names printed as operational confirmation.
 *
 * A verdict is evidence the operator signs. This writes nothing and gates
 * nothing.
 */
export const buildVariableManifest = ({ environments, appVariableNames }) => {
  const comparisons = (environments ?? []).map(compareEnvironment);

  // The app side is one name, and §4 forbids its value anywhere. Presence of
  // the name is all this can and should say.
  const appSet = asSet(appVariableNames);
  const app = {
    id: "app-ping-url",
    title: "the app holds the ping URL's name, and the runner does not",
    ok: appSet === undefined ? undefined : APP_ONLY_NAMES.every((name) => appSet.has(name)),
    because:
      appSet === undefined
        ? "the app's variable names could not be read"
        : APP_ONLY_NAMES.filter((name) => !appSet.has(name)).join(", ") || "present by name",
  };

  const verdict =
    comparisons.every((entry) => entry.verdict === "match") && app.ok === true
      ? "match"
      : comparisons.some((entry) => entry.verdict === "mismatch") || app.ok === false
        ? "mismatch"
        : "unreadable";

  return {
    verdict,
    allowedRunnerNames: [...RUNNER_ALLOWED_NAMES],
    appOnlyNames: [...APP_ONLY_NAMES],
    comparisons,
    app,
    unjudged: [...UNJUDGED],
    notes: [
      "Names only. No value was read, and none can be: this comparison takes name lists.",
      "A verdict is evidence an operator signs under docs/policy/trust-safety-compliance-agent.md §12 (3) O3. Nothing here was written, and nothing consumes it.",
    ],
  };
};
