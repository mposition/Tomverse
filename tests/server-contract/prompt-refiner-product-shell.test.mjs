import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import React from "react";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
globalThis.React = React;
const originalEnv = { ...process.env };
let session, sessionError, sessionReads, viewReads, admissionReads, release, releaseError;
const ChatPageClient = () => null;
mock.module("next/headers", { namedExports: {
  cookies: async () => ({ get: () => undefined }),
} });
mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => {
    sessionReads++;
    if (sessionError) throw sessionError;
    return session;
  },
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/appSettings.ts"), { namedExports: {
  getPublicAppSettings: async () => ({ guestDefaultModelId: "guest-model" }),
  isChatStarterEnabled: async () => false,
  isExternalContinuationEnabledCached: async () => false,
  isExternalImportEnabled: async () => false,
  isImageGenerationEnabled: async () => false,
  isPromptRefinerEnabled: async () => false,
  isVoiceInputEnabled: async () => false,
} });
mock.module(mod("lib/webSearchBackendRuntime.ts"), { namedExports: {
  resolveWebSearchBackendReadiness: () => ({ brave: false }),
} });
mock.module(mod("lib/chatStarterCapabilityResolution.ts"), { namedExports: {
  resolveChatStarterCapabilities: () => [],
} });
mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: {
  promptRefinerChatExecutionRelease: async () => {
    viewReads++;
    if (releaseError) throw releaseError;
    return release;
  },
  promptRefinerChatExecutionAdmission: async () => {
    admissionReads++;
    throw new Error("UI must not request execution admission");
  },
} });
mock.module(mod("components/chat/GuestVerificationProvider.tsx"), { namedExports: {
  GuestVerificationProvider: () => null,
} });
mock.module(mod("components/chat/HelpGuideAccess.tsx"), { namedExports: {
  HelpGuideAccessProvider: () => null,
} });
mock.module(mod("components/chat/PromptRefinerFixtureRefreshLoader.tsx"), { namedExports: {
  PromptRefinerFixtureRefreshLoader: () => null,
} });
mock.module(mod("app/(site)/(application)/chat/ChatPageClient.tsx"), { namedExports: { ChatPageClient } });
const { ReviewWorkspaceShell } = await import(mod("components/chat/ReviewWorkspaceShell.tsx"));

test.beforeEach(() => {
  process.env.NEXTAUTH_URL = "https://chat.tomverse.example";
  process.env.E2E_AUTH_BYPASS = "false";
  process.env.E2E_DISABLE_DATABASE = "false";
  session = { user: { id: "owner-a" } };
  sessionError = releaseError = null;
  sessionReads = viewReads = admissionReads = 0;
  release = {
    explicitEnabled: true,
    autoEnabled: false,
    deploymentId: "server-only-deployment",
    approvalId: "server-only-approval",
  };
});
test.after(() => {
  for (const key of ["NEXTAUTH_URL", "E2E_AUTH_BYPASS", "E2E_DISABLE_DATABASE"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  delete globalThis.React;
});
function clientProps(element) {
  if (!React.isValidElement(element)) return null;
  if (element.type === ChatPageClient) return element.props;
  for (const child of React.Children.toArray(element.props.children)) {
    const props = clientProps(child);
    if (props) return props;
  }
  return null;
}
const open = async (mountedSurface = "chat") => clientProps(await ReviewWorkspaceShell({ mountedSurface }));
const closed = { explicitEnabled: false, autoEnabled: false };

test("anonymous Chat render never reads a product release or requests admission", async () => {
  session = null;
  assert.deepEqual((await open()).promptRefinerProductRelease, closed);
  assert.equal(sessionReads, 1);
  assert.equal(viewReads, 0);
  assert.equal(admissionReads, 0);
});
test("session without an owner cannot expose Refiner capabilities", async () => {
  session = { user: {} };
  assert.deepEqual((await open()).promptRefinerProductRelease, closed);
  assert.equal(viewReads, 0);
});
test("signed-in Chat reads only the UI view and exposes two capability booleans", async () => {
  assert.deepEqual((await open()).promptRefinerProductRelease, {
    explicitEnabled: true, autoEnabled: false,
  });
  assert.equal(viewReads, 1);
  assert.equal(admissionReads, 0);
});
test("Review render never checks a session or product release", async () => {
  assert.deepEqual((await open("workspace")).promptRefinerProductRelease, closed);
  assert.equal(sessionReads, 0);
  assert.equal(viewReads, 0);
  assert.equal(admissionReads, 0);
});
test("full loopback fixture mode cannot call product release or admission", async () => {
  process.env.NEXTAUTH_URL = "http://127.0.0.1:3100";
  process.env.E2E_AUTH_BYPASS = "true";
  process.env.E2E_DISABLE_DATABASE = "true";
  assert.deepEqual((await open()).promptRefinerProductRelease, closed);
  assert.equal(sessionReads, 0);
  assert.equal(viewReads, 0);
  assert.equal(admissionReads, 0);
});
test("session read failure keeps capabilities off without consulting the release", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  sessionError = new Error("private session detail");
  assert.deepEqual((await open()).promptRefinerProductRelease, closed);
  assert.equal(viewReads, 0);
  assert.equal(admissionReads, 0);
  assert.deepEqual(errors, [["Failed to load prompt refiner capabilities for chat:", { errorName: "Error" }]]);
});
test("release read failure keeps the signed-in composer closed without an admission retry", async (t) => {
  t.mock.method(console, "error", () => {});
  releaseError = new Error("private release detail");
  assert.deepEqual((await open()).promptRefinerProductRelease, closed);
  assert.equal(viewReads, 1);
  assert.equal(admissionReads, 0);
});
