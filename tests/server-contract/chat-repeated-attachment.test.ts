import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { fitChatRequestTranscript } from "../../lib/chatRequestLimits.ts";
import { chatAccountMaxInputTokens } from "../../lib/chatInputLimits.ts";
import { getModel } from "../../lib/models.ts";
import { toChatRequestMessage } from "../../lib/chatMessageSerialization.ts";
import { requestTranscriptForScope } from "../../lib/chatTranscriptRecovery.ts";
import type { ChatAttachment, Message } from "../../components/chat/types";

/**
 * POST /api/chat when a retry put the same stored file on a second message.
 *
 * Trace 5859a17f-8b27-415a-9a4f-4bd3f7f08a20, 2026-10-08. A retry keeps the
 * failed turn on screen and appends a new user message carrying the same
 * attachment reference. The route refused any reference it saw twice in a
 * request, so the retry was a 400 -- and the copy stayed in the tab's transcript,
 * so every later send from that tab was a 400 too.
 *
 * The transcripts below are built by the client's own request code rather than
 * written by hand, so what is under test is the request the browser really
 * sends.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.R2_ACCOUNT_ID ||= "test-account";
process.env.R2_ACCESS_KEY_ID ||= "test-key";
process.env.R2_SECRET_ACCESS_KEY ||= "test-secret";
process.env.R2_BUCKET_NAME ||= "test-bucket";

type World = {
  /** Rows the resolver knows. Anything else is somebody else's, or nobody's. */
  owned: Set<string>;
  /** Files storage reports gone, by attachment id. */
  missing: Set<string>;
  /** Body returned for an attachment id; a default otherwise. */
  bodies: Map<string, string>;
  /** Every attachment id the route asked the resolver about, per call. */
  resolved: string[][];
  /** Every object the route read. */
  reads: string[];
  /** The budget each turn reached the credit reservation with. */
  budgets: unknown[];
  streamTextCalls: number;
};

const OWNER_EMAIL = "repeat-owner@tomverse.app";
const ACCOUNT_PREFIX = `attachments/${createHash("sha256")
  .update(OWNER_EMAIL.toLowerCase())
  .digest("hex")
  .slice(0, 20)}/`;

const freshWorld = (owned: string[]): World => ({
  owned: new Set(owned),
  missing: new Set(),
  bodies: new Map(),
  resolved: [],
  reads: [],
  budgets: [],
  streamTextCalls: 0,
});

let world = freshWorld([]);
let installed = false;

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==";

class FakeNotFound extends Error {
  readonly $metadata = { httpStatusCode: 404 };
  constructor() {
    super("NotFound");
    this.name = "NotFound";
  }
}

async function loadRoute(): Promise<{ POST: (req: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    const original = (path: string) => require(resolve(ROOT, path)) as Record<string, unknown>;

    const model = () =>
      new Proxy(
        {},
        {
          get(_target, property: string) {
            return async () => {
              if (property === "findMany") return [];
              if (property === "count") return 0;
              if (property === "findUnique" || property === "findFirst") return null;
              return { count: 0 };
            };
          },
        }
      );
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: new Proxy(
          {},
          {
            get(_target, name: string) {
              if (name === "$transaction") {
                return async (arg: unknown) =>
                  typeof arg === "function" ? (arg as (tx: unknown) => unknown)(model()) : [];
              }
              if (name === "$queryRaw" || name === "$executeRaw") return async () => [];
              if (name === "$disconnect") return async () => undefined;
              return model();
            },
          }
        ),
      },
    });
    mock.module("next-auth/next", {
      namedExports: {
        getServerSession: async () => ({ user: { id: "user-repeat-owner", email: OWNER_EMAIL } }),
      },
    });

    const realEntitlements = original("lib/billingEntitlements.ts");
    const realBillingConfig = original("lib/billingConfig.ts") as {
      getBillingPlanByTier: (tier: string) => unknown;
    };
    mock.module(mod("lib/billingEntitlements.ts"), {
      namedExports: {
        ...realEntitlements,
        getUserBillingPlan: async () => realBillingConfig.getBillingPlanByTier("Pro"),
      },
    });
    const realAppSettings = original("lib/appSettings.ts");
    mock.module(mod("lib/appSettings.ts"), {
      namedExports: {
        ...realAppSettings,
        getOperationalFeatureFlags: async () => ({
          attachmentsEnabled: true,
          chatEnabled: true,
          webSearchEnabled: false,
          deepResearchEnabled: false,
          imageGenerationEnabled: false,
        }),
        isImageGenerationEnabledCached: () => false,
      },
    });

    const realStorage = original("lib/messageAttachmentStorage.ts") as {
      MessageAttachmentResolveError: new (code: string, message: string) => Error;
    };
    mock.module(mod("lib/messageAttachmentStorage.ts"), {
      namedExports: {
        ...realStorage,
        resolveMessageAttachmentReferences: async (input: {
          references: Array<{ attachmentId?: string }>;
        }) => {
          world.resolved.push(input.references.map((reference) => reference.attachmentId!));
          return input.references.map((reference) => {
            const id = reference.attachmentId!;
            if (!world.owned.has(id)) {
              throw new realStorage.MessageAttachmentResolveError(
                "ATTACHMENT_NOT_FOUND",
                "An attachment could not be found."
              );
            }
            const image = world.bodies.get(id) === undefined && id.startsWith("png");
            return {
              attachmentId: id,
              uploadId: null,
              name: image ? `${id}.png` : `${id}.txt`,
              mediaType: image ? "image/png" : "text/plain",
              size: 29,
              kind: image ? "file" : "text",
              objectKey: `${ACCOUNT_PREFIX}${id}.txt`,
              unavailableAt: null,
              unavailableReason: null,
            };
          });
        },
        markMessageAttachmentUnavailable: async () => true,
      },
    });

    const realR2 = original("lib/r2.ts");
    mock.module(mod("lib/r2.ts"), {
      namedExports: {
        ...realR2,
        readR2Object: async (key: string) => {
          const id = key.split("/").pop()!.replace(/\.txt$/, "");
          world.reads.push(id);
          if (world.missing.has(id)) {
            const storageErrors = original("lib/storageObjectErrors.ts") as {
              toStorageError: (operation: string, error: unknown) => Error;
            };
            throw storageErrors.toStorageError("head", new FakeNotFound());
          }
          if (id.startsWith("png")) return Buffer.from(ONE_PIXEL_PNG, "base64");
          return Buffer.from(world.bodies.get(id) ?? "This is the attachment body.\n", "utf8");
        },
      },
    });

    mock.module("ai", {
      namedExports: {
        stepCountIs: () => undefined,
        streamText: () => {
          world.streamTextCalls += 1;
          throw new Error("this suite stops at the credit reservation");
        },
      },
    });
    const realChatSecurity = original("lib/chatSecurity.ts");
    mock.module(mod("lib/chatSecurity.ts"), {
      namedExports: {
        ...realChatSecurity,
        // The first thing past the attachment path, and what pricing is sized
        // on. Reaching it is the proof the turn was not refused; what it was
        // handed is the proof of what the turn was priced for.
        acquireChatAccess: async (_access: unknown, budget: unknown) => {
          world.budgets.push(budget);
          throw new Error("this suite stops at the credit reservation");
        },
      },
    });

    const realTurnstile = original("lib/turnstile.ts");
    mock.module(mod("lib/turnstile.ts"), {
      namedExports: { ...realTurnstile, ensureGuestVerified: async () => undefined },
    });
  }
  return (await import(`${mod("app/api/chat/route.ts")}?repeated=cached`)) as {
    POST: (req: Request) => Promise<Response>;
  };
}

const send = async (messages: readonly unknown[]) => {
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, modelId: "gpt-5-4-mini" }),
    })
  );
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string;
    details?: Record<string, unknown>;
  };
  return { status: response.status, payload };
};

const stored = (id: string): ChatAttachment =>
  ({
    id,
    attachmentId: id,
    name: `${id}.txt`,
    mediaType: "text/plain",
    size: 29,
    kind: "text",
  }) as ChatAttachment;

const user = (id: string, content: string, attachments?: ChatAttachment[]): Message => ({
  id,
  role: "user",
  content,
  status: "normal",
  ...(attachments ? { attachments } : {}),
});

/** A failed reply, which Review keeps in the transcript it sends. */
const failed = (id: string): Message => ({ id, role: "assistant", content: "", status: "error" });

/** What ChatApp sends for this turn, through the same three calls. */
const requestFor = (history: Message[], turn: Message, sourceUserMessageId = turn.id) =>
  fitChatRequestTranscript(
    requestTranscriptForScope(history, turn, "model")
      .map((message) => (message === turn ? { ...message, id: sourceUserMessageId } : message))
      .map(toChatRequestMessage)
  );

const shape = (messages: readonly Message[]) => ({
  messageCount: messages.length,
  attachmentCount: messages.flatMap((message) => message.attachments ?? []).length,
});

test("the logged sequence: a retried image turn and the text sends after it all get through", async () => {
  world = freshWorld(["img1"]);
  const file = stored("img1");
  const question = user("original", "What is in this picture?", [file]);
  const history: Message[] = [question, failed("reply0")];

  // In production order: four retries of the question, then two typed follow-ups.
  const turns: Array<{ turn: Message; source: string; logged: [number, number] }> = [
    { turn: user("retry1", question.content, [file]), source: "original", logged: [3, 2] },
    { turn: user("retry2", question.content, [file]), source: "original", logged: [5, 3] },
    { turn: user("retry3", question.content, [file]), source: "original", logged: [7, 4] },
    { turn: user("retry4", question.content, [file]), source: "original", logged: [9, 5] },
    { turn: user("next1", "Are you there?"), source: "next1", logged: [11, 5] },
    { turn: user("next2", "Hello?"), source: "next2", logged: [13, 5] },
  ];

  const outcomes: Array<{ shape: [number, number]; code: string | null }> = [];
  for (const [index, { turn, source }] of turns.entries()) {
    const messages = requestFor(history, turn, source);
    const budgetsBefore = world.budgets.length;
    const { payload } = await send(messages);
    const { messageCount, attachmentCount } = shape(messages);
    outcomes.push({
      shape: [messageCount, attachmentCount],
      code: world.budgets.length > budgetsBefore ? null : (payload.code ?? "UNKNOWN"),
    });
    history.push(turn, failed(`reply${index + 1}`));
  }
  // The shape production logged, each one reaching pricing rather than a refusal.
  assert.deepEqual(outcomes, turns.map(({ logged }) => ({ shape: logged, code: null })));
  // Six requests, one object each. A repeat is not a second read.
  assert.deepEqual(world.reads, Array(turns.length).fill("img1"));
});

test("a retried file is read once and priced exactly as if it had been sent once", async () => {
  const file = stored("once");
  const question = "Summarise this.";
  const retried = requestFor(
    [user("original", question, [file]), failed("reply")],
    user("retry", question, [file]),
    "original"
  );
  const sentOnce = [
    { id: "original", role: "user", content: question },
    { id: "reply", role: "assistant", content: "", status: "error" },
    { id: "original", role: "user", content: question, attachments: [file] },
  ];

  world = freshWorld(["once"]);
  await send(retried);
  assert.deepEqual(world.reads, ["once"]);
  const retriedBudget = world.budgets[0];

  world = freshWorld(["once"]);
  await send(sentOnce);
  assert.deepEqual(retriedBudget, world.budgets[0]);
  assert.ok(retriedBudget, "the retried turn reached pricing");
});

test("a retried image counts one image, as the incident's turn would have", async () => {
  const image = { ...stored("pngone"), name: "pngone.png", mediaType: "image/png", kind: "file" } as ChatAttachment;
  const question = "What is in this picture?";

  world = freshWorld(["pngone"]);
  await send(
    requestFor([user("original", question, [image]), failed("reply")], user("retry", question, [image]), "original")
  );
  assert.deepEqual(world.reads, ["pngone"]);
  const retried = world.budgets[0] as { inputTokens: number };
  assert.ok(retried, "the retried image reached pricing");

  world = freshWorld(["pngone"]);
  await send([
    { id: "original", role: "user", content: question },
    { id: "reply", role: "assistant", content: "", status: "error" },
    { id: "original", role: "user", content: question, attachments: [image] },
  ]);
  assert.deepEqual(retried, world.budgets[0]);

  world = freshWorld(["pngone", "pngtwo"]);
  await send(
    requestFor(
      [user("first", question, [image]), failed("reply")],
      user("second", question, [{ ...image, attachmentId: "pngtwo", id: "pngtwo" }])
    )
  );
  const twoImages = world.budgets[0] as { inputTokens: number };
  assert.ok(
    retried.inputTokens < twoImages.inputTokens,
    `one image (${retried.inputTokens}) must price below two (${twoImages.inputTokens})`
  );
});

test("two different files are still both read and both priced", async () => {
  const question = "Compare these.";
  world = freshWorld(["left", "right"]);
  world.bodies.set("left", "x".repeat(20_000));
  world.bodies.set("right", "x".repeat(20_000));
  await send(
    requestFor(
      [user("first", question, [stored("left")]), failed("reply")],
      user("second", question, [stored("right")])
    )
  );
  // Each file is read once; the current message is read first for the budgets.
  assert.deepEqual([...world.reads].sort(), ["left", "right"]);
  const twoFiles = world.budgets[0] as { inputTokens: number };

  world = freshWorld(["left"]);
  world.bodies.set("left", "x".repeat(20_000));
  await send(
    requestFor(
      [user("first", question, [stored("left")]), failed("reply")],
      user("second", question, [stored("left")])
    )
  );
  const oneFile = world.budgets[0] as { inputTokens: number };
  assert.ok(
    oneFile.inputTokens < twoFiles.inputTokens,
    `one file (${oneFile.inputTokens}) must price below two (${twoFiles.inputTokens})`
  );
});

test("the same file twice on one message is still refused", async () => {
  world = freshWorld(["twin"]);
  const { status, payload } = await send([
    { id: "m1", role: "user", content: "Look.", attachments: [stored("twin"), stored("twin")] },
  ]);
  assert.equal(status, 400);
  assert.equal(payload.code, "DUPLICATE_ATTACHMENT_OBJECT");
  assert.deepEqual(world.budgets, [], "nothing was priced");
  assert.equal(world.streamTextCalls, 0);
});

test("a message naming a file twice is not excused by that file appearing again later", async () => {
  world = freshWorld(["twin"]);
  const { status, payload } = await send([
    { id: "m1", role: "user", content: "Look.", attachments: [stored("twin"), stored("twin")] },
    { id: "m2", role: "assistant", content: "" },
    { id: "m3", role: "user", content: "Look.", attachments: [stored("twin")] },
  ]);
  assert.equal(status, 400);
  assert.equal(payload.code, "DUPLICATE_ATTACHMENT_OBJECT");
  assert.deepEqual(world.budgets, [], "nothing was priced");
});

test("an inline copy on an earlier message is still refused", async () => {
  world = freshWorld(["inline"]);
  const { status, payload } = await send([
    { id: "m1", role: "user", content: "Look.",
      attachments: [{ ...stored("inline"), data: "data:text/plain;base64,aGk=" }] },
    { id: "m2", role: "assistant", content: "" },
    { id: "m3", role: "user", content: "Look.", attachments: [stored("inline")] },
  ]);
  assert.equal(status, 400);
  assert.equal(payload.code, "INLINE_ATTACHMENT_FORBIDDEN");
  assert.deepEqual(world.budgets, [], "nothing was priced");
});

test("a repeated reference to a file the caller does not own is refused, not collapsed away", async () => {
  world = freshWorld([]);
  const file = stored("someone-elses");
  const { status, payload } = await send(
    requestFor([user("original", "Look.", [file]), failed("reply")], user("retry", "Look.", [file]))
  );
  assert.equal(status, 400);
  assert.equal(payload.code, "ATTACHMENT_NOT_FOUND");
  assert.deepEqual(world.resolved, [["someone-elses"]], "the ownership lookup still ran");
  assert.deepEqual(world.reads, [], "nothing was read");
  assert.deepEqual(world.budgets, [], "nothing was priced");
});

test("the extracted-text budget counts a repeat once and two files twice", async () => {
  const large = "y".repeat(200_000);

  world = freshWorld(["big"]);
  world.bodies.set("big", large);
  const repeat = await send(
    requestFor(
      [user("first", "Read.", [stored("big")]), failed("reply")],
      user("second", "Read.", [stored("big")])
    )
  );
  assert.notEqual(repeat.payload.code, "ATTACHMENT_TEXT_TOO_LARGE");
  assert.equal(world.budgets.length, 1, "a repeated file is read once");

  // Two different files add up to more than the old 300,000-character request
  // limit, which refused this turn. Both now fit the input allowance.
  world = freshWorld(["big1", "big2"]);
  world.bodies.set("big1", large);
  world.bodies.set("big2", large);
  const two = await send(
    requestFor(
      [user("first", "Read.", [stored("big1")]), failed("reply")],
      user("second", "Read.", [stored("big2")])
    )
  );
  assert.notEqual(two.payload.code, "ATTACHMENT_TEXT_TOO_LARGE");
  assert.equal(world.budgets.length, 1, "two files past 300k characters are priced, not refused");
});

/**
 * The 2026-11-16 report: a conversation whose earlier files added up past the
 * request limit refused every later message, even one with no file, because
 * each turn reads the earlier files again. Earlier files now share half the
 * input allowance; past it a file is named to the model and left out.
 */
test("earlier files past their share are left out of the turn instead of refusing it", async () => {
  // Sized from the share itself -- half of this model's account input limit,
  // which long context made its context window -- so that two files fit it and
  // three do not. One repetition is about seven tokens.
  const share = Math.floor(
    chatAccountMaxInputTokens({ contextWindowTokens: getModel("gpt-5-4-mini")?.contextWindowTokens }) / 2
  );
  const words = "lorem ipsum dolor sit amet ".repeat(Math.round((share * 0.45) / 7));
  const inputTokens = (budget: unknown) => (budget as { inputTokens: number }).inputTokens;

  world = freshWorld(["past1"]);
  world.bodies.set("past1", words);
  await send(requestFor([user("first", "Read.", [stored("past1")]), failed("reply1")], user("now", "Thanks.")));
  assert.equal(world.budgets.length, 1);
  const onePastFile = inputTokens(world.budgets[0]);

  world = freshWorld(["past1", "past2", "past3"]);
  for (const id of ["past1", "past2", "past3"]) world.bodies.set(id, words);
  const stuck = await send(
    requestFor(
      [
        user("first", "Read.", [stored("past1")]), failed("reply1"),
        user("second", "And this.", [stored("past2")]), failed("reply2"),
        user("third", "And this.", [stored("past3")]), failed("reply3"),
      ],
      user("now", "Thanks.")
    )
  );
  assert.notEqual(stuck.payload.code, "ATTACHMENT_TEXT_TOO_LARGE");
  assert.notEqual(stuck.payload.code, "CHAT_INPUT_TOKEN_LIMIT");
  assert.equal(world.budgets.length, 1, "the turn reaches pricing");
  const threePastFiles = inputTokens(world.budgets[0]);
  // Only the files that fit the earlier-files share are sent; the rest add a
  // one-line note each, not their text.
  assert.ok(threePastFiles < onePastFile * 2.5, `${threePastFiles} vs ${onePastFile}`);
  assert.ok(threePastFiles > onePastFile, "at least one earlier file is still sent");
});

test("the message being sent keeps its own files when earlier files fill their share", async () => {
  const words = "lorem ipsum dolor sit amet ".repeat(8_000);
  world = freshWorld(["past1", "past2", "now1"]);
  for (const id of ["past1", "past2", "now1"]) world.bodies.set(id, words);
  const turn = await send(
    requestFor(
      [
        user("first", "Read.", [stored("past1")]), failed("reply1"),
        user("second", "And this.", [stored("past2")]), failed("reply2"),
      ],
      user("now", "Compare with this one.", [stored("now1")])
    )
  );
  assert.notEqual(turn.payload.code, "ATTACHMENT_TEXT_TOO_LARGE");
  assert.equal(world.budgets.length, 1);
  assert.ok(world.reads.includes("now1"), "the new file was read");
});

test("a retried file that storage lost is named once, on the turn being sent", async () => {
  world = freshWorld(["gone"]);
  world.missing.add("gone");
  const file = stored("gone");
  const { status, payload } = await send(
    requestFor([user("original", "Look.", [file]), failed("reply")], user("retry", "Look.", [file]))
  );
  assert.equal(status, 410);
  assert.equal(payload.code, "ATTACHMENT_UNAVAILABLE");
  assert.deepEqual(payload.details?.unavailableAttachmentIds, ["gone"]);
  assert.equal(payload.details?.attachmentScope, "current_turn");
  assert.deepEqual(world.budgets, [], "nothing was priced");
});

/*
  What the model reads of an earlier answer. The transcript is rewritten before
  anything is measured, so the priced input is the proof of what is sent.
*/
const pricedTokens = async (messages: readonly unknown[]) => {
  world = freshWorld([]);
  await send(messages);
  assert.equal(world.budgets.length, 1, "the turn reaches pricing");
  return (world.budgets[0] as { inputTokens: number }).inputTokens;
};

test("a failed answer is priced as one fixed marker, whatever text it carried", async () => {
  const question = { id: "q1", role: "user", content: "First question?" };
  const next = { id: "q2", role: "user", content: "Second question?" };
  const marker = await pricedTokens([question, { id: "r1", role: "assistant", content: "", status: "error" }, next]);
  const withBody = await pricedTokens([
    question,
    // The localised apology a Review panel keeps as the turn's content, with an
    // error code beside it.
    { id: "r1", role: "assistant", content: "Sorry. ".repeat(4_000), status: "error", errorCode: "UNKNOWN_ERROR" },
    next,
  ]);
  assert.equal(withBody, marker, "the apology never reaches the model");
});

test("a search answer carries the URLs behind its citations into the next turn", async () => {
  const question = { id: "q1", role: "user", content: "What changed?" };
  const answer = { id: "a1", role: "assistant", content: "It changed [1] and again [2].", status: "normal" };
  const next = { id: "q2", role: "user", content: "Which source said the second?" };
  const plain = await pricedTokens([question, answer, next]);
  const cited = await pricedTokens([
    question,
    {
      ...answer,
      searchMetadata: {
        executed: true,
        citations: [
          { url: "https://example.com/one", title: "One" },
          { url: "https://example.com/two", title: "Two", referenceNumber: 2 },
          { url: "javascript:alert(1)" },
        ],
      },
    },
    next,
  ]);
  assert.ok(cited > plain, "the sources are part of what is sent and priced");
  // Bounded: a client cannot grow the transcript with an arbitrary list.
  const flooded = await pricedTokens([
    question,
    {
      ...answer,
      searchMetadata: {
        citations: Array.from({ length: 500 }, (_, index) => ({ url: `https://example.com/${"x".repeat(200)}${index}` })),
      },
    },
    next,
  ]);
  assert.ok(flooded - plain < 1_200, `${flooded - plain} extra tokens for 500 claimed sources`);
});
