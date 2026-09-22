import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adminAuditEntryHashVariants,
  ADMIN_AUDIT_SIGNING_KEY_ORDER,
} from "../lib/adminAuditIntegrityCore.ts";
import { MARKETING_AUDIT_PROBLEMS } from "../lib/marketingAuditEvidence.ts";
import {
  MARKETING_CONSOLE_SWITCH_CONTROLS,
  MARKETING_CONSOLE_SWITCH_NAMES,
} from "../lib/marketingConsoleSections.ts";
import {
  approveMarketingPost,
  drainDueMarketingApprovals,
  resumeMarketingChannelToApproval,
  createMarketingChannel,
  lowerMarketingChannelCaps,
  markMarketingPostReusable,
  MarketingStoreRefusedError,
  MARKETING_REFUSAL_STATUS,
  MARKETING_S2B1_ACTIONS,
  requeueMarketingPostAfterFailure,
  resumeMarketingChannelToAutonomous,
} from "../lib/marketingStore.ts";

const DIGEST = "b".repeat(64);
const auditSecret = "marketing-s2b1-store-unit-secret";

const signedAudit = ({
  id = "audit-1",
  action,
  targetId,
  metadata,
  createdAt = new Date("2026-09-22T00:01:00.000Z"),
}) => {
  const hashInput = {
    previousHash: null,
    actorUserId: "operator-1",
    actorEmail: "owner@example.test",
    action,
    targetType: targetId.startsWith("channel-")
      ? "MarketingChannel"
      : "MarketingPost",
    targetId,
    summary: "S2b1 test decision.",
    metadata: { actorHadMarketingWrite: true, ...metadata },
    ipAddress: null,
    userAgent: null,
    createdAt: createdAt.toISOString(),
  };
  return {
    id,
    ...hashInput,
    createdAt,
    entryHash:
      adminAuditEntryHashVariants(hashInput, auditSecret)[
        ADMIN_AUDIT_SIGNING_KEY_ORDER
      ],
  };
};

const withAuditKey = async (operation) => {
  const previous = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = auditSecret;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previous;
  }
};

const auditReader = (entry) => ({
  findUnique: async () => entry,
  findFirst: async () => null,
});

test("S2b1 action names are the exact approved inventory strings", () => {
  assert.deepEqual(Object.values(MARKETING_S2B1_ACTIONS), [
    "marketing_account.create",
    "marketing_account.connection_confirmed",
    "marketing_account.disconnect",
    "marketing_account.reconnect",
    "marketing_account.scopes_changed",
    "marketing_account.policy_version_changed",
    "marketing_account.pause",
    "marketing_account.resume_approval",
    "marketing_post.approval_expired_on_resume",
    "marketing_account.resume_autonomous",
    // Added by the S2 plan r6 amendment, which the round-2 independent review
    // asked for in as many words: a resume may only expire a bounded batch of
    // due approvals, so an account with a larger backlog needed a path that
    // clears it without leaving `paused`. It is its own action because it is
    // its own decision -- the record has to be able to say an operator drained
    // an account without saying they resumed it.
    "marketing_account.drain_due_approvals",
    "marketing_account.lower_caps",
    "marketing_post.approve",
    "marketing_post.reject",
    "marketing_post.edit",
    "marketing_post.mark_reusable",
    "marketing_post.schedule",
    "marketing_post.requeue_after_failure",
    "marketing_post.legal_hold_set",
    "marketing_post.legal_hold_released",
    "marketing_post.resolve_outcome_unknown",
    "marketing_post.unpublish",
    // The three switches the console may change. The webhook shadow switch and
    // the apply scope are absent on purpose: they belong to S2e and S2f, and an
    // action name for them here would be the first half of a route that skips
    // the evidence those slices exist to collect.
    "marketing_setting.drafts_changed",
    "marketing_setting.publish_changed",
    "marketing_setting.autonomous_changed",
  ]);
});

test("channel creation materialises every caller field before awaiting the slug", async () => {
  const reads = new Map();
  const once = (name, value) => ({
    enumerable: true,
    get() {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      return value;
    },
  });
  const raw = {};
  Object.defineProperties(raw, {
    channel: once("channel", "linkedin"),
    provider: once("provider", "zernio"),
    externalAccountRef: once("externalAccountRef", "account-ref"),
    defaultLocale: once("defaultLocale", "en"),
    allowedLocales: once("allowedLocales", ["en"]),
    scopesDigest: once("scopesDigest", DIGEST),
    policyVersion: once("policyVersion", 1),
  });
  let inserted;
  await createMarketingChannel(
    {
      marketingChannel: {
        findMany: async () => [],
        create: async ({ data }) => {
          inserted = data;
          return data;
        },
      },
    },
    raw,
  );
  assert.equal(inserted.accountSlug, "linkedin-1");
  assert.deepEqual(Object.fromEntries(reads), {
    channel: 1,
    provider: 1,
    externalAccountRef: 1,
    defaultLocale: 1,
    allowedLocales: 1,
    scopesDigest: 1,
    policyVersion: 1,
  });
});

const pendingPost = () => ({
  id: "post-1",
  channelId: "channel-1",
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  status: "pending_approval",
  envelope: null,
  envelopeDigest: DIGEST,
  approvedDigest: null,
  approvalAuditLogId: null,
  approvedAt: null,
  approvalExpiresAt: null,
  reusableAsTemplate: false,
  scheduledAt: null,
  publishAttempt: 0,
  externalPostId: null,
  publishedAt: null,
  deletedAt: null,
  contentPurgedAt: null,
  legalHold: false,
  history: [],
  historyVersion: 2,
  claimIds: [],
  assetIds: [],
  claimRegistryVersion: 1,
  assetRegistryVersion: 1,
  factSnapshot: {},
  factsDigest: null,
});

test("two approvals of one version produce one row update and keep the expiry", async () => {
  await withAuditKey(async () => {
    let row = pendingPost();
    let updateCount = 0;
    let winningWrite;
    const audit = signedAudit({
      action: MARKETING_S2B1_ACTIONS.postApprove,
      targetId: row.id,
      metadata: { digest: DIGEST },
    });
    const database = {
      $queryRaw: async () => [row],
      marketingPost: {
        updateMany: async ({ data }) => {
          if (row.status !== "pending_approval") return { count: 0 };
          updateCount += 1;
          winningWrite = data;
          row = { ...row, ...data };
          return { count: 1 };
        },
      },
      adminAuditLog: auditReader(audit),
    };
    const expiry = new Date("2026-09-23T00:00:00.000Z");
    const input = {
      id: row.id,
      expectedEnvelopeDigest: DIGEST,
      expectedHistoryVersion: 2,
      approvalAuditLogId: audit.id,
      approvalExpiresAt: expiry,
    };
    const results = await Promise.allSettled([
      approveMarketingPost(database, input),
      approveMarketingPost(database, input),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(updateCount, 1);
    assert.equal(winningWrite.approvalExpiresAt.toISOString(), expiry.toISOString());
    assert.equal(winningWrite.approvedDigest, DIGEST);
  });
});

test("an edited post is approved only under its new digest", async () => {
  await withAuditKey(async () => {
    const editedDigest = "c".repeat(64);
    const row = {
      ...pendingPost(),
      envelopeDigest: editedDigest,
      historyVersion: 3,
    };
    const audit = signedAudit({
      action: MARKETING_S2B1_ACTIONS.postApprove,
      targetId: row.id,
      metadata: { digest: editedDigest },
    });
    let write;
    await approveMarketingPost(
      {
        $queryRaw: async () => [row],
        marketingPost: {
          updateMany: async ({ data }) => {
            write = data;
            return { count: 1 };
          },
        },
        adminAuditLog: auditReader(audit),
      },
      {
        id: row.id,
        expectedEnvelopeDigest: editedDigest,
        expectedHistoryVersion: 3,
        approvalAuditLogId: audit.id,
        approvalExpiresAt: new Date("2026-09-23T00:00:00.000Z"),
      },
    );
    assert.equal(write.approvedDigest, editedDigest);
  });
});

test("a reusable marking whose post moved underneath it loses the CAS", async () => {
  await withAuditKey(async () => {
    const row = {
      ...pendingPost(),
      status: "published",
      approvedDigest: DIGEST,
      publishedAt: new Date("2026-09-22T00:00:00.000Z"),
      historyVersion: 3,
    };
    const audit = signedAudit({
      action: MARKETING_S2B1_ACTIONS.postMarkReusable,
      targetId: row.id,
      metadata: { digest: DIGEST, historyVersion: 3 },
    });
    await assert.rejects(
      markMarketingPostReusable(
        {
          $queryRaw: async () => [row],
          marketingPost: { updateMany: async () => ({ count: 0 }) },
          adminAuditLog: auditReader(audit),
        },
        {
          id: row.id,
          expectedEnvelopeDigest: DIGEST,
          expectedHistoryVersion: 3,
          auditLogId: audit.id,
        },
      ),
      (error) =>
        error instanceof MarketingStoreRefusedError &&
        error.code === "mark_reusable_conflict",
    );
  });
});

test("mark reusable accepts every template-eligible state and refuses the rest", async () => {
  // The four `loadApprovedTemplate` accepts, and one it does not. An earlier
  // version of this pinned `published` alone as the only markable state, which
  // would have left a post that reached `verified` -- which the publisher does
  // on its own -- permanently unmarkable, and a template nobody can mark is an
  // autonomy path nothing can reach.
  const attempt = (status, onAudit) =>
    markMarketingPostReusable(
      {
        $queryRaw: async () => [
          {
            ...pendingPost(),
            status,
            approvedDigest: DIGEST,
            envelopeDigest: DIGEST,
            historyVersion: 3,
          },
        ],
        adminAuditLog: { findUnique: onAudit },
      },
      {
        id: "post-1",
        expectedEnvelopeDigest: DIGEST,
        expectedHistoryVersion: 3,
        auditLogId: "audit-mark",
      },
    );

  for (const status of ["approved", "scheduled", "published", "verified"]) {
    let reached = false;
    await assert.rejects(
      attempt(status, async () => {
        reached = true;
        return null;
      }),
      () => true,
      status,
    );
    assert.equal(reached, true, `${status} should have reached audit verification`);
  }

  for (const status of ["drafted", "pending_approval", "failed", "deleted"]) {
    await assert.rejects(
      attempt(status, async () => {
        throw new Error("wrong-state writes must not reach audit verification");
      }),
      (error) =>
        error instanceof MarketingStoreRefusedError &&
        error.code === "mark_reusable_conflict",
      status,
    );
  }
});

const failedPost = () => ({
  ...pendingPost(),
  status: "failed",
  historyVersion: 4,
  approvalAuditLogId: "approval-before-failure",
  approvedAt: new Date("2026-09-21T23:00:00.000Z"),
  publishAttempt: 1,
  history: [
    {
      at: "2026-09-22T00:00:00.000Z",
      type: "attempt",
      attempt: 1,
      outcome: "failed",
      errorCode: "provider_rejected",
    },
  ],
});

test("requeue refuses an audit older than the failure it answers", async () => {
  const row = failedPost();
  const oldAudit = {
    ...signedAudit({
      action: MARKETING_S2B1_ACTIONS.postRequeueAfterFailure,
      targetId: row.id,
      metadata: { digest: DIGEST },
      createdAt: new Date("2026-09-21T23:59:59.000Z"),
    }),
  };
  await assert.rejects(
    requeueMarketingPostAfterFailure(
      {
        $queryRaw: async () => [row],
        adminAuditLog: auditReader(oldAudit),
      },
      {
        id: row.id,
        expectedEnvelopeDigest: DIGEST,
        expectedHistoryVersion: 4,
        auditLogId: oldAudit.id,
      },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "audit_evidence_entry_predates_decision",
  );
});

test("requeue refuses reuse of the previous approval audit id", async () => {
  const row = failedPost();
  await assert.rejects(
    requeueMarketingPostAfterFailure(
      { $queryRaw: async () => [row] },
      {
        id: row.id,
        expectedEnvelopeDigest: DIGEST,
        expectedHistoryVersion: 4,
        auditLogId: row.approvalAuditLogId,
      },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "requeue_conflict",
  );
});

test("autonomous resume refuses a missing closed reason before database work", async () => {
  let reads = 0;
  await assert.rejects(
    resumeMarketingChannelToAutonomous(
      {
        $queryRaw: async () => {
          reads += 1;
          return [];
        },
      },
      {
        id: "channel-1",
        auditLogId: "audit-1",
        reasonCode: undefined,
      },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "resume_reason_invalid",
  );
  assert.equal(reads, 0);
});

test("autonomous resume refuses an audit action that fails the store check", async () => {
  const row = {
    id: "channel-1",
    channel: "linkedin",
    status: "paused",
    connectionGeneration: 1,
    scopesDigest: DIGEST,
    policyVersion: 1,
    graduationEpoch: 2,
    graduatedAt: new Date("2026-09-20T00:00:00.000Z"),
    graduationSnapshot: {},
    pausedAt: new Date("2026-09-22T00:00:00.000Z"),
    pausedFromMode: "autonomous_mode",
    pauseReasonCode: "incident_review",
    lastResumeAuditLogId: null,
    dailyCapOverride: null,
    weeklyCapOverride: null,
  };
  const wrong = {
    ...signedAudit({
      action: "marketing_account.pause",
      targetId: row.id,
      metadata: { reasonCode: "incident_resolved" },
      createdAt: new Date("2026-09-22T00:01:00.000Z"),
    }),
  };
  await assert.rejects(
    resumeMarketingChannelToAutonomous(
      {
        $queryRaw: async () => [row],
        adminAuditLog: auditReader(wrong),
      },
      {
        id: row.id,
        auditLogId: wrong.id,
        reasonCode: "incident_resolved",
      },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "resume_evidence_action_mismatch",
  );
});

test("lower-caps refuses an effective increase before issuing UPDATE", async () => {
  let updates = 0;
  const row = {
    id: "channel-1",
    channel: "linkedin",
    status: "approval_mode",
    connectionGeneration: 1,
    scopesDigest: DIGEST,
    policyVersion: 1,
    graduationEpoch: 0,
    graduatedAt: null,
    graduationSnapshot: null,
    pausedAt: null,
    pausedFromMode: null,
    pauseReasonCode: null,
    lastResumeAuditLogId: null,
    dailyCapOverride: 0,
    weeklyCapOverride: 2,
  };
  await assert.rejects(
    lowerMarketingChannelCaps(
      {
        $queryRaw: async () => [row],
        marketingChannel: {
          updateMany: async () => {
            updates += 1;
            return { count: 1 };
          },
        },
      },
      { id: row.id, dailyCapOverride: 1, weeklyCapOverride: 2 },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "cap_change_raises_limit",
  );
  assert.equal(updates, 0);
});

test("every refusal the store can raise has an HTTP meaning", () => {
  // The route layer used to keep its own copy of this table and three of its
  // keys were misspellings, so those conflicts went out as 422 instead of 409.
  // The first version of this test then read quoted strings only, which missed
  // the thirty codes three call sites build from MARKETING_AUDIT_PROBLEMS --
  // a structural test with a hole exactly where the codes were not literals.
  const source = readFileSync(
    fileURLToPath(new URL("../lib/marketingStore.ts", import.meta.url)),
    "utf8"
  );
  const codes = new Set();
  for (const [, code] of source.matchAll(
    /MarketingStoreRefusedError\(\s*"([a-z_]+)"/g
  )) {
    codes.add(code);
  }
  for (const [, code] of source.matchAll(
    /requireOne\(\s*[A-Za-z0-9_.]+\s*,\s*"([a-z_]+)"/g
  )) {
    codes.add(code);
  }

  // The built ones, from the same closed list the store builds them from, and
  // only for prefixes the source actually uses.
  const prefixes = ["resume_evidence", "requeue_evidence", "audit_evidence"];
  for (const prefix of prefixes) {
    assert.ok(
      source.includes(`\`${prefix}_\${verdict.problem}\``),
      `${prefix} is in the table but no call site builds it`
    );
    for (const problem of MARKETING_AUDIT_PROBLEMS) codes.add(`${prefix}_${problem}`);
  }

  assert.ok(codes.size > 70, `expected the store to raise many refusals, saw ${codes.size}`);
  const missing = [...codes].filter((code) => !(code in MARKETING_REFUSAL_STATUS)).sort();
  assert.deepEqual(missing, [], "refusals with no HTTP meaning");
  const unused = Object.keys(MARKETING_REFUSAL_STATUS)
    .filter((code) => !codes.has(code))
    .sort();
  assert.deepEqual(unused, [], "statuses for refusals nothing raises");
});

test("the mutation gate reads the kill switch by the name the resolver uses", () => {
  // It read `MARKETING_AUTOPUBLISH_KILL_SWITCH`, which nothing in this
  // repository sets or reads. The only gate the slice had therefore did
  // nothing: turning the real switch on left every marketing mutation open.
  const source = readFileSync(
    fileURLToPath(new URL("../lib/marketingAdminMutations.ts", import.meta.url)),
    "utf8"
  );
  assert.match(source, /process\.env\[MARKETING_AUTOMATION_KILL_SWITCH_ENV\]/);
  assert.doesNotMatch(
    source,
    /process\.env\.[A-Z_]*KILL_SWITCH/,
    "the environment variable's name belongs to the resolver, not to a second copy"
  );
});

test("every marketing admin mutation route goes through the one predicate", () => {
  // The permission and step-up checks live in `runMarketingAdminMutation`
  // rather than in each route, which is only equivalent to checking them in
  // the route while every route actually goes through it.
  //
  // Read with the TypeScript parser rather than by searching the text. The
  // first version matched the function's name anywhere in the file, so a route
  // that called the store directly and mentioned the wrapper in a comment or
  // an unused import passed; it also missed `export const POST = ...` and any
  // aliased session read.
  const dir = fileURLToPath(new URL("../app/api/admin/marketing", import.meta.url));
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const next = join(at, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name === "route.ts") files.push(next);
    }
  };
  walk(dir);
  assert.ok(files.length >= 10, `expected the marketing routes, saw ${files.length}`);

  const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
  const offenders = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const relative = file.slice(file.indexOf("app" + sep));

    // What the file imported the wrapper as, if it did at all.
    let wrapperBinding = null;
    const sessionBindings = new Set();
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const from = statement.moduleSpecifier.getText(tree).slice(1, -1);
      const named = statement.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) continue;
      for (const element of named.elements) {
        const imported = (element.propertyName ?? element.name).text;
        const local = element.name.text;
        if (from.endsWith("marketingAdminMutations") && imported === "runMarketingAdminMutation") {
          wrapperBinding = local;
        }
        if (imported === "getServerSession" || imported === "auth") {
          sessionBindings.add(local);
        }
      }
    }

    // Every local name a function is reachable under, so the handlers can be
    // found whether the file writes `export async function POST` or declares
    // it and writes `export { handler as POST }` underneath. The second form
    // is not exotic -- it is what a file looks like after somebody wraps a
    // handler -- and a sweep that only reads the first would pass it without
    // looking at it, which for a permission boundary is worse than no sweep.
    const locals = new Map();
    for (const statement of tree.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        locals.set(statement.name.text, statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            locals.set(declaration.name.text, declaration);
          }
        }
      }
    }

    const mutatingHandlers = [];
    const seen = new Set();
    const take = (exportedName, node) => {
      if (!MUTATING.has(exportedName) || seen.has(exportedName)) return;
      seen.add(exportedName);
      mutatingHandlers.push({ name: exportedName, node });
    };
    for (const statement of tree.statements) {
      const exported = ts
        .getModifiers?.(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (exported && ts.isFunctionDeclaration(statement) && statement.name) {
        take(statement.name.text, statement);
      } else if (exported && ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            take(declaration.name.text, declaration);
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          const exportedName = element.name.text;
          if (!MUTATING.has(exportedName)) continue;
          const localName = (element.propertyName ?? element.name).text;
          const local = locals.get(localName);
          if (!local) {
            offenders.push(
              `${relative}: ${exportedName} is exported from somewhere this check cannot read`
            );
            seen.add(exportedName);
            continue;
          }
          take(exportedName, local);
        }
      }
    }
    if (mutatingHandlers.length === 0) continue;

    for (const { name, node } of mutatingHandlers) {
      let readsSession = false;
      const visitAll = (inner) => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
          if (sessionBindings.has(inner.expression.text)) readsSession = true;
        }
        ts.forEachChild(inner, visitAll);
      };
      visitAll(node);
      if (readsSession) {
        offenders.push(`${relative}: ${name} reads the session itself`);
      }

      // The handler's own body, not the file's. `run` is an arrow inside the
      // wrapper's argument and has returns of its own; they are the store's
      // results, not responses, and reading them as responses would be
      // reading the wrong function.
      const fn = ts.isFunctionDeclaration(node)
        ? node
        : node.initializer &&
            (ts.isArrowFunction(node.initializer) ||
              ts.isFunctionExpression(node.initializer))
          ? node.initializer
          : null;
      if (!fn || !fn.body) {
        offenders.push(`${relative}: ${name} is not a function this check can read`);
        continue;
      }

      const isWrapperCall = (expression) => {
        if (!expression) return false;
        let value = expression;
        while (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value)) {
          value = value.expression;
        }
        return (
          ts.isCallExpression(value) &&
          ts.isIdentifier(value.expression) &&
          wrapperBinding !== null &&
          value.expression.text === wrapperBinding
        );
      };

      // A concise arrow body is the whole answer; anything else has to be a
      // block whose every return is the wrapper.
      if (!ts.isBlock(fn.body)) {
        if (!isWrapperCall(fn.body)) {
          offenders.push(`${relative}: ${name} answers without the shared predicate`);
        }
        continue;
      }

      // Every return this handler can reach. Nested functions are skipped,
      // because their returns belong to them. A sweep that only asked whether
      // the wrapper appears *somewhere* passed a handler that called the store
      // from an early return and kept an unreachable wrapper call below it --
      // the call was there, and nothing ever ran it.
      const returns = [];
      const visitReturns = (inner) => {
        if (
          ts.isFunctionDeclaration(inner) ||
          ts.isFunctionExpression(inner) ||
          ts.isArrowFunction(inner) ||
          ts.isMethodDeclaration(inner) ||
          ts.isClassDeclaration(inner)
        ) {
          return;
        }
        if (ts.isReturnStatement(inner)) returns.push(inner);
        ts.forEachChild(inner, visitReturns);
      };
      ts.forEachChild(fn.body, visitReturns);

      if (returns.length === 0) {
        offenders.push(`${relative}: ${name} mutates without calling the shared predicate`);
        continue;
      }
      for (const returned of returns) {
        if (!isWrapperCall(returned.expression)) {
          offenders.push(
            `${relative}: ${name} has a return that is not the shared predicate`
          );
        }
      }
      // Nothing may run after it, so the wrapper's answer is the handler's.
      const last = fn.body.statements[fn.body.statements.length - 1];
      if (!last || !ts.isReturnStatement(last)) {
        offenders.push(`${relative}: ${name} does not end by answering`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the marketing transaction brand has exactly one cast", () => {
  const dir = join(process.cwd(), "lib");
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const next = join(at, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".ts")) files.push(next);
    }
  };
  walk(dir);

  // A brand is only a boundary while the cast that produces it is one place.
  // Anywhere else, `prisma as unknown as MarketingTransaction` would satisfy
  // the type and put the four writes of a resume back on four autocommits,
  // which is exactly the defect the brand was added for.
  const casts = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("MarketingTransaction")) continue;
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        node.type.getText(tree).includes("MarketingTransaction")
      ) {
        casts.push(`${file.slice(file.indexOf("lib" + sep))}: ${node.getText(tree).slice(0, 60)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }

  assert.equal(
    casts.length,
    1,
    `expected the one cast inside runMarketingTransaction, saw ${casts.join(" | ")}`
  );
  assert.ok(casts[0].startsWith("lib" + sep + "marketingStore.ts:"), casts[0]);
});

/** A paused channel row, in the shape `lockMarketingChannel` returns. */
const pausedChannel = (overrides = {}) => ({
  id: "channel-1",
  channel: "linkedin",
  status: "paused",
  connectionGeneration: 1,
  scopesDigest: DIGEST,
  policyVersion: 1,
  graduationEpoch: 2,
  graduatedAt: new Date("2026-09-20T00:00:00.000Z"),
  graduationSnapshot: {},
  pausedAt: new Date("2026-09-22T00:00:00.000Z"),
  pausedFromMode: "approval_mode",
  pauseReasonCode: "incident_review",
  lastResumeAuditLogId: null,
  dailyCapOverride: null,
  weeklyCapOverride: null,
  ...overrides,
});

/**
 * A `$queryRaw` that answers the three reads a resume makes, in order: the
 * row lock, the database clock, then the due posts.
 */
const resumeReads = (channel, due) => {
  let call = 0;
  return async () => {
    call += 1;
    if (call === 1) return [channel];
    if (call === 2) return [{ now: new Date("2026-09-22T01:00:00.000Z") }];
    return due;
  };
};

const duePost = (index) => ({
  id: `post-${index}`,
  status: "scheduled",
  historyVersion: 0,
  approvalExpiresAt: null,
  scheduledAt: new Date("2026-09-21T00:00:00.000Z"),
});

test("a resume refuses a backlog larger than one transaction before touching a row", async () => {
  // Fifty-one due posts: one more than the bound, which is the case the
  // review found could never resume. It refuses *before* the first update,
  // so the transaction that cannot succeed has not also spent the audit
  // chain's advisory lock on fifty appends to reach that answer.
  const due = Array.from({ length: 51 }, (unused, index) => duePost(index));
  let updates = 0;
  await assert.rejects(
    resumeMarketingChannelToApproval(
      {
        $queryRaw: resumeReads(pausedChannel(), due),
        marketingPost: {
          updateMany: async () => {
            updates += 1;
            return { count: 1 };
          },
        },
        marketingChannel: {
          updateMany: async () => {
            updates += 1;
            return { count: 1 };
          },
        },
      },
      { id: "channel-1" },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "resume_drain_required",
  );
  assert.equal(updates, 0);
});

test("the drain refuses an account that is not paused", async () => {
  // A drain is only meaningful while the publisher is being kept away from
  // those posts, and `paused` is what keeps it away. On a running account it
  // would be expiring approvals nobody asked it to expire.
  let reads = 0;
  await assert.rejects(
    drainDueMarketingApprovals(
      {
        $queryRaw: async () => {
          reads += 1;
          return [pausedChannel({ status: "approval_mode" })];
        },
      },
      { id: "channel-1" },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "drain_not_paused",
  );
  assert.equal(reads, 1);
});

test("the drain does not resume the account it drains", async () => {
  // The whole point of the path: it clears the backlog and leaves the account
  // exactly where it was. A drain that also resumed would be a resume with a
  // different name, and it would do the unbounded work this bound exists to
  // stop.
  const source = readFileSync(
    new URL("../lib/marketingStore.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function drainDueMarketingApprovals(");
  assert.ok(start > 0, "the drain store function is missing");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.ok(
    !body.includes("marketingChannel.update"),
    "the drain writes the channel row",
  );
  assert.ok(!body.includes("status:"), "the drain names a status to write");
});

test("the console switch controls name switches the writer accepts", () => {
  // Two names for one thing -- the payload's `autonomous` and the strip's
  // `autoPublish` -- so the pairing is written once. A control naming a
  // switch the writer does not know would be a button that only ever 422s.
  assert.deepEqual(
    MARKETING_CONSOLE_SWITCH_CONTROLS.map((control) => control.name),
    [...MARKETING_CONSOLE_SWITCH_NAMES],
  );
  assert.deepEqual(
    MARKETING_CONSOLE_SWITCH_CONTROLS.map((control) => control.state),
    ["drafts", "publish", "autoPublish"],
  );
});
