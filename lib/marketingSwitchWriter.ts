import "server-only";

import type { PrismaClient } from "@prisma/client";

import { MARKETING_CONFIG_GENERATION_KEY } from "@/lib/appSettings";
import {
  MARKETING_AUTO_PUBLISH_KEY,
  MARKETING_DRAFTS_KEY,
  MARKETING_PUBLISH_KEY,
  marketingAutomationEnabledFromValue,
} from "@/lib/marketingAutomationAccess";
import { type MarketingConsoleSwitch } from "@/lib/marketingConsoleSections";
import type { MarketingTransaction } from "@/lib/marketingStore";

/**
 * The only writer of the three marketing switches, and of the generation that
 * every admission-affecting change moves.
 *
 * It lived in `lib/appSettings.ts` until 2026-09-23, which was the wrong
 * place twice over. It is a server-only marketing writer, so it belongs with
 * marketing; and `lib/appSettings.ts` sits inside the Prompt Refiner runtime
 * source closure, a sealed file set bound into a database CHECK, so importing
 * the branded transaction from there changed a count that contract pins. The
 * import direction here is the safe one: this module reads the settings
 * module, and nothing in the closure reads this one.
 */

export class MarketingSwitchRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketingSwitchRefusedError";
    this.code = code;
  }
}

const switchKey = (name: MarketingConsoleSwitch) =>
  // Named here rather than read from a table so the writer check can see which
  // keys this function writes: it reads the declaration that names a key, and
  // a table lookup names none of them.
  name === "drafts"
    ? MARKETING_DRAFTS_KEY
    : name === "publish"
      ? MARKETING_PUBLISH_KEY
      : MARKETING_AUTO_PUBLISH_KEY;

/**
 * Turns one of the three marketing switches on or off, under compare-and-set.
 *
 * The caller says what it believed the switch was, and a change that no longer
 * matches is refused rather than applied: two consoles open on the same screen
 * would otherwise have the later save silently undo the earlier one, with both
 * audit entries reading "changed". A save that would change nothing is refused
 * too, because an audit row for a change nobody made is worse than no row.
 *
 * Turning one *on* is also checked against what it depends on. Autonomous
 * publishing needs drafts and publishing already on -- enabling it alone would
 * write an audit entry saying autonomous publishing was switched on when
 * nothing can publish. Publishing itself is refused outright: the publisher
 * arrives in S2c, and the plan requires its capability to be available before
 * this switch may be enabled, so until it exists the honest answer is no.
 *
 * Everything commits with the caller's transaction, including the generation
 * bump, so a reader can never see the new value under the old generation.
 */
/**
 * Reads the configuration generation, which is the version token for every
 * admission-affecting setting.
 *
 * Stored as the strict `{ "generation": <positive integer> }` the plan's
 * binding matrix specifies rather than as a bare decimal string: a reader
 * built to that shape could not read what a bare string wrote, and neither
 * could this one read what such a reader seeded. Anything else is refused
 * rather than treated as zero -- a malformed generation is a configuration
 * nobody can bind to, not a fresh one.
 */
const readConfigGeneration = (value: string | undefined): number => {
  if (value === undefined) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MarketingSwitchRefusedError(
      "config_generation_unreadable",
      "The marketing configuration generation is not readable",
    );
  }
  // Strict means strict. An extra key, or a stored zero, is a document written
  // by something that did not agree with this module, and reading it as a
  // generation would bind a decision to a number nobody meant. Absent is the
  // only zero there is.
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Object.hasOwn(parsed, "generation")
  ) {
    throw new MarketingSwitchRefusedError(
      "config_generation_unreadable",
      "The marketing configuration generation is not the document it should be",
    );
  }
  const generation = (parsed as { generation: unknown }).generation;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new MarketingSwitchRefusedError(
      "config_generation_unreadable",
      "The marketing configuration generation is not a whole number above zero",
    );
  }
  return generation;
};

/**
 * Turns one of the three marketing switches on or off, under compare-and-set.
 *
 * The caller says which configuration generation its screen read, and a
 * generation that has moved is refused. That is the version token the plan
 * asks for, and it is the one thing an expected *value* could not be: a switch
 * taken false to true and back to false again reads as unchanged, so a stale
 * screen's "I saw false" was satisfied by a different false. Every change here
 * moves the generation, so a screen that missed one cannot pretend otherwise.
 *
 * A save that would change nothing is refused too, because an audit row for a
 * change nobody made is worse than no row.
 *
 * Turning one *on* is also checked against what it depends on. Autonomous
 * publishing needs drafts and publishing already on -- enabling it alone would
 * write an audit entry saying autonomous publishing was switched on when
 * nothing can publish. Publishing itself is refused outright: the publisher
 * arrives in S2c, and the plan requires its capability to be available before
 * this switch may be enabled, so until it exists the honest answer is no.
 *
 * Everything commits with the caller's transaction, including the generation
 * bump, so a reader can never see the new value under the old generation.
 */
export async function writeMarketingAutomationSwitch(
  // The branded transaction, not a raw client. This writes the switch and
  // moves the configuration generation, and the caller writes a human audit
  // row beside them; on a plain client each of those is its own autocommit and
  // a failing generation CAS leaves the switch changed.
  client: MarketingTransaction,
  input: {
    name: MarketingConsoleSwitch;
    enabled: boolean;
    expectedConfigGeneration: number;
  },
): Promise<{ configGeneration: number }> {
  const name = input.name;
  const enabled = Boolean(input.enabled);
  const expectedConfigGeneration = Number(input.expectedConfigGeneration);

  const rows = await client.appSetting.findMany({
    where: {
      key: {
        in: [
          MARKETING_DRAFTS_KEY,
          MARKETING_PUBLISH_KEY,
          MARKETING_AUTO_PUBLISH_KEY,
          MARKETING_CONFIG_GENERATION_KEY,
        ],
      },
    },
    select: { key: true, value: true },
  });
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const on = (key: string) => marketingAutomationEnabledFromValue(stored.get(key));

  const previousGeneration = readConfigGeneration(
    stored.get(MARKETING_CONFIG_GENERATION_KEY),
  );
  if (previousGeneration !== expectedConfigGeneration) {
    throw new MarketingSwitchRefusedError(
      "switch_conflict",
      "The marketing switches changed since the screen read them",
    );
  }

  const key = switchKey(name);
  if (on(key) === enabled) {
    throw new MarketingSwitchRefusedError(
      "switch_change_is_noop",
      "That switch is already in the state this change would set",
    );
  }

  if (enabled && name === "publish") {
    throw new MarketingSwitchRefusedError(
      "publisher_capability_unavailable",
      "Publishing cannot be switched on until the publisher exists",
    );
  }
  if (
    enabled &&
    name === "autonomous" &&
    !(on(MARKETING_DRAFTS_KEY) && on(MARKETING_PUBLISH_KEY))
  ) {
    throw new MarketingSwitchRefusedError(
      "autonomous_needs_drafts_and_publish",
      "Autonomous publishing needs drafts and publishing switched on first",
    );
  }

  const value = enabled ? "true" : "false";
  await client.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });

  const configGeneration = previousGeneration + 1;
  const generationValue = JSON.stringify({ generation: configGeneration });
  // Conditional on the document this transaction read, so two writers that
  // both read generation n cannot both store n+1. The API path is already
  // serialised by the audit chain's advisory lock, but a store contract that
  // rests on a lock another module happens to take first is not a contract.
  if (previousGeneration === 0) {
    // No row yet, so the unique key is the condition: a second writer racing
    // to create it fails on the constraint instead of overwriting.
    await client.appSetting.create({
      data: { key: MARKETING_CONFIG_GENERATION_KEY, value: generationValue },
    });
  } else {
    const moved = await client.appSetting.updateMany({
      where: {
        key: MARKETING_CONFIG_GENERATION_KEY,
        value: JSON.stringify({ generation: previousGeneration }),
      },
      data: { value: generationValue },
    });
    if (moved.count !== 1) {
      throw new MarketingSwitchRefusedError(
        "switch_conflict",
        "The marketing switches changed since the screen read them",
      );
    }
  }

  return { configGeneration };
}

/**
 * The generation a console shows, or null when the stored document is not one.
 *
 * A screen that cannot read it must say so and refuse to save rather than
 * guess a number: the whole point of the token is that a save carries the
 * state it was made against.
 */
export const marketingConfigGenerationFromValue = (
  value: string | null,
): number | null => {
  try {
    return readConfigGeneration(value ?? undefined);
  } catch {
    return null;
  }
};

/** What a console has to send back with a switch change. */
export async function readMarketingConfigGeneration(
  client: Pick<PrismaClient, "appSetting">,
): Promise<number> {
  const row = await client.appSetting.findUnique({
    where: { key: MARKETING_CONFIG_GENERATION_KEY },
    select: { value: true },
  });
  return readConfigGeneration(row?.value);
}
