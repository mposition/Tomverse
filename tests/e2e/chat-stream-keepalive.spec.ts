import { expect, test } from "@playwright/test";
import { prepareGuestPage, sendChatMessage } from "./support/app-fixtures";
import { installChatModelStub } from "./support/chat-state-fixtures";

/**
 * The keepalive the server writes while a provider is still thinking, seen
 * from the browser.
 *
 * `lib/chatStreamKeepalive.ts` explains why it exists: this deployment sits
 * behind an edge proxy whose read timeout is roughly 125 seconds
 * (docs/policy/image-generation.md section 7), and a `claude-fable-5` turn can
 * take longer than that to produce its first token. So the route writes an
 * out-of-band chunk into the same stream the answer is written into.
 *
 * `tests/chatStreamKeepalive.test.mjs` and `tests/chatStreamConsumer.test.mjs`
 * pin the splitter and the read loop. What only a browser can show is the
 * join: that the marker never survives into a painted frame, and never into
 * the transcript the guest's own storage keeps.
 *
 * The stream is delivered one character per chunk on purpose. That is the
 * worst case a `ReadableStream` can actually produce -- the marker's name torn
 * in half, its JSON payload torn in half, the answer arriving separately --
 * and it is the case a splitter that trusted chunk boundaries would fail.
 */

/**
 * The guest brand trio (lib/appDefaults.ts). All three are stubbed with the
 * same script rather than only the lead, so this spec does not quietly depend
 * on how many panels a guest conversation opens with.
 */
const GUEST_MODEL_IDS = ["gpt-5-6-luna", "claude-haiku-4-5", "gemini-2-5-flash"];
const NUL = String.fromCharCode(0);
const KEEPALIVE_MARKER = `${NUL}TOMVERSE_STREAM_KEEPALIVE`;
const TRAILER_MARKER = `${NUL}TOMVERSE_SEARCH_METADATA`;

const ANSWER = "The deck covers three things.";

const WIRE =
  `${KEEPALIVE_MARKER}{"state":"awaiting_first_token","elapsedMs":20000}` +
  `${KEEPALIVE_MARKER}{"state":"awaiting_first_token","elapsedMs":40000}` +
  ANSWER +
  `${TRAILER_MARKER}${JSON.stringify({
    searchMetadata: null,
    completion: { status: "normal" },
  })}`;

test("a keepalive torn across chunks never reaches the screen or the transcript", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "en");
  await installChatModelStub(
    page,
    Object.fromEntries(
      GUEST_MODEL_IDS.map((modelId) => [
        modelId,
        {
          kind: "success" as const,
          // One character per chunk, which is what makes this a regression
          // test rather than a re-run of the unit suite.
          chunks: [...WIRE],
          intervalMs: 1,
        },
      ])
    )
  );

  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "Summarise the attached deck.");

  const answer = page.getByTestId("chat-message-list").first();
  await expect(answer).toContainText(ANSWER);

  // Nothing about either marker may be readable, in this frame or in the
  // accessible name a screen reader would announce.
  const rendered = (await answer.innerText()) ?? "";
  expect(rendered).not.toContain("TOMVERSE_STREAM_KEEPALIVE");
  expect(rendered).not.toContain("TOMVERSE_SEARCH_METADATA");
  expect(rendered).not.toContain("awaiting_first_token");
  expect(rendered).not.toContain("elapsedMs");
  expect(rendered).not.toContain(NUL);

  // The stored guest transcript is written from the same string the panel
  // renders, so a marker that survived into one would survive into both --
  // and the stored copy is the one that outlives the tab.
  const stored = await page.evaluate(() => {
    const entries: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith("guest_messages_")) {
        entries.push(localStorage.getItem(key) ?? "");
      }
    }
    return entries.join("\n");
  });

  expect(stored).toContain(ANSWER);
  expect(stored).not.toContain("TOMVERSE_STREAM_KEEPALIVE");
  expect(stored).not.toContain("awaiting_first_token");
  expect(stored).not.toContain("\\u0000");

  // A turn that carried keepalives is still an ordinary completed turn: the
  // trailer said `normal`, so nothing here may read as stopped, incomplete or
  // failed.
  await expect(page.getByText("Response generation was stopped.")).toHaveCount(0);
});
