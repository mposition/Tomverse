import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let session, availability, reads, availabilityError, guestRelease,
  refinerRelease, mintedAuthorities;

mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/autoAvailability.ts"), {
  namedExports: {
    autoAvailabilityFor: async (...args) => {
      reads.push(args);
      if (availabilityError) throw availabilityError;
      return availability;
    },
  },
});
mock.module(mod("lib/autoRoutingUi.ts"), {
  namedExports: {
    autoSelectionCapability: (value) => ({ offered: value.offered }),
  },
});
mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    identifyChatCaller: () => ({
      kind: "guest",
      userId: null,
      subjectKey: `guest:${"a".repeat(64)}`,
      setCookie: "tomverse_guest=test; Path=/; HttpOnly",
    }),
  },
});
mock.module(mod("lib/guestChatAutoAuthority.ts"), {
  namedExports: {
    mintGuestChatAutoCapability: (input) => {
      mintedAuthorities.push(input);
      return "gca1.signed-authority";
    },
  },
});
mock.module(mod("lib/guestChatSmartAdaptiveRelease.ts"), {
  namedExports: {
    GUEST_CHAT_SMART_ADAPTIVE_AUTHORITY_SECRET_ENV:
      "CHAT_GUEST_SMART_ADAPTIVE_AUTHORITY_SECRET",
    guestChatSmartAdaptiveAuthorityTtlSeconds: () => 60,
  },
});
mock.module(mod("lib/guestChatSmartAdaptiveReleaseStore.ts"), {
  namedExports: {
    readGuestChatSmartAdaptiveRelease: async () => guestRelease,
  },
});
mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), {
  namedExports: {
    promptRefinerChatExecutionRelease: async () => refinerRelease,
  },
});

const { GET } = await import(mod("app/api/products/chat/capabilities/route.ts"));

test.beforeEach(() => {
  session = { user: { id: "owner-a" } };
  availability = {
    offered: true,
    reason: null,
    cohort: { bucket: 7, eligible: true },
  };
  reads = [];
  availabilityError = null;
  guestRelease = {
    binding: {
      runtimeCommitSha: "b".repeat(40),
      runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
      configDigest: "c".repeat(64),
    },
    activationPairDigest: "d".repeat(64),
  };
  refinerRelease = {
    autoEnabled: true,
    runtimeCommitSha: guestRelease.binding.runtimeCommitSha,
    runtimeDeploymentId: guestRelease.binding.runtimeDeploymentId,
  };
  mintedAuthorities = [];
});

test("signed-in blank Chat receives server-owned routing and voice capabilities", async () => {
  const response = await GET(new Request("https://tomverse.test/api/products/chat/capabilities"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { autoSelection: { offered: true }, voiceConversation: { enabled: false, maxSeconds: 300 } });
  assert.deepEqual(reads, [["owner-a"]]);
});

test("guest blank Chat receives a subject and exact-release bound text-only authority", async () => {
  session = null;
  const response = await GET(new Request("https://tomverse.test/chat"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("set-cookie") ?? "", /tomverse_guest=test/);
  assert.deepEqual(await response.json(), {
    autoSelection: { offered: true },
    guestAutoCapability: "gca1.signed-authority",
    guestAuto: { attachmentSupport: "manual_only" },
  });
  assert.equal(mintedAuthorities.length, 1);
  assert.equal(mintedAuthorities[0].binding.subjectKey, `guest:${"a".repeat(64)}`);
  assert.equal(mintedAuthorities[0].binding.sourceCommitSha, "b".repeat(40));
  assert.equal(mintedAuthorities[0].ttlSeconds, 60);
  assert.deepEqual(reads, []);
});

test("guest capability fails closed when Guest and Refiner exact releases do not match", async () => {
  session = null;
  refinerRelease = { ...refinerRelease, runtimeDeploymentId:
    "22222222-2222-4222-8222-222222222222" };
  const response = await GET(new Request("https://tomverse.test/chat"));
  assert.deepEqual(await response.json(), {
    autoSelection: { offered: false },
    guestAuto: { attachmentSupport: "manual_only" },
  });
  assert.equal(mintedAuthorities.length, 0);
  assert.deepEqual(reads, []);
});

test("availability uncertainty fails closed without leaking an internal reason", async () => {
  availabilityError = new Error("database detail that must stay server-side");
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await GET(new Request("https://tomverse.test/api/products/chat/capabilities"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { autoSelection: { offered: false } });
    assert.deepEqual(reads, [["owner-a"]]);
  } finally {
    console.error = originalError;
  }
});
