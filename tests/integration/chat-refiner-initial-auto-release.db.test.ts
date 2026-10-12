import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const rawUrl = process.env.TEST_DATABASE_URL?.trim();

test("initial Auto owner activation and rollout use one real audit chain",
  { skip: !rawUrl }, async () => {
    if (!rawUrl) return;
    const url = new URL(rawUrl);
    assert.match(decodeURIComponent(url.pathname), /(?:^|[_-])test(?:[_-]|$)/);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    process.env.DATABASE_URL = rawUrl;
    Object.assign(process.env, { NODE_ENV: "test" });
    process.env.NEXTAUTH_SECRET ||= "initial-auto-release-test-session-secret";
    process.env.ADMIN_AUDIT_INTEGRITY_SECRET =
      "initial-auto-release-test-audit-integrity-secret";

    const runtime = {
      ...process.env,
      RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
      RAILWAY_DEPLOYMENT_ID: randomUUID(),
      AUTO_ROUTER_ROLLOUT_PERCENT: "5",
      AUTO_ROUTER_ELIGIBLE_PLANS: "Plus,Max",
      AUTO_ROUTER_COHORT_SALT: "initial-auto-release-test-cohort-v1",
      TOMVERSE_AUTO_ROUTER_UI_ENABLED: "true",
      ROUTING_DISPATCH_INSTRUMENTATION: "enforce",
      MANIFEST_HASH_KEYS: `test-key:${"m".repeat(32)}`,
      MANIFEST_HASH_ACTIVE_KEY_ID: "test-key",
      PROMPT_REFINER_KILL_SWITCH: "",
      AUTO_ROUTER_KILL_SWITCH: "",
    };
    Object.assign(process.env, runtime);
    const [{ prisma }, { ensureModelRegistrySeeded }, release, rollout, audit] =
      await Promise.all([
        import("@/lib/prisma"),
        import("@/lib/modelRegistry"),
        import("@/lib/chatRefinerInitialAutoReleaseStore"),
        import("@/lib/chatRefinerInitialAutoRolloutStore"),
        import("@/lib/adminAuditIntegrity"),
      ]);
    await ensureModelRegistrySeeded();
    const session = { user: { id: `initial-auto-owner-${randomUUID()}`,
      email: "initial-auto-owner@example.invalid" } } as never;
    const request = new Request("https://tomverse.test/admin/prompt-refiner-shadow",
      { method: "POST", headers: { origin: "https://tomverse.test" } });
    const input = { session, request,
      runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
      runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
      evidenceRefs: {
        independentReviewJobId: "r-20261011-000000-abcdef",
        validationSealSha256: "b".repeat(64),
        deploymentReadbackSha256: "c".repeat(64),
      } };

    await rollout.setChatRefinerInitialAutoRollout({ ...input, enabled: false }, runtime);
    const activated = await release.activateChatRefinerInitialAutoRelease(input, runtime);
    assert.equal(activated.rolloutChanged, false);
    assert.equal((await prisma.appSetting.findUniqueOrThrow({
      where: { key: "feature.promptRefinerEnabled" },
      select: { value: true },
    })).value, "false");
    const rows = await prisma.adminAuditLog.findMany({ where: {
      targetType: "ChatReleaseFingerprint",
      targetId: (await import("@/lib/chatRefinerInitialAutoRelease"))
        .chatRefinerInitialAutoRuntimeBinding(runtime).releaseFingerprint,
      action: { in: ["chat_auto.initial_release_exception_activated",
        "prompt_refiner.product_initial_auto_release_activated"] },
    }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    assert.deepEqual(rows.map((row) => row.action), [
      "chat_auto.initial_release_exception_activated",
      "prompt_refiner.product_initial_auto_release_activated",
    ]);
    assert.equal(rows[1].previousHash, rows[0].entryHash);
    assert.equal((rows[1].metadata as Record<string, unknown>)
      .routerExceptionAuditLogId, rows[0].id);
    assert.ok(await release.readChatRefinerInitialAutoRouterAuthority(runtime));
    await assert.rejects(
      release.activateChatRefinerInitialAutoRelease(input, runtime),
      /activation_duplicate/,
    );
    assert.equal(await prisma.adminAuditLog.count({ where: {
      targetType: "ChatReleaseFingerprint",
      targetId: (await import("@/lib/chatRefinerInitialAutoRelease"))
        .chatRefinerInitialAutoRuntimeBinding(runtime).releaseFingerprint,
      action: { in: ["chat_auto.initial_release_exception_activated",
        "prompt_refiner.product_initial_auto_release_activated"] },
    } }), 2);

    const enabled = await rollout.setChatRefinerInitialAutoRollout({
      ...input, enabled: true }, runtime);
    assert.equal(enabled.enabled, true);
    assert.equal((await prisma.appSetting.findUniqueOrThrow({
      where: { key: "feature.promptRefinerEnabled" },
      select: { value: true },
    })).value, "true");
    assert.ok(await release.readChatRefinerInitialAutoRouterAuthority({
      ...runtime, RAILWAY_GIT_COMMIT_SHA: "b".repeat(40),
      RAILWAY_DEPLOYMENT_ID: randomUUID(),
    }));
    const otherDeployment = { ...runtime, RAILWAY_DEPLOYMENT_ID: randomUUID() };
    const disabled = await rollout.setChatRefinerInitialAutoRollout({
      session, request, enabled: false,
      runtimeCommitSha: otherDeployment.RAILWAY_GIT_COMMIT_SHA,
      runtimeDeploymentId: otherDeployment.RAILWAY_DEPLOYMENT_ID,
    }, otherDeployment);
    assert.equal(disabled.enabled, false);
    assert.equal((await prisma.appSetting.findUniqueOrThrow({
      where: { key: "feature.promptRefinerEnabled" },
      select: { value: true },
    })).value, "false");
    assert.equal((await audit.verifyAdminAuditIntegrity()).valid, true);
    await prisma.$disconnect();
  });
