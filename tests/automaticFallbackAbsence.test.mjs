import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * FALLBACK-02: "Automatic fallback never starts after a visible token."
 *
 * `npm run report:release-gate-evidence` says of this gate: "The invariant --
 * never fall back after a visible token -- is testable here and is not tested."
 * This is that test, and it proves something stronger than the gate asks.
 *
 * The gate's metric is `automatic_fallbacks_after_visible_token == 0`. In this
 * tree that number is zero because **there is no automatic model substitution
 * at all**, before a visible token or after one. Two places name an alternative
 * model, and neither switches anything:
 *
 *   - `/api/models/status` offers candidates for an incident banner. Its own
 *     module says it "never swaps a model in on the user's behalf": when
 *     nothing healthy is left it returns an empty list and `none` rather than
 *     printing something that reads like a safe alternative.
 *   - a provider-budget refusal lists models the user can still reach. That
 *     happens in the reservation path, before any stream exists, and it is a
 *     sentence in an error response, not a redirect.
 *
 * Both leave the choice with the person. So the property to hold is the
 * absence of the mechanism, which is a much easier thing to check than "it
 * never happens late" -- and a much harder thing to break by accident.
 *
 * Written as a scan rather than a runtime assertion for the same reason
 * `check:shared-packages` scans for forbidden imports: a runtime test can only
 * report on the paths it happens to drive, and the claim here is about every
 * path there is.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const CHAT_ROUTE = "app/api/chat/route.ts";

/**
 * Every call site of the streaming primitive, with the identifier passed as
 * its `model`. A second call site, or a `model` that is an expression rather
 * than a plain name, is how an automatic substitution would have to arrive.
 */
export const streamModelArguments = (source) => {
  const found = [];
  // Brace-matched rather than indentation-matched: the call sits at whatever
  // depth its enclosing block puts it, and a regex anchored to one indent
  // silently finds nothing at another -- which reads as "no fallback" for the
  // wrong reason.
  for (const match of source.matchAll(/streamText\(\{/g)) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    const options = source.slice(match.index + match[0].length, index - 1);
    // Top level of the options object only: a `model:` nested inside another
    // option is not the model the call runs.
    const model = /(?:^|\n)\s*model:\s*([^,\n]+)/.exec(
      options.replace(/\{[^{}]*\}/g, "{}")
    );
    found.push(model ? model[1].trim() : null);
  }
  return found;
};

/** `const NAME = ...` / `let NAME = ...` / `NAME = ...`, counted. */
export const assignmentCount = (source, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...source.matchAll(
      new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=|(?:^|[;{}\\n])\\s*${escaped}\\s*=[^=]`, "g")
    ),
  ].length;
};

const sourceFiles = (dir, found = []) => {
  for (const entry of readdirSync(join(root, dir))) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(join(root, full)).isDirectory()) sourceFiles(full, found);
    else if ([".ts", ".tsx"].includes(extname(entry))) found.push(full);
  }
  return found;
};

test("the chat answer is streamed from exactly one model", () => {
  const source = read(CHAT_ROUTE);
  const models = streamModelArguments(source);
  assert.equal(
    models.length,
    1,
    `Expected one streamText call in ${CHAT_ROUTE}, found ${models.length}. ` +
      "A second one is how a fallback would be retried against a different model."
  );
  const [model] = models;
  assert.ok(model, "the streamText call must pass an explicit model");
  // A bare identifier, not `candidates[i]`, not `next ?? current`, not a call.
  assert.match(
    model,
    /^[A-Za-z_$][\w$]*$/,
    `streamText's model is \`${model}\`. An expression here is where a candidate ` +
      "list would be selected from; it has to be a single resolved model."
  );
  assert.equal(
    assignmentCount(source, model),
    1,
    `\`${model}\` is assigned more than once in ${CHAT_ROUTE}. Reassigning the ` +
      "model is the other way a substitution arrives, without a second call site."
  );
});

test("the streamed model does not come from the fallback table", () => {
  // The table is a suggestion surface. If the value handed to streamText were
  // ever derived from it, the check above would still pass -- one call, one
  // identifier -- while the product had begun choosing for the user.
  const source = read(CHAT_ROUTE);
  const [model] = streamModelArguments(source);
  const declaration = new RegExp(`const\\s+${model}\\s*=\\s*([^;]+);`).exec(source);
  assert.ok(declaration, `could not find where \`${model}\` is defined`);
  for (const forbidden of [
    "PROVIDER_FALLBACKS",
    "selectFallbackCandidates",
    "findAlternativeModelsForBlockedProvider",
    "fallback",
  ]) {
    assert.equal(
      declaration[1].includes(forbidden),
      false,
      `\`${model}\` is derived from ${forbidden}, so the stream is not running the ` +
        "model the user chose."
    );
  }
});

test("only the surfaces that offer a choice import the fallback table", () => {
  /**
   * Each entry is a place that may name an alternative model, and what it does
   * with the name. None of them may act on it. A new importer is not
   * automatically wrong -- it is a decision that has to be made here, in the
   * open, with the reason written down.
   */
  const ALLOWED = {
    "lib/providerFallbackCandidates.ts": "the table itself",
    "lib/providerMonitoring.ts":
      "records provider health and the candidates an incident offers",
    "app/api/models/status/route.ts":
      "builds the incident banner's candidate list; returns `none` rather than substituting",
    "lib/chatSecurity.ts":
      "names models still reachable in a provider-budget refusal, before any stream exists",
    "components/chat/ProviderStatusBanner.tsx":
      "renders those candidates for the user to pick from",
  };

  const importers = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")]
    .filter((file) => read(file).includes("providerFallbackCandidates"))
    .map((file) => relative(".", file));

  const unexpected = importers.filter((file) => !(file in ALLOWED));
  assert.deepEqual(
    unexpected,
    [],
    "New importer(s) of the provider fallback table:\n" +
      unexpected.join("\n") +
      "\n\nThe table names models to *offer*. If a new caller acts on one instead " +
      "of showing it, FALLBACK-02 stops holding. Add it here with what it does."
  );

  // The other direction: an allowlist entry that no longer imports anything is
  // a stale permission, and stale permissions are how a list stops being a
  // list of decisions.
  const stale = Object.keys(ALLOWED).filter((file) => !importers.includes(file));
  assert.deepEqual(stale, [], "Allowlist entries that no longer import the table");
});

test("the scan can tell a resolved model from a chosen one", () => {
  // A negative control for the scan itself, on inputs rather than on the tree:
  // if these did not discriminate, the assertions above would pass against a
  // product that had started substituting.
  const single = `const result = await streamText({\n        model: activeModel,\n        messages,\n    });`;
  assert.deepEqual(streamModelArguments(single), ["activeModel"]);

  const fromList = `const result = await streamText({\n        model: candidates[attempt],\n        messages,\n    });`;
  assert.deepEqual(streamModelArguments(fromList), ["candidates[attempt]"]);
  assert.equal(/^[A-Za-z_$][\w$]*$/.test("candidates[attempt]"), false);

  const twice =
    `const a = await streamText({\n        model: activeModel,\n    });\n` +
    `const b = await streamText({\n        model: fallbackModel,\n    });`;
  assert.equal(streamModelArguments(twice).length, 2);

  assert.equal(assignmentCount("const m = one;", "m"), 1);
  assert.equal(assignmentCount("let m = one;\n  m = two;", "m"), 2);
  // `===` is a comparison, not an assignment, and must not be counted as one.
  assert.equal(assignmentCount("const m = one;\n  if (m === two) {}", "m"), 1);
});
