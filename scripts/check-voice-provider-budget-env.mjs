// Whether this deployment's audio usage budget is set and usable, without
// turning voice input on to find out.
//
//   npm run check:voice-provider-budget-env
//
// ## The gap this fills
//
// `docs/policy/voice-input.md` §6.1-4 makes the two budget variables required
// in production, and `/api/ready` enforces it -- but only while the voice flag
// is ON. `lib/voiceProviderBudgetReadiness.ts` answers `ready: !flagEnabled ||
// budget.limits !== null`, so with the flag off a missing or malformed budget
// passes readiness, and nothing reports it. That contract is deliberate (a
// deployment that never enabled voice must not be refused traffic over a
// feature nobody turned on), so this does not change it. It gives the operator
// the other half: a way to check the values *before* the flag is flipped,
// which is exactly the env-first order §9.1 asks for.
//
// Without this, the only way to learn that a budget is wrong is to enable
// voice input in production and read the refusal -- which is the sequence the
// env-first rule exists to prevent.
//
// ## Why it prints no numbers
//
// The output is meant to be pasteable into an issue or a verification record
// without review. It reports each variable as set or missing, the resolver's
// own problem codes, and the verdict -- never the values. AGENTS.md asks for
// scripts whose output is safe by construction rather than safe if nobody
// makes a mistake. The numbers are not secret; the habit is what is being
// kept.
//
// ## Where to run it
//
// In the deployment whose environment is being checked -- a Railway service
// shell for staging or production. Run locally and it reports the local
// machine's environment, which is a different question.

import {
  resolveVoiceProviderBudget,
  VOICE_PROVIDER_BUDGET_ENV_NAMES,
} from "../lib/voiceProviderBudget.ts";

const assumeProduction = process.argv.includes("--assume-production");
const production = process.env.NODE_ENV === "production" || assumeProduction;

// `next start` runs with NODE_ENV=production, so staging is production-mode
// too and gets no development fallbacks. Printed rather than assumed: which
// rule applies is the thing most likely to be got wrong from memory.
const mode = production ? "production rule" : "development rule";
const why =
  process.env.NODE_ENV === "production"
    ? "NODE_ENV=production"
    : assumeProduction
      ? "--assume-production"
      : `NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`;

const isSet = (name) => {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "";
};

const { limits, problems } = resolveVoiceProviderBudget(process.env, {
  production,
});

const lines = [
  `Voice provider usage budget (seconds) — ${mode} (${why})`,
  "",
];

for (const name of Object.values(VOICE_PROVIDER_BUDGET_ENV_NAMES)) {
  const own = problems.filter((problem) => problem.envName === name);
  const state = isSet(name) ? "set" : "MISSING";
  // "MISSING — ok" would be a lie of omission outside production: nothing is
  // wrong only because a fallback is standing in for the value.
  const verdict =
    own.length > 0
      ? own.map((problem) => problem.code).join(", ")
      : isSet(name)
        ? "ok"
        : "development fallback applies";
  lines.push(`  ${name}: ${state} — ${verdict}`);
}

// A development fallback is a value nobody chose. Legal outside production and
// never what an operator wants to discover in staging, which runs under the
// production rule anyway.
const fallbacks = Object.values(VOICE_PROVIDER_BUDGET_ENV_NAMES).filter(
  (name) => !isSet(name)
);
if (!production && fallbacks.length > 0) {
  lines.push(
    "",
    `  Using development fallbacks for: ${fallbacks.join(", ")}.`,
    "  These are not a configuration. In production, and in any deployment",
    "  started by `next start`, they do not apply and the value is required."
  );
}

const usable = limits !== null && problems.length === 0;

lines.push("");
if (usable && fallbacks.length > 0) {
  // Usable is not the same as configured. Saying "both values are set" here
  // would be false, and it is the sentence an operator would quote.
  lines.push(
    "  Verdict: usable, but NOT configured — a development fallback is",
    "  standing in for a value nobody chose. This deployment is not ready",
    "  for the flag to be turned on."
  );
} else if (usable) {
  lines.push("  Verdict: usable — both values are set and consistent.");
} else if (limits === null) {
  lines.push("  Verdict: NOT usable — voice input would refuse every request.");
} else {
  lines.push(
    "  Verdict: usable, with a problem reported above.",
    "  Outside production the resolver still returns limits, so this would",
    "  start; under the production rule the same input refuses."
  );
}

lines.push(
  "",
  "  This checks that a budget exists and is consistent, not that the numbers",
  "  are right. Choosing them is docs/ops/voice-provider-budget-rollout.md.",
  "  It reports on the deployment-wide provider budget only — VOICE_INPUT_*",
  "  is the separate per-subject guardrail (§7) and is not read here."
);

const output = lines.join("\n");
if (usable) {
  console.log(output);
} else {
  console.error(output);
  process.exit(1);
}
