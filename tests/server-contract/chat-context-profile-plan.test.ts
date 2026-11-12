import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyContextBundle } from "../../lib/chatContextBundleCore";

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
const secret = "local-context-contract-secret";
process.env.NEXTAUTH_SECRET = secret;
process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://local:local@127.0.0.1:1/local";

let boundProfile: string | null = null;
const planReads = mock.fn(async () => ({ tier: "Max" }));
const buildContext = mock.fn(async (input: { profileVersionId: string | null; plan: string | null }) => ({
    memory: { decision: { allowed: true }, prompt: { usedCount: 1 } },
    memoryTokens: 12,
    profileTokens: input.profileVersionId && input.plan === "Max" ? 8 : 0,
    fingerprintInput: {
        memoryMode: "on", memoryVersion: "m1", styleVersion: "s1", profileVersion: input.profileVersionId,
        retrievalHash: "r1", retrievalVersion: 1, promptVersion: "mem-context-v1", knowledgeHash: "none",
    },
}));

mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "owner" } }) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
    ...require(resolve(root, "lib/apiSecurity.ts")), consumeApiRateLimit: async () => {},
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { conversation: {
    findUnique: async () => ({ userId: "owner", kind: "chat", password: null,
        memoryMode: "inherit", assistantProfileVersionId: boundProfile }),
} } } });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: planReads } });
mock.module(mod("lib/chatTurnContext.ts"), { namedExports: { buildChatTurnContext: buildContext } });

beforeEach(() => {
    planReads.mock.resetCalls();
    buildContext.mock.resetCalls();
});

for (const profile of [null, "bound-profile"] as const) {
    test(profile ? "a bound profile still receives the account tier before pricing" :
        "memory is priced without reading a plan when the conversation has no profile", async () => {
        boundProfile = profile;
        const { POST } = await import(mod("app/api/chat/context/route.ts"));
        const response = await POST(new Request("http://localhost/api/chat/context", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversationId: "chat", modelIds: ["model"], prompt: "Brisbane weather" }),
        }));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.memoryUsedCount, 1);
        assert.equal(planReads.mock.callCount(), profile ? 1 : 0);
        assert.equal(buildContext.mock.callCount(), 1);
        assert.equal(buildContext.mock.calls[0].arguments[0].plan, profile ? "Max" : null);
        const verified = verifyContextBundle(body.contextBundle, {
            secret, subjectKey: "owner", conversationId: "chat", modelId: "model",
        });
        assert.ok(verified.ok);
        assert.equal(verified.payload.memoryTokens, 12);
        assert.equal(verified.payload.profileTokens, profile ? 8 : 0);
        assert.equal(verified.payload.profileVersion, profile);
    });
}
