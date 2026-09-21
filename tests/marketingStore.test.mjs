import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import {
  adminAuditEntryHashVariants,
  ADMIN_AUDIT_SIGNING_KEY_ORDER,
} from "../lib/adminAuditIntegrityCore.ts";
import {
  appendMarketingPostHistory,
  MarketingStoreRefusedError,
  MARKETING_RESUME_AUTONOMOUS_ACTION,
  updateMarketingChannel,
} from "@/lib/marketingStore";

const DIGEST = "b".repeat(64);
const FIRST_SCHEDULE = "2026-09-22T02:00:00.000Z";
const SECOND_SCHEDULE = "2026-09-23T02:00:00.000Z";

const envelope = (scheduledAt = null) => ({
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: "Three models, three answers, side by side.",
  claimIds: [],
  assets: [],
  finalUrl: null,
  scheduledAt,
  disclosureFlags: ["advertising"],
});

const postDatabase = (capture) => ({
  marketingPost: {
    findUnique: async () => ({
      history: [
        {
          at: "2026-09-21T00:00:00.000Z",
          type: "draft",
          envelopeDigest: DIGEST,
        },
      ],
      historyVersion: 0,
      status: "drafted",
      envelopeDigest: DIGEST,
      envelope: envelope(),
      scheduledAt: null,
    }),
    updateMany: async (args) => {
      capture(args);
      return { count: 1 };
    },
  },
});

test("an envelope schedule accessor is read once and that value is written", async () => {
  let reads = 0;
  let write;
  const changingEnvelope = envelope();
  Object.defineProperty(changingEnvelope, "scheduledAt", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? FIRST_SCHEDULE : SECOND_SCHEDULE;
    },
  });

  const result = await appendMarketingPostHistory(
    postDatabase((args) => {
      write = args;
    }),
    {
      id: "post-1",
      expectedVersion: 0,
      entry: {
        at: "2026-09-21T01:00:00.000Z",
        type: "guard_result",
        decision: "approval_required",
        codes: [],
        ruleIds: [],
      },
      patch: {
        envelope: changingEnvelope,
        scheduledAt: new Date(FIRST_SCHEDULE),
      },
    },
  );

  assert.equal(result.appended, true);
  assert.equal(reads, 1);
  assert.equal(write.data.envelope.scheduledAt, FIRST_SCHEDULE);
  assert.equal(write.data.scheduledAt.toISOString(), FIRST_SCHEDULE);
});

test("a stable envelope and column schedule still append", async () => {
  let write;
  const result = await appendMarketingPostHistory(
    postDatabase((args) => {
      write = args;
    }),
    {
      id: "post-1",
      expectedVersion: 0,
      entry: {
        at: "2026-09-21T01:00:00.000Z",
        type: "guard_result",
        decision: "approval_required",
        codes: [],
        ruleIds: [],
      },
      patch: {
        envelope: envelope(FIRST_SCHEDULE),
        scheduledAt: new Date(FIRST_SCHEDULE),
      },
    },
  );

  assert.equal(result.appended, true);
  assert.equal(write.data.envelope.scheduledAt, FIRST_SCHEDULE);
});

test("different resolved answers write their different facts digests", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      resolve("tests/support/marketingStoreFactsDigestHarness.ts"),
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(
    child.status,
    0,
    `facts digest harness failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );
  assert.match(child.stdout, /MARKETING_STORE_FACTS_DIGEST_OK/u);
});

const auditSecret = "marketing-store-unit-secret";
const pauseAt = new Date("2026-09-21T00:00:00.000Z");
const auditAt = new Date("2026-09-21T00:01:00.000Z");

const resumeAudit = () => {
  const hashInput = {
    previousHash: null,
    actorUserId: "operator-1",
    actorEmail: "owner@example.test",
    action: MARKETING_RESUME_AUTONOMOUS_ACTION,
    targetType: "MarketingChannel",
    targetId: "channel-1",
    summary: "Resume after review.",
    metadata: {
      actorHadMarketingWrite: true,
      reasonCode: "operator_resume",
    },
    ipAddress: null,
    userAgent: null,
    createdAt: auditAt.toISOString(),
  };
  return {
    id: "audit-1",
    ...hashInput,
    createdAt: auditAt,
    entryHash:
      adminAuditEntryHashVariants(hashInput, auditSecret)[
        ADMIN_AUDIT_SIGNING_KEY_ORDER
      ],
  };
};

const channelDatabase = (count, capture) => ({
  marketingChannel: {
    findUnique: async () => ({
      status: "paused",
      pausedAt: pauseAt,
      pauseReasonCode: "incident",
      lastResumeAuditLogId: null,
    }),
    updateMany: async (args) => {
      capture(args);
      return { count };
    },
    findUniqueOrThrow: async () => ({ id: "channel-1" }),
  },
  adminAuditLog: {
    findUnique: async () => resumeAudit(),
    findFirst: async () => null,
  },
});

const withAuditKey = async (operation) => {
  const previous = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = auditSecret;
  try {
    await operation();
  } finally {
    if (previous === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previous;
  }
};

test("a changed pause reason makes the resume compare-and-set refuse", async () => {
  await withAuditKey(async () => {
    let write;
    await assert.rejects(
      updateMarketingChannel(
        channelDatabase(0, (args) => {
          write = args;
        }),
        "channel-1",
        { status: "autonomous_mode" },
        { auditLogId: "audit-1", reasonCode: "operator_resume" },
      ),
      (error) => {
        assert.ok(error instanceof MarketingStoreRefusedError);
        assert.equal(error.code, "channel_changed_under_us");
        return true;
      },
    );
    assert.equal(write.where.pauseReasonCode, "incident");
  });
});

test("an unchanged pause reason allows the verified resume", async () => {
  await withAuditKey(async () => {
    let write;
    const result = await updateMarketingChannel(
      channelDatabase(1, (args) => {
        write = args;
      }),
      "channel-1",
      { status: "autonomous_mode" },
      { auditLogId: "audit-1", reasonCode: "operator_resume" },
    );
    assert.equal(result.id, "channel-1");
    assert.equal(write.where.pauseReasonCode, "incident");
  });
});
