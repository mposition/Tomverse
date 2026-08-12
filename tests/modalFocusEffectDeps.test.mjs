import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * An effect that moves focus must not depend on a callback prop.
 *
 * Callers write `onClose={() => setOpen(false)}`, which is a new function on
 * every render of the caller. An effect listing it re-runs on each of those
 * renders, and when the effect's job is "put focus somewhere", re-running it
 * takes focus away from wherever the person actually is.
 *
 * Two dialogs had it. `UsageLimitModal` opens the credit-pack purchase dialog
 * on top of itself, and `ChatInput` re-renders constantly -- typing,
 * streaming, model-status polling -- so a keyboard visitor could be pulled out
 * of the purchase dialog and back down into the one underneath. It also made
 * the nightly visual regression flip on identical commits: run 6 passed and
 * run 7 failed on 18d1e891, on the assertion that the purchase dialog's first
 * button is focused, decided by which requestAnimationFrame landed last.
 * `DeepResearchSetupSheet` had the same shape, where the cost is quieter and
 * just as real: tab to the depth control, the chat behind re-renders, and you
 * are back at Close.
 *
 * The fix in both was to split the effect -- focus keyed on `open` alone, the
 * key handler keeping its `onClose` dependency, because swapping a listener
 * moves no focus. This pins that split rather than the two files.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * `.ts` as well as `.tsx`: the rule is about effects, and a hook that owns a
 * dialog's focus is a `.ts` file with no JSX in it. Scanning only components
 * missed `useModalDialog`, which is the one place the bug reaches every modal
 * at once.
 */
const reactSources = (dir, found = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) reactSources(full, found);
    else if (extname(entry) === ".tsx" || extname(entry) === ".ts")
      found.push(full);
  }
  return found;
};

/**
 * Effects paired with their dependency list. Deliberately a scan rather than a
 * parse: it only has to find `useEffect(() => { ... }, [deps])`, and a parser
 * would be a much larger thing to keep correct for one rule.
 */
const effects = (source) =>
  [...source.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[([^\]]*)\]\);/g)].map(
    (match) => ({ body: match[1], deps: match[2] })
  );

/**
 * Focus *scheduled by the effect running* -- the mount/open kind. Written as
 * "a rAF or timeout whose callback focuses something", which is what both
 * dialogs did and what re-running the effect repeats.
 *
 * Focus moved from inside an event handler is deliberately not matched: a Tab
 * trap has to move focus, and it has to see the current `onClose`, so its
 * effect keeps that dependency and re-subscribing costs nothing.
 */
const SCHEDULES_FOCUS =
  /(?:requestAnimationFrame|setTimeout)\(\s*\(\)\s*=>[\s\S]{0,200}?\.focus\(/;
const CALLBACK_PROP = /^on[A-Z]/;

test("no effect that schedules focus depends on a callback prop", () => {
  const offenders = [];
  for (const file of [
    ...reactSources(join(root, "components")),
    ...reactSources(join(root, "app")),
  ]) {
    const source = readFileSync(file, "utf8");
    for (const effect of effects(source)) {
      if (!SCHEDULES_FOCUS.test(effect.body)) continue;
      const callbacks = effect.deps
        .split(",")
        .map((dep) => dep.trim())
        .filter((dep) => CALLBACK_PROP.test(dep));
      if (callbacks.length > 0) {
        offenders.push(`${relative(root, file)} — [${effect.deps.trim()}]`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "An effect that schedules focus and lists a callback prop re-runs on every caller " +
      "render and pulls focus back. Split it: focus keyed on `open`, the key " +
      "handler keeping the callback.\n" +
      offenders.join("\n")
  );
});

test("the shared modal hook keeps focus and keys in separate effects", () => {
  // Named because this one file decides the behaviour of every `aria-modal`
  // surface in the product. Its single effect both *returned* focus to the
  // trigger on teardown and *placed* focus in the panel on setup, so an
  // unstable `onClose` moved focus twice per caller render -- measured on
  // `ComparisonReviewDialog`, where focus left the source-grounding info
  // control for the dialog's Close button ~50ms after landing, with no key
  // pressed.
  const source = readFileSync(join(root, "components/useModalDialog.ts"), "utf8");
  const all = effects(source);
  const focusEffects = all.filter((effect) => SCHEDULES_FOCUS.test(effect.body));
  assert.equal(
    focusEffects.length,
    1,
    "useModalDialog should schedule focus in exactly one effect"
  );
  assert.equal(
    focusEffects[0].deps.includes("onClose"),
    false,
    "the focus effect must not depend on onClose"
  );
  // The other half has to still exist, and has to still see the current
  // `onClose` -- an Escape handler pinned to a stale closure closes nothing.
  const keyEffects = all.filter(
    (effect) =>
      effect.body.includes('addEventListener("keydown"') &&
      !SCHEDULES_FOCUS.test(effect.body)
  );
  assert.equal(keyEffects.length, 1, "the key handlers should be their own effect");
  assert.ok(
    keyEffects[0].deps.includes("onClose"),
    "the key effect must keep its onClose dependency"
  );
  // Focus return lives with focus placement, not with the listeners: it is the
  // teardown half of the same pair, and separating them would restore the
  // trigger on every caller render.
  assert.ok(
    focusEffects[0].body.includes("returnTarget.focus"),
    "focus return belongs in the focus effect"
  );
});

test("the two dialogs that had it still keep focus and keys apart", () => {
  // Named explicitly, because the scan above can only see the shape. If either
  // file is rewritten into one effect again, the scan catches it -- but this
  // says which files the rule was written for and why they matter.
  for (const file of [
    "components/chat/UsageLimitModal.tsx",
    "components/chat/DeepResearchSetupSheet.tsx",
  ]) {
    const source = readFileSync(join(root, file), "utf8");
    const focusEffects = effects(source).filter((effect) =>
      SCHEDULES_FOCUS.test(effect.body)
    );
    assert.ok(focusEffects.length > 0, `${file} has no focus effect at all`);
    for (const effect of focusEffects) {
      assert.equal(
        effect.deps.trim(),
        "open",
        `${file}: the focus effect must be keyed on \`open\` alone`
      );
    }
  }
});
