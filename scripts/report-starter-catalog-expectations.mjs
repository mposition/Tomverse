/**
 * What the Chat starter gallery should show, for every viewer and every flag
 * combination this deployment can be in.
 *
 *   npm run report:starter-catalog-expectations
 *   npm run report:starter-catalog-expectations -- --image=on --voice=off --brave=on
 *
 * Contract: docs/ui-contracts/chat-starter-catalog.md.
 *
 * ## Why this exists
 *
 * The staging verification asks one question over and over: "is this the set of
 * cards that should be here?" A person cannot answer that from the screen
 * alone -- the answer depends on two feature flags, four capabilities, the
 * viewer's plan and a screen cap with a reserved slot, and working it out by
 * hand at 1am is how a wrong answer gets signed as a right one.
 *
 * So the answer key is computed, from the same pure functions the application
 * calls. `selectVisibleStarterCards` is the one the browser runs; if this
 * report and the screen ever disagree, one of them is a defect, and that is
 * exactly what the verification is looking for.
 *
 * It reads nothing and reaches nothing: no database, no network, no
 * credentials. The deployment's own state arrives as command-line flags,
 * because this container cannot see staging and must not pretend to.
 *
 * AGENTS.md, "사람에게 남기는 것은 사람만 할 수 있는 것뿐입니다": counting and
 * collation are the agent's work. What is left for the person is looking at
 * the screen and deciding whether it matches.
 */

import {
  CHAT_STARTER_CATALOG,
  CHAT_STARTER_FLAG_KEYS,
  STARTER_CAPABILITY_IDS,
} from "../lib/chatStarterCatalog.ts";
import {
  CHAT_STARTER_MAX_VISIBLE,
  chatStarterAvailability,
  selectVisibleStarterCards,
} from "../lib/chatStarterAvailability.ts";
import { resolveChatStarterCapabilities } from "../lib/chatStarterCapabilityResolution.ts";
import { IMAGE_GENERATION_FLAG_KEY } from "../lib/imageGenerationAccess.ts";
import { VOICE_INPUT_FLAG_KEY } from "../lib/voiceInputAccess.ts";
import { en } from "../locales/en.ts";

const argument = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const onOff = (name, fallback) => {
  const raw = argument(name, fallback);
  if (raw !== "on" && raw !== "off") {
    console.error(`--${name} takes "on" or "off"; got ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  return raw === "on";
};

// The deployment's own state. Defaults are the conservative reading: the two
// rollout flags off, which is what a fresh environment holds.
const imageOn = onOff("image", "off");
const voiceOn = onOff("voice", "off");
// Whether this process can reach the application-managed search backend. It
// decides the `web-search` capability alongside the models' native paths.
const braveOn = onOff("brave", "on");

const capabilities = resolveChatStarterCapabilities({
  webSearchBackendReadiness: { brave: braveOn },
});

const flagAnswers = {
  [IMAGE_GENERATION_FLAG_KEY]: imageOn,
  [VOICE_INPUT_FLAG_KEY]: voiceOn,
};
const knownFlags = new Set(
  CHAT_STARTER_FLAG_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(flagAnswers, key)
  )
);
const enabledFlags = new Set([...knownFlags].filter((key) => flagAnswers[key]));

const readKey = (key) =>
  key.split(".").reduce((node, part) => (node ?? {})[part], en);

const VIEWERS = [
  { label: "Guest (not signed in)", signedIn: false, plan: null },
  { label: "Signed in, Free", signedIn: true, plan: "Free" },
  { label: "Signed in, Pro", signedIn: true, plan: "Pro" },
  { label: "Signed in, Max", signedIn: true, plan: "Max" },
];

console.log("Chat starter gallery — expected cards on screen\n");
console.log("Deployment state this answer key assumes:");
console.log(`  ${IMAGE_GENERATION_FLAG_KEY} = ${imageOn}`);
console.log(`  ${VOICE_INPUT_FLAG_KEY} = ${voiceOn}`);
console.log(`  application-managed search backend reachable = ${braveOn}`);
console.log(
  `  capabilities that resolve = ${capabilities.join(", ") || "(none)"}`
);
const unresolved = STARTER_CAPABILITY_IDS.filter(
  (id) => !capabilities.includes(id)
);
if (unresolved.length > 0) {
  console.log(`  capabilities that do NOT resolve = ${unresolved.join(", ")}`);
}
console.log(
  `  registry size = ${CHAT_STARTER_CATALOG.length}, screen cap = ${CHAT_STARTER_MAX_VISIBLE}\n`
);
console.log(
  "If the screen shows a card this table does not, or omits one it does,\n" +
    "that is the finding. Do not reconcile it by reasoning on the spot.\n"
);

for (const viewer of VIEWERS) {
  const state = {
    signedIn: viewer.signedIn,
    plan: viewer.plan,
    enabledFlags,
    knownFlags,
    modelCapabilities: new Set(capabilities),
  };
  const shown = selectVisibleStarterCards(state);
  const shownIds = new Set(shown.map((card) => card.entry.id));

  console.log(`## ${viewer.label}`);
  console.log(`   ${shown.length} card(s) on screen, in this order:\n`);
  shown.forEach((card, index) => {
    const lock =
      card.availability.state === "locked"
        ? card.availability.reason === "plan_required"
          ? `LOCKED — needs ${card.availability.minimumPlan}`
          : "LOCKED — needs sign-in"
        : "runnable";
    console.log(`   ${index + 1}. [${lock}] ${card.entry.id}`);
    console.log(`      "${readKey(card.entry.outcomeKey)}"`);
  });

  const absent = CHAT_STARTER_CATALOG.filter(
    (entry) => !shownIds.has(entry.id)
  );
  if (absent.length > 0) {
    console.log("\n   Must NOT appear:");
    for (const entry of absent) {
      const verdict = chatStarterAvailability(entry, state);
      const why =
        verdict.state === "hidden"
          ? verdict.reason
          : "cut by the screen cap (it is offerable, just not in the top N)";
      console.log(`   -  ${entry.id} — ${why}`);
    }
  }
  console.log("");
}

console.log(
  "With the gallery's own flag off (feature.chatStarterEnabled), none of the\n" +
    "above applies: the surface renders nothing at all — no heading, no frame,\n" +
    "no row height. That is the whole of the off state."
);
