import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// UX-F006 / WO-004 -- server-side safety contract for POST /api/chat.
//
// The E2E suite mocks /api/chat wholesale, so it can only show that the
// client stops sending. It cannot show what the server does when someone
// calls the endpoint directly: an attacker, a stale tab, or simply a bug that
// skips the client preflight. This harness drives the real route handler with
// spies on the two seams that cost money:
//
//   * the provider adapter  -- lib/activeAiModel.getActiveAiModel, plus
//     streamText from the `ai` SDK, and
//   * the credit reservation -- lib/chatSecurity.acquireChatAccess.
//
// A rejected request must reach neither. "Rejected" is asserted by status
// code, but the point of these tests is the two zero-counts.
//
// Module mocking is process-global, which is why this runs under its own
// runner (scripts/run-server-contract-tests.mjs) instead of alongside the
// unit suite.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

// The route reads the registry through getRuntimeModels, which returns the
// static bootstrap catalog when the database is disabled -- so these guards
// are exercised without a database.
process.env.E2E_DISABLE_DATABASE = "true";
// Unroutable port: any accidental database access fails fast instead of
// stalling on a connect timeout.
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type Spies = {
  adapterCalls: string[];
  streamTextCalls: number;
  creditReservations: number;
  surchargeArgs: Array<{ mode: unknown; capability: unknown }>;
};

/**
 * Installs spies on the paid seams and returns the freshly imported route.
 * Every mock keeps the module's real exports and replaces only what is being
 * observed, so the guard logic under test stays real.
 */
// The mocks are installed exactly once and write to whichever Spies object
// this points at. They cannot be re-registered per test: mock.module replaces
// an ESM registry entry, and re-registering does not rebind the module
// instance the route already holds. A per-test registration therefore left
// the route calling the FIRST test's closures, so every later test asserted
// zero-counts on a Spies object nothing ever wrote to -- green, and hollow.
let activeSpies: Spies = {
  adapterCalls: [],
  streamTextCalls: 0,
  creditReservations: 0,
  surchargeArgs: [],
};
let mocksInstalled = false;
let sessionOverride: unknown = null;

async function loadRouteWithSpies(options: {
  session?: unknown;
} = {}): Promise<{ POST: (req: Request) => Promise<Response>; spies: Spies }> {
  const spies: Spies = {
    adapterCalls: [],
    streamTextCalls: 0,
    creditReservations: 0,
    surchargeArgs: [],
  };
  activeSpies = spies;
  sessionOverride = options.session ?? null;

  if (mocksInstalled) {
    const cached = (await import(
      `${mod("app/api/chat/route.ts")}?spy=cached`
    )) as { POST: (req: Request) => Promise<Response> };
    return { POST: cached.POST, spies };
  }
  mocksInstalled = true;

  // Originals come from the CommonJS cache, which is separate from the ESM
  // registry mock.module operates on. Loading them with a dynamic import
  // instead -- even under a `?original` query, which tsx normalises away --
  // caches the real module under its canonical URL and mock.module then
  // never intercepts the route's import of it. That bites transitively too:
  // importing lib/chatSecurity.ts pulls in lib/webSearchCredits.ts, which is
  // why the surcharge spy silently recorded nothing while the credit spy
  // beside it worked.
  const original = (path: string) =>
    require(resolve(ROOT, path)) as Record<string, unknown>;

  // --- provider adapter seam -------------------------------------------------
  // Recorded, then delegated to the real builder: the route reads fields off
  // the object it returns, so a stub derails the flow long before the seams
  // that actually spend anything. Constructing a client issues no request --
  // streamText is what would, and it is blocked below.
  const realActiveAiModel = original("lib/activeAiModel.ts") as unknown as {
    getActiveAiModel: (model: unknown) => unknown;
  };
  mock.module(mod("lib/activeAiModel.ts"), {
    namedExports: {
      getActiveAiModel: (model: { id?: string }) => {
        activeSpies.adapterCalls.push(model?.id ?? "unknown");
        return realActiveAiModel.getActiveAiModel(model);
      },
    },
  });

  // The route's only runtime import from `ai` is streamText (FilePart and
  // ModelMessage are types, erased at compile time), so this needs no
  // passthrough. Reaching it means a provider request was about to be issued.
  mock.module("ai", {
    namedExports: {
      streamText: (...args: unknown[]) => {
        activeSpies.streamTextCalls += 1;
        throw new Error(
          `streamText must not be reached for a rejected chat request (${args.length} args)`
        );
      },
    },
  });

  // --- credit seam -----------------------------------------------------------
  const realChatSecurity = original("lib/chatSecurity.ts");
  mock.module(mod("lib/chatSecurity.ts"), {
    namedExports: {
      ...realChatSecurity,
      createChatBudget: (
        kind: unknown,
        model: unknown,
        estimatedInputTokens: unknown,
        options?: { webSearchSurchargeCredits?: number }
      ) => {
        activeSpies.surchargeArgs.push({
          mode: options?.webSearchSurchargeCredits,
          capability: (model as { id?: string })?.id,
        });
        return (
          realChatSecurity.createChatBudget as (
            a: unknown,
            b: unknown,
            c: unknown,
            d: unknown
          ) => unknown
        )(kind, model, estimatedInputTokens, options);
      },
      acquireChatAccess: (...args: unknown[]) => {
        activeSpies.creditReservations += 1;
        throw new Error(
          `acquireChatAccess must not reserve credits for a rejected chat request (${args.length} args)`
        );
      },
    },
  });

  // --- web-search surcharge input -------------------------------------------
  // Observed through createChatBudget rather than by mocking
  // lib/webSearchCredits directly. createChatBudget lives in lib/chatSecurity,
  // already mocked above, and it receives the surcharge the route derived from
  // the request's webSearchMode -- so this sees the value that actually feeds
  // the credit reservation.
  // --- guest verification ------------------------------------------------
  // Turnstile is not what these tests are about, and its real implementation
  // needs a Next request scope (cookies()) that a plain node process does not
  // provide. Neutralised so the guest path can reach the budget/credit seams.
  // Production behaviour is untouched; guest protection has its own coverage.
  const realTurnstile = original("lib/turnstile.ts");
  mock.module(mod("lib/turnstile.ts"), {
    namedExports: {
      ...realTurnstile,
      ensureGuestVerified: async () => undefined,
    },
  });

  // --- session ---------------------------------------------------------------
  // getServerSession is the route's only runtime import from next-auth/next.
  mock.module("next-auth/next", {
    namedExports: {
      getServerSession: async () => sessionOverride,
    },
  });

  const route = (await import(
    `${mod("app/api/chat/route.ts")}?spy=cached`
  )) as { POST: (req: Request) => Promise<Response> };

  return { POST: route.POST, spies };
}

const chatRequest = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const assertNothingSpent = (spies: Spies, context: string) => {
  assert.equal(
    spies.streamTextCalls,
    0,
    `${context}: streamText was called`
  );
  assert.equal(
    spies.creditReservations,
    0,
    `${context}: credits were reserved`
  );
  assert.deepEqual(
    spies.adapterCalls,
    [],
    `${context}: a provider client was constructed for a request that never should have got that far`
  );
};

test("a retired model is rejected without touching the provider or credits", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(
    chatRequest({
      messages: [{ role: "user", content: "hello" }],
      // Retired in lib/models.ts: groq stopped serving it.
      modelId: "llama-4-scout",
    })
  );

  assert.equal(response.status, 410);
  const payload = (await response.json()) as { code?: string };
  assert.equal(payload.code, "MODEL_RETIRED");
  assertNothingSpent(spies, "retired model");
});

test("an unknown model is rejected without touching the provider or credits", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(
    chatRequest({
      messages: [{ role: "user", content: "hello" }],
      modelId: "definitely-not-a-real-model",
    })
  );

  assert.equal(response.status, 400);
  const payload = (await response.json()) as { code?: string };
  assert.equal(payload.code, "MODEL_NOT_AVAILABLE");
  assertNothingSpent(spies, "unknown model");
});

test("a malformed payload is rejected without touching the provider or credits", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(chatRequest({ messages: "not-an-array" }));

  assert.ok(
    response.status >= 400 && response.status < 500,
    `expected a 4xx rejection, got ${response.status}`
  );
  assertNothingSpent(spies, "malformed payload");
});

test("an empty message list is rejected without touching the provider or credits", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(
    chatRequest({ messages: [], modelId: "gpt-5-4-mini" })
  );

  assert.ok(
    response.status >= 400 && response.status < 500,
    `expected a 4xx rejection, got ${response.status}`
  );
  assertNothingSpent(spies, "empty messages");
});

// NOT COVERED HERE: the end-to-end webSearchMode -> credit-surcharge
// plumbing through this route.
//
// Reaching createChatBudget requires getting past ensureGuestVerified (which
// calls next/headers) or past the authenticated path (which needs a real
// database), and neither a Next request scope nor a database exists in this
// process. Faking either would make the assertion pass without exercising the
// plumbing it claims to protect, so it is deliberately absent rather than
// green-but-hollow.
//
// Partial cover that does exist today:
//   * tests/chatSecurityWebSearchMode.test.mjs -- validateChatPayload
//     preserves the requested mode.
//   * tests/webSearchCredits*.test.* -- the mode -> surcharge table.
// The join between them, inside the route, is still unverified. Closing it
// needs either a Next request-scope harness or a throwaway database.

// UX-F006. The surcharge that feeds the credit reservation must be derived
// from the webSearchMode the request actually carried. If a refactor drops
// webSearchMode anywhere between validateChatPayload and createChatBudget,
// an "always" request silently reserves the "off" surcharge, and nothing in
// the repository noticed -- the E2E suite mocks /api/chat, so it never sees
// what the server budgeted.
//
// claude-haiku-4-5 is used because it has verified provider-native search
// (lib/webSearchCapability.ts) AND is available to guests. On a model without
// native search the surcharge is 0 for every mode, so the assertion would
// hold no matter how badly the mode was plumbed.
test("the requested webSearchMode reaches the credit surcharge", async () => {
  const NATIVE_SEARCH_GUEST_MODEL = "claude-haiku-4-5";
  const expectedSurcharge = { off: 0, auto: 0, always: 8 } as const;

  for (const mode of ["off", "auto", "always"] as const) {
    const { POST, spies } = await loadRouteWithSpies();

    await POST(
      chatRequest({
        messages: [{ role: "user", content: "hello" }],
        modelId: NATIVE_SEARCH_GUEST_MODEL,
        webSearchMode: mode,
      })
    );

    assert.equal(
      spies.surchargeArgs.length,
      1,
      `webSearchMode=${mode}: expected exactly one budget, saw ${spies.surchargeArgs.length} -- the contract is unverified`
    );
    assert.equal(
      spies.surchargeArgs[0]!.mode,
      expectedSurcharge[mode],
      `webSearchMode=${mode}: the credit budget reserved ${JSON.stringify(spies.surchargeArgs[0]!.mode)} search credits instead of ${expectedSurcharge[mode]}`
    );
  }
});

// A request that is allowed through still must not reach a provider without
// a credit reservation happening first. This pins the ordering the safety
// tests above depend on: acquireChatAccess precedes streamText.
test("an allowed request reserves credits before it can reach the provider", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  await POST(
    chatRequest({
      messages: [{ role: "user", content: "hello" }],
      modelId: "claude-haiku-4-5",
      webSearchMode: "off",
    })
  );

  assert.equal(spies.creditReservations, 1, "credits were never reserved");
  assert.equal(
    spies.streamTextCalls,
    0,
    "streamText ran even though the credit reservation failed"
  );
});

// ---------------------------------------------------------------------------
// Guest attachments.
//
// A guest may now send one ephemeral file per message. The object it refers to
// was validated and parsed at upload time, so what the chat route has to
// guarantee is narrower but sharper: the key belongs to *this* guest, there is
// only one of them, and the type is one a guest is allowed to send. Each of
// these is asserted by what it costs: a rejected request must reach neither a
// provider nor a credit reservation.
// ---------------------------------------------------------------------------

/**
 * The narrower guarantee for requests rejected *inside* the message loop.
 *
 * `getActiveAiModel` runs before the loop, so a provider *client* has already
 * been constructed by then -- which issues no request and costs nothing. What
 * must not happen is the two things that do cost: a provider call and a credit
 * reservation.
 */
const assertNothingCharged = (spies: Spies, context: string) => {
  assert.equal(spies.streamTextCalls, 0, `${context}: streamText was called`);
  assert.equal(
    spies.creditReservations,
    0,
    `${context}: credits were reserved`
  );
};

const guestAttachmentKey = (subjectKeySeed: string) => {
  const { guestAttachmentPrefix, createGuestAttachmentKey, createGuestAttachmentObjectId } =
    require(resolve(ROOT, "lib/guestAttachments.ts")) as {
      guestAttachmentPrefix: (subjectKey: string, secret: string) => string;
      createGuestAttachmentKey: (
        subjectKey: string,
        secret: string,
        objectId: string
      ) => string;
      createGuestAttachmentObjectId: (uuid: string) => string;
    };
  void guestAttachmentPrefix;
  return createGuestAttachmentKey(
    subjectKeySeed,
    process.env.NEXTAUTH_SECRET as string,
    createGuestAttachmentObjectId("11111111-1111-4111-8111-111111111111")
  );
};

test("a guest cannot send another guest's file", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  // A key that is validly *shaped* but belongs to a different guest identity.
  // The route derives the caller's own prefix rather than trusting the key, so
  // there is nothing here to guess right.
  const response = await POST(
    chatRequest({
      messages: [
        {
          role: "user",
          content: "Read this.",
          attachments: [
            {
              name: "someone-elses.txt",
              mediaType: "text/plain",
              kind: "text",
              objectKey: guestAttachmentKey("guest:someone-else"),
            },
          ],
        },
      ],
      modelId: "claude-haiku-4-5",
    })
  );

  assert.equal(response.ok, false);
  assertNothingCharged(spies, "another guest's attachment");
});

test("a guest cannot send more than one file in a message", async () => {
  const { POST, spies } = await loadRouteWithSpies();
  const attachment = (index: number) => ({
    name: `file-${index}.txt`,
    mediaType: "text/plain",
    kind: "text",
    objectKey: `${guestAttachmentKey("guest:whoever")}-${index}`,
  });

  const response = await POST(
    chatRequest({
      messages: [
        {
          role: "user",
          content: "Read both.",
          attachments: [attachment(1), attachment(2)],
        },
      ],
      modelId: "claude-haiku-4-5",
    })
  );

  assert.equal(response.status, 413);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, "GUEST_TOO_MANY_ATTACHMENTS");
  assertNothingSpent(spies, "a second guest attachment");
});

test("a guest cannot send an attachment type guests are not allowed", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(
    chatRequest({
      messages: [
        {
          role: "user",
          content: "Read this.",
          attachments: [
            {
              name: "clip.mp4",
              mediaType: "video/mp4",
              kind: "file",
              objectKey: guestAttachmentKey("guest:whoever"),
            },
          ],
        },
      ],
      modelId: "claude-haiku-4-5",
    })
  );

  assert.equal(response.ok, false);
  assertNothingCharged(spies, "an unsupported guest attachment type");
});

test("a guest cannot smuggle inline attachment data past the upload path", async () => {
  // Bypassing the upload endpoint would mean bypassing every validation and
  // parse it performs, so inline data is refused for everyone -- guests very
  // much included.
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(
    chatRequest({
      messages: [
        {
          role: "user",
          content: "Read this.",
          attachments: [
            {
              name: "notes.txt",
              mediaType: "text/plain",
              kind: "text",
              data: Buffer.from("inline").toString("base64"),
            },
          ],
        },
      ],
      modelId: "claude-haiku-4-5",
    })
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, "INLINE_ATTACHMENT_FORBIDDEN");
  assertNothingSpent(spies, "an inline guest attachment");
});

test("a guest cannot read from the signed-in attachment area", async () => {
  const { POST, spies } = await loadRouteWithSpies();

  const response = await POST(
    chatRequest({
      messages: [
        {
          role: "user",
          content: "Read this.",
          attachments: [
            {
              name: "someone.txt",
              mediaType: "text/plain",
              kind: "text",
              objectKey: "attachments/abcdef0123456789abcd/2026-07-30/uuid-someone.txt",
            },
          ],
        },
      ],
      modelId: "claude-haiku-4-5",
    })
  );

  assert.equal(response.ok, false);
  assertNothingCharged(spies, "a signed-in object key sent by a guest");
});
