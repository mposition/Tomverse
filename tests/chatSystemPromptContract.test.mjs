import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(resolve(ROOT, relative), "utf8");

/**
 * Two traces, one rule.
 *
 * `ai@7` refuses a system message inside `messages` and asks for it through
 * `instructions`. The rejection does not reach the caller as anything about a
 * prompt: it arrives wrapped as `AI_NoOutputGeneratedError` and this
 * application reports it as an empty answer, so both times it shipped it read
 * as a provider fault.
 *
 *   * 0dde1576-6bb8-4a19-bd8f-55f8e73d2b27, Release C staging. The injected
 *     context block -- an assistant profile's instructions, or memory's --
 *     went to the head of `messages`. Neither flag had ever been on, so no
 *     turn produced the block until an assistant was picked in staging.
 *   * cbd6b2b5-9cae-4aa8-976e-b220f25b7232, generated-artifacts staging. Every
 *     turn now carries an artifact system block. The first fix had been
 *     written as a conditional on `contextSystemPrompt`, which was the only
 *     source at the time, so a second source failed in both directions at
 *     once: with no context prompt the block reached `messages` and every turn
 *     died, and with one it was filtered away and never reached the model.
 *
 * The second one is why the shape assertions here are narrower than they were.
 * A source-shape test can only pin the shape it was written for, and the shape
 * it pinned was the bug's next incarnation. What is pinned now is the
 * invariant rather than the expression: the split is unconditional, and every
 * dispatch sends its two halves.
 *
 * The behaviour itself is tested where it can fail rather than in source text:
 *
 *   * `tests/chatProviderPrompt.test.mjs` hands the split's output to the real
 *     `streamText`, and asserts the unsplit array is refused -- so the library
 *     fact is checked against the library, not restated.
 *   * `tests/integration/chat-route-search-settlement.db.test.ts` captures
 *     what the route actually handed the SDK, because what broke was neither
 *     the splitter nor the SDK but the route forgetting to call it.
 */

const ROUTE = "app/api/chat/route.ts";

test("the chat route hands the injected context block to the SDK as instructions", () => {
  const source = read(ROUTE);

  // Unconditional, and through the shared splitter. A conditional here is
  // what shipped twice: it is only correct while the branch it names is the
  // only source of system messages, and nothing makes that stay true.
  assert.match(
    source,
    /const \{ messages: sdkMessages, instructions: sdkInstructions \} =\s*splitProviderInstructions\(formattedMessages\);/,
    `${ROUTE} must split system blocks out of the SDK's messages unconditionally`
  );
  assert.doesNotMatch(
    source,
    /const sdkMessages[^\n]*=\s*contextSystemPrompt\s*\?/,
    `${ROUTE} must not decide the split from one source of system messages`
  );

  const streamTextCalls = source.match(/await streamText\(\{[\s\S]*?\n\s*\}\);/g) ?? [];
  assert.ok(
    streamTextCalls.length >= 2,
    "expected the primary dispatch and the fallback dispatch"
  );
  for (const call of streamTextCalls) {
    assert.match(
      call,
      /messages: sdkMessages,/,
      "every streamText call sends the filtered array"
    );
    assert.match(
      call,
      /\.\.\.\(sdkInstructions \? \{ instructions: sdkInstructions \} : \{\}\),/,
      "every streamText call forwards the context block as instructions"
    );
    assert.doesNotMatch(
      call,
      /messages: formattedMessages/,
      "formattedMessages still carries the system turn and must not reach the SDK"
    );
  }
});

test("formattedMessages keeps the system turn for the paths that accept one", () => {
  const source = read(ROUTE);
  // Deep research posts this array to Perplexity's own API, which does take a
  // system turn (lib/perplexityDeepResearch.ts keeps role "system"), and the
  // request manifest describes what was sent. Filtering at the source would
  // silently drop the profile's instructions from both.
  assert.match(
    source,
    /const formattedMessages: ModelMessage\[\] = contextSystemPrompt\s*\?\s*\[\{ role: "system", content: contextSystemPrompt \}\]\s*:\s*\[\];/,
    `${ROUTE} must keep building the system turn into formattedMessages`
  );
  assert.match(
    source,
    /messages: formattedMessages,\n\s*maxOutputTokens: depthParams\.maxOutputTokens,/,
    "the deep research submission still receives the array with its system turn"
  );
  assert.match(
    source,
    /const manifestMessages = formattedMessages\.map\(/,
    "the request manifest still describes the array with its system turn"
  );

  assert.match(
    read("lib/perplexityDeepResearch.ts"),
    /message\.role === "system" \|\|/,
    "lib/perplexityDeepResearch.ts must keep accepting a system turn"
  );
});

test("the SDK still refuses system messages inside the messages array", () => {
  // The reason the split above exists. If a future `ai` release drops
  // `allowSystemInMessages`, or flips its default, this fails and the split
  // gets reconsidered instead of outliving the rule it was written for.
  const declarations = read("node_modules/ai/dist/index.d.ts");
  assert.match(
    declarations,
    /allowSystemInMessages\?: boolean;/,
    "ai no longer declares allowSystemInMessages -- re-read its prompt contract"
  );
  assert.match(
    declarations,
    /When disabled, system messages must be provided through the `instructions`\s*\*\s*option\.\s*\*\s*\*\s*@default false/,
    "ai's allowSystemInMessages default changed -- re-read its prompt contract"
  );
});
