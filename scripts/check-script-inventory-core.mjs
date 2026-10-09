/**
 * Which `check:*` scripts are gates, and which are tools that need something.
 *
 * Running every `check:*` script and counting the non-zero exits gives the
 * wrong number. On 2026-10-03 that enumeration produced 8 failures, and 7 of
 * them were not findings: five are tools that refuse without a required
 * argument, and two need a credential or an explicit opt-in. Nothing in the
 * name `check:` says which, so the only way to learn it was to read 8 logs --
 * and a reader who stops early writes "8 check scripts fail here" into a note,
 * which is how this repository spent three weeks believing two already-fixed
 * cross-platform defects were quirks of one machine.
 *
 * ## Why a declared list and not a probe
 *
 * Probing means running all 70, which took about 15 minutes. A declared list
 * answers instantly and can be wrong, so the test does the part a list cannot:
 * it spawns every entry's refusal path and reads the exit code, so a tool that
 * gains a default fails here instead of being silently excused. The list says
 * what we decided; the test says whether the tree still agrees.
 *
 * ## The reading has to be taken with the credentials unset
 *
 * The first enumeration of these 70 was taken in a shell that happened to have
 * `OPENAI_API_KEY` set, so `check:openai-model-access` passed and was filed as
 * a gate. It is not: with the key absent it exits 1. A count of failing check
 * scripts is therefore a statement about an environment as much as about a
 * tree, and this list is the credential-free reading.
 *
 * ## This is a report, not a gate
 *
 * It fails nothing. A check script that needs an argument is not a defect, and
 * promoting this to a gate would mean the inventory could block a release over
 * its own staleness.
 */

/**
 * Tools that exit non-zero until given an argument.
 *
 * `flag` is what they demand first; a tool may want more than one. `reason`
 * says why there is no sensible default -- without it the next reader is left
 * wondering whether the tool is merely unfinished.
 */
export const ARGUMENT_REQUIRED_CHECKS = [
  {
    script: "check:memory-eval-run",
    flag: "--artifact=<path>",
    reason:
      "Judges one eval run's artifact. There is no current run to default to, and guessing one would admit an arbitrary file as evidence.",
  },
  {
    script: "check:router-answer-bundle",
    flag: "--bundle=<answer-bundle.jsonl>",
    reason:
      "Reads a named answer bundle against a named evaluation set. Both identify a specific measurement, so neither has a default.",
  },
  {
    script: "check:router-review-source",
    flag: "--bundle=<answers.jsonl>",
    reason:
      "Checks a bundle against the preregistration it was produced under. Pairing it with any other preregistration would report on a comparison nobody made.",
  },
  {
    script: "check:router-review-sheets",
    flag: "--draw=<directory>",
    reason:
      "Validates one drawn review set. The directory is the draw's identity.",
  },
  {
    script: "check:edge-robots",
    flag: "<origin>",
    reason:
      "Asks a deployed origin what it serves. There is no local answer: the thing under test is a running deployment.",
  },
];

/**
 * Gates that cannot run without a credential or an explicit opt-in.
 *
 * Distinct from the above: these take no argument and would run at HEAD if the
 * environment allowed it. In CI, with the environment present, they are gates.
 */
export const ENVIRONMENT_REQUIRED_CHECKS = [
  {
    script: "check:openai-model-access",
    requires: "OPENAI_API_KEY",
    reason:
      "Asks OpenAI which models the key can see. Without the key it reports `no_api_key` and exits 1, because a missing key is not evidence the models are unavailable. This one is why the inventory is measured with the credentials unset: the first reading of it passed only because the key happened to be present.",
  },
  {
    script: "check:fal-image-pricing",
    requires: "FAL_KEY",
    reason:
      "Reads fal's published price for an enabled model. Without the key no lookup is attempted, and it fails closed rather than assuming the approved credit still holds.",
  },
  {
    script: "check:email-synthetic-probe",
    requires: "EMAIL_SYNTHETIC_PROBE_ENABLED=true",
    reason:
      "This check writes. It is off by default so that enumerating the check scripts cannot send mail.",
  },
];

/** Every script this inventory has an opinion about. */
export const classifiedScripts = () => [
  ...ARGUMENT_REQUIRED_CHECKS.map((entry) => entry.script),
  ...ENVIRONMENT_REQUIRED_CHECKS.map((entry) => entry.script),
];

/**
 * What to expect of one `check:*` script at a clean HEAD.
 *
 * `gate` is the default and the majority: it should pass, and a non-zero exit
 * is a finding. The other two should not be counted as findings without first
 * supplying what they name.
 */
export const classifyCheckScript = (script) => {
  if (ARGUMENT_REQUIRED_CHECKS.some((entry) => entry.script === script)) {
    return "argument_required";
  }
  if (ENVIRONMENT_REQUIRED_CHECKS.some((entry) => entry.script === script)) {
    return "environment_required";
  }
  return "gate";
};

/**
 * The inventory as text, grouped.
 *
 * `scripts` is every `check:*` name the manifest declares, passed in so this
 * module reads no files.
 */
export const describeInventory = (scripts) => {
  const gates = scripts.filter((script) => classifyCheckScript(script) === "gate");
  const lines = [
    `${scripts.length} check script(s): ${gates.length} gate(s), ` +
      `${ARGUMENT_REQUIRED_CHECKS.length} needing an argument, ` +
      `${ENVIRONMENT_REQUIRED_CHECKS.length} needing a credential or opt-in.`,
    "",
    "Gates -- expected to pass at a clean HEAD. A non-zero exit here is a finding:",
    ...gates.map((script) => `  ${script}`),
    "",
    "Tools -- they refuse until given an argument. Not findings:",
    ...ARGUMENT_REQUIRED_CHECKS.map(
      (entry) => `  ${entry.script}  ${entry.flag}\n    ${entry.reason}`
    ),
    "",
    "Gates that need an environment. Not findings until it is supplied:",
    ...ENVIRONMENT_REQUIRED_CHECKS.map(
      (entry) => `  ${entry.script}  ${entry.requires}\n    ${entry.reason}`
    ),
    "",
    "This is a report. It fails nothing, and it does not run any of them.",
  ];
  return lines.join("\n");
};
