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
  changeMarketingChannelPolicyVersion,
  changeMarketingChannelScopes,
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

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * What is wrong with one marketing admin route, as a list of sentences.
 *
 * A function rather than a loop body so the same judgement runs over the real
 * routes *and* over a table of shapes that must not pass. A check that has
 * only ever seen code that passes cannot say whether it would catch code that
 * does not, and this one is a permission boundary -- three shapes got past an
 * earlier version of it.
 */
const marketingRouteOffenders = (relative, source) => {
  const offenders = [];
  {
    const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);

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
            continue;
          }
          // `export const { POST } = handlers`: the name is bound by a
          // pattern, and what it is bound to is a value this check does not
          // follow. It used to produce no handler, which read as nothing to
          // check.
          const bound = declaration.name.getText(tree);
          for (const method of MUTATING) {
            if (bound.includes(method)) {
              offenders.push(
                `${relative}: ${method} is bound by a pattern this check cannot follow`
              );
              seen.add(method);
            }
          }
        }
      } else if (ts.isExportDeclaration(statement) && !statement.exportClause) {
        // `export * from "..."`: what it exports is in another file, so this
        // check cannot say whether a mutating handler is among them. Unknown
        // is a failure here, not a pass -- the question is a permission
        // boundary.
        offenders.push(
          `${relative}: exports a whole module, so its handlers cannot be read here`
        );
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
    if (mutatingHandlers.length === 0) return offenders;

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

      // A concise arrow body is the whole answer.
      if (!ts.isBlock(fn.body)) {
        if (!isWrapperCall(fn.body)) {
          offenders.push(`${relative}: ${name} answers without the shared predicate`);
        }
        continue;
      }

      // The shape, not the presence.
      //
      // Asking whether the wrapper appears somewhere passed a handler that
      // called the store from an early return with an unreachable wrapper call
      // below it. Asking whether every *return* is the wrapper passed a
      // handler that did the write first and returned the wrapper afterwards
      // -- the write ran outside the permission check, the step-up check and
      // the audit transaction, and the sweep saw nothing wrong.
      //
      // So the body is restricted to what these handlers actually are: a route
      // may unwrap its dynamic segment, and then it must answer. Two forms,
      // nothing else. A handler that needs a third has to say so here, where
      // somebody will read the reason.
      const statements = fn.body.statements;
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        const isLast = index === statements.length - 1;

        if (isLast) {
          if (!ts.isReturnStatement(statement) || !isWrapperCall(statement.expression)) {
            offenders.push(
              `${relative}: ${name} does not end by returning the shared predicate`
            );
            continue;
          }
          // JavaScript evaluates the argument before it enters the function.
          // A call sitting directly in one of the spec's properties therefore
          // runs outside every check the wrapper performs, and the sweep saw
          // only the callee's name.
          //
          // The spec's properties are values and functions:
          // `action`, `summary`, `gate`, `targetId` and `metadata` are
          // literals or arrows, `run` is an arrow. A property whose value is
          // called or awaited where it sits is not one of those.
          let argument = statement.expression;
          while (ts.isAwaitExpression(argument) || ts.isParenthesizedExpression(argument)) {
            argument = argument.expression;
          }
          const [spec] = ts.isCallExpression(argument) ? argument.arguments : [];
          if (!spec || !ts.isObjectLiteralExpression(spec)) {
            offenders.push(
              `${relative}: ${name} does not pass the predicate a literal specification`
            );
            continue;
          }
          // The whole value, not its outermost node. Asking whether the
          // property *is* a call caught `row: store()` and missed
          // `row: cond ? store() : 1`, `row: void store()`,
          // `row: store() as object`, `row: store() satisfies object`,
          // `metadata: { row: store() }` and `...{ row: store() }` -- all of
          // which run before the wrapper is entered, so none of them has a
          // session, `marketing:write`, a recent sign-in or an audit
          // transaction around it.
          //
          // Functions are where the walk stops. `run`, `action`, `summary`,
          // `gate` and `metadata` are arrows the wrapper calls *inside* the
          // transaction; a call in one of their bodies is the point of them.
          const evaluatesEarly = (node) => {
            let found = false;
            const walk = (inner) => {
              if (found) return;
              if (
                ts.isArrowFunction(inner) ||
                ts.isFunctionExpression(inner) ||
                ts.isFunctionDeclaration(inner) ||
                ts.isMethodDeclaration(inner)
              ) {
                // The body is the function's; the *name* is not. A computed
                // name is evaluated where the function sits, so stopping at
                // the boundary without reading it let
                // `{ inner: { [iife()]() {} } }` through.
                if (inner.name && ts.isComputedPropertyName(inner.name)) {
                  walk(inner.name.expression);
                }
                return;
              }
              if (
                ts.isCallExpression(inner) ||
                ts.isNewExpression(inner) ||
                ts.isAwaitExpression(inner) ||
                ts.isTaggedTemplateExpression(inner)
              ) {
                found = true;
                return;
              }
              ts.forEachChild(inner, walk);
            };
            walk(node);
            return found;
          };

          for (const property of spec.properties) {
            // What names the property, before what it is set to. A computed
            // name runs when the object is built whatever kind of member it
            // names, and `{ [(() => { store(); return "request"; })()]: req }`
            // typechecks clean.
            if (
              property.name &&
              ts.isComputedPropertyName(property.name) &&
              evaluatesEarly(property.name.expression)
            ) {
              offenders.push(
                `${relative}: ${name} evaluates a computed property name before the predicate runs`
              );
            }

            // An accessor does not run when the object is built; it runs when
            // the property is read, and the wrapper reads `request`,
            // `bucket`, `schema` and `gate` before it opens the transaction
            // (lib/marketingAdminMutations.ts). A store call in a getter
            // therefore commits outside the audit transaction while looking
            // like an ordinary field. The specification is data: it has no
            // reason to carry an accessor at all, so the shape is refused
            // rather than its body inspected.
            if (
              ts.isGetAccessorDeclaration(property) ||
              ts.isSetAccessorDeclaration(property)
            ) {
              offenders.push(
                `${relative}: ${name} puts an accessor in the specification`
              );
              continue;
            }

            // A spread copies by reading, so a getter on the spread object
            // runs during the copy -- before the wrapper is entered. The
            // spread's own expression is usually an identifier, so walking it
            // finds nothing, and following it would mean following it into
            // another module. The specification is this route's own decision
            // in every field; assembling it from elsewhere is the shape, so
            // the shape is refused.
            if (ts.isSpreadAssignment(property)) {
              offenders.push(
                `${relative}: ${name} spreads something into the specification`
              );
              continue;
            }

            const value = ts.isPropertyAssignment(property)
              ? property.initializer
              : null;
            if (!value) continue;
            if (evaluatesEarly(value)) {
              offenders.push(
                `${relative}: ${name} evaluates ${property.name.getText(tree)} before the predicate runs`
              );
            }
          }
          continue;
        }

        // `const { postId } = await context.params;` and nothing else.
        //
        // "Awaits something" was not enough: `const row = await
        // pauseMarketingChannel(...)` awaits too, and it is a write running
        // before the permission check, the step-up check and the audit
        // transaction. What is awaited has to be a property read -- no call
        // anywhere inside it -- which is what unwrapping a dynamic segment is
        // and what a store call is not.
        const unwrapsParams =
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.every((declaration) => {
            const initializer = declaration.initializer;
            if (!initializer || !ts.isAwaitExpression(initializer)) return false;
            let awaited = initializer.expression;
            while (ts.isParenthesizedExpression(awaited)) awaited = awaited.expression;
            if (!ts.isPropertyAccessExpression(awaited)) return false;
            let calls = false;
            const look = (inner) => {
              if (ts.isCallExpression(inner) || ts.isNewExpression(inner)) calls = true;
              ts.forEachChild(inner, look);
            };
            look(awaited);
            return !calls;
          });
        if (!unwrapsParams) {
          offenders.push(
            `${relative}: ${name} does something before answering`
          );
        }
      }
      if (statements.length === 0) {
        offenders.push(`${relative}: ${name} does not answer at all`);
      }

    }
  }
  return offenders;
};

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

  const offenders = files.flatMap((file) =>
    marketingRouteOffenders(
      file.slice(file.indexOf("app" + sep)),
      readFileSync(file, "utf8")
    )
  );
  assert.deepEqual(offenders, []);
});

test("the route sweep fails every shape that gets past the predicate", () => {
  // Each of these writes without the wrapper's permission check, step-up
  // check and audit transaction, or hides whether it does. Three passed an
  // earlier version of the sweep.
  const imports =
    'import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";\n' +
    'import { pauseMarketingChannel } from "@/lib/marketingStore";\n\n';
  const bypasses = [
    [
      "an early return to the store, with the wrapper unreachable below it",
      imports +
        "export async function POST(req: Request) {\n" +
        "  if (req) return pauseMarketingChannel;\n" +
        "  return runMarketingAdminMutation({});\n" +
        "}\n",
    ],
    [
      "the write first, the wrapper afterwards",
      imports +
        "export async function POST(req: Request) {\n" +
        "  await pauseMarketingChannel(req, {});\n" +
        "  return runMarketingAdminMutation({});\n" +
        "}\n",
    ],
    [
      "a handler exported by specifier",
      imports +
        "async function POST(req: Request) {\n" +
        "  return pauseMarketingChannel;\n" +
        "}\n" +
        "export { POST };\n",
    ],
    [
      "a handler exported by a binding pattern",
      imports +
        "const handlers = { POST: async () => new Response() };\n" +
        "export const { POST } = handlers;\n",
    ],
    ["a whole module re-exported", imports + 'export * from "@/lib/elsewhere";\n'],
    [
      "a store call disguised as unwrapping the dynamic segment",
      imports +
        "export async function POST(req: Request) {\n" +
        "  const row = await pauseMarketingChannel(req, {});\n" +
        "  return runMarketingAdminMutation({ row });\n" +
        "}\n",
    ],
    [
      "a store call inside the specification, which is evaluated first",
      imports +
        "export async function POST(req: Request) {\n" +
        "  return runMarketingAdminMutation({ row: await pauseMarketingChannel(req, {}) });\n" +
        "}\n",
    ],
    // Six more ways to put the same call one node deeper. Every one of them
    // runs while the argument object is built, which is before the wrapper is
    // entered.
    ...[
      "{ ...{ row: pauseMarketingChannel(req, {}) } }",
      "{ row: req ? pauseMarketingChannel(req, {}) : 1 }",
      "{ metadata: { row: pauseMarketingChannel(req, {}) } }",
      "{ row: void pauseMarketingChannel(req, {}) }",
      "{ row: pauseMarketingChannel(req, {}) satisfies object }",
      "{ row: pauseMarketingChannel(req, {}) as object }",
    ].map((spec) => [
      `a store call one node deeper: ${spec}`,
      imports +
        "export async function POST(req: Request) {\n" +
        `  return runMarketingAdminMutation(${spec});\n` +
        "}\n",
    ]),
    [
      "a store call in a computed property name, which runs when the object is built",
      imports +
        "export async function POST(req: Request) {\n" +
        "  return runMarketingAdminMutation({\n" +
        '    [(() => { pauseMarketingChannel(req, {}); return "request"; })()]: req,\n' +
        "  });\n" +
        "}\n",
    ],
    [
      "a store call in a getter on a spread object, which runs during the copy",
      imports +
        "const prelude = {\n" +
        "  get bucket() { pauseMarketingChannel(undefined as never, {}); return \"b\"; },\n" +
        "};\n" +
        "export async function POST(req: Request) {\n" +
        "  return runMarketingAdminMutation({ ...prelude, request: req });\n" +
        "}\n",
    ],
    [
      "a store call in a nested method's computed name",
      imports +
        "export async function POST(req: Request) {\n" +
        "  return runMarketingAdminMutation({\n" +
        "    request: req,\n" +
        "    metadata: { [(() => pauseMarketingChannel(req, {}))()]() { return 1; } },\n" +
        "  });\n" +
        "}\n",
    ],
    [
      "a store call in a getter on a spread object, which runs during the copy",
      imports +
        "const prelude = {\n" +
        "  get bucket() { pauseMarketingChannel(undefined as never, {}); return \"b\"; },\n" +
        "};\n" +
        "export async function POST(req: Request) {\n" +
        "  return runMarketingAdminMutation({ ...prelude, request: req });\n" +
        "}\n",
    ],
    [
      "a store call in a nested method's computed name",
      imports +
        "export async function POST(req: Request) {\n" +
        "  return runMarketingAdminMutation({\n" +
        "    request: req,\n" +
        "    metadata: { [(() => pauseMarketingChannel(req, {}))()]() { return 1; } },\n" +
        "  });\n" +
        "}\n",
    ],
    [
      "a store call in a getter, which runs when the wrapper reads the field",
      imports +
        "export async function POST(req: Request) {\n" +
        "  return runMarketingAdminMutation({\n" +
        "    get request() { pauseMarketingChannel(req, {}); return req; },\n" +
        "  });\n" +
        "}\n",
    ],
    [
      "a handler that reads the session itself",
      'import { getServerSession } from "next-auth/next";\n' +
        imports +
        "export async function POST(req: Request) {\n" +
        "  const session = await getServerSession();\n" +
        "  return runMarketingAdminMutation({ session });\n" +
        "}\n",
    ],
  ];

  // Without this the table can shrink to nothing and still pass.
  assert.ok(bypasses.length >= 18, `only ${bypasses.length} bypass shape(s)`);
  const passed = bypasses
    .filter(([, source]) => marketingRouteOffenders("probe/route.ts", source).length === 0)
    .map(([name]) => name);
  assert.deepEqual(passed, []);
});

test("the route sweep accepts the shape the real routes are written in", () => {
  // The other half. A check that refuses everything is not a check either,
  // and the shape restriction added for the "write first" bypass is exactly
  // the kind that can go too far.
  const withParams =
    'import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";\n\n' +
    "type RouteContext = { params: Promise<{ postId: string }> };\n\n" +
    "export async function POST(req: Request, context: RouteContext) {\n" +
    "  const { postId } = await context.params;\n" +
    "  return runMarketingAdminMutation({ request: req, targetId: postId });\n" +
    "}\n";
  assert.deepEqual(marketingRouteOffenders("probe/route.ts", withParams), []);

  const withoutParams =
    'import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";\n\n' +
    "export async function PATCH(req: Request) {\n" +
    "  return runMarketingAdminMutation({ request: req });\n" +
    "}\n";
  assert.deepEqual(marketingRouteOffenders("probe/route.ts", withoutParams), []);
});

test("the marketing transaction brand has exactly one cast", () => {
  // Every directory that ships runtime code, not just `lib`. A cast in a
  // route is the same hole as a cast in a store, and the first version of this
  // check could not see one.
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const next = join(at, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        files.push(next);
      }
    }
  };
  for (const root of ["lib", "app", "components"]) {
    walk(join(process.cwd(), root));
  }

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
  assert.ok(casts[0].includes("marketingStore.ts:"), casts[0]);
});

test("nothing in the marketing code casts its way past a type", () => {
  // The brand check above looks for the brand's *name*, so `prisma as never`
  // and `prisma as any` would satisfy a `MarketingTransaction` parameter
  // without ever mentioning it. Those two assertions have no legitimate use in
  // this code, so they are refused outright rather than judged case by case.
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const next = join(at, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        files.push(next);
      }
    }
  };
  walk(join(process.cwd(), "app", "api", "admin", "marketing"));
  // Every file that handles the branded transaction, found by what it
  // mentions rather than by what it is called. Matching `lib/marketing*.ts`
  // left out `lib/appSettings.ts`, which is one of the writers.
  for (const entry of readdirSync(join(process.cwd(), "lib"), {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(process.cwd(), "lib", entry.name);
    if (readFileSync(path, "utf8").includes("MarketingTransaction")) {
      files.push(path);
    }
  }
  assert.ok(files.length >= 12, `the sweep found only ${files.length} files`);

  const escapes = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const written = node.type.getText(tree).trim();
        if (written === "any" || written === "never") {
          escapes.push(`${file.slice(file.indexOf("lib") >= 0 ? file.indexOf("lib") : 0)}: ${node.getText(tree).slice(0, 60)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.deepEqual(escapes, []);
});

test("no helper mints a type from nothing", () => {
  // `const cast = <T>(value: unknown): T => value as T` produces a
  // `MarketingTransaction` without the words ever appearing at the call site,
  // so both checks above miss it. There is no legitimate use of such a helper
  // in this code, and one would undo the brand entirely.
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const next = join(at, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        files.push(next);
      }
    }
  };
  walk(join(process.cwd(), "app", "api", "admin", "marketing"));
  for (const entry of readdirSync(join(process.cwd(), "lib"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      const path = join(process.cwd(), "lib", entry.name);
      if (readFileSync(path, "utf8").includes("MarketingTransaction")) files.push(path);
    }
  }

  const minters = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const parameters = node.typeParameters;
      if (parameters && parameters.length > 0) {
        const names = new Set(parameters.map((parameter) => parameter.name.text));
        const look = (inner) => {
          if (
            (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) &&
            ts.isTypeReferenceNode(inner.type) &&
            ts.isIdentifier(inner.type.typeName) &&
            names.has(inner.type.typeName.text)
          ) {
            minters.push(`${file}: ${inner.getText(tree).slice(0, 50)}`);
          }
          ts.forEachChild(inner, look);
        };
        ts.forEachChild(node, look);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.deepEqual(minters, []);
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

test("the drain refuses an account that is still publishing", async () => {
  // A drain is only meaningful while the publisher is being kept away from
  // those posts. On a running account it would be expiring approvals nobody
  // asked it to expire -- and it has to accept every state the resumes refuse
  // from, because a drain narrower than the refusal left a disconnected
  // account past the bound with no way back at all.
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
      error.code === "drain_not_stopped",
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
  // No `data:` at all, which is the shape every Prisma write takes. Reporting
  // the status it locked is not writing one, and the earlier version of this
  // assertion could not tell the two apart.
  assert.ok(!body.includes("data:"), "the drain writes something");
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

/**
 * Counts the reads a channel writer makes, so "did it look for due posts" is
 * an observable rather than an inference.
 *
 * Every one of these writers reads the row, then the clock, and only then --
 * if it is resuming something that was stopped -- the due posts.
 */
const countingReads = (channel) => {
  const reads = { total: 0 };
  return {
    reads,
    $queryRaw: async () => {
      reads.total += 1;
      if (reads.total === 1) return [channel];
      if (reads.total === 2) return [{ now: new Date("2026-09-22T01:00:00.000Z") }];
      return [];
    },
  };
};

test("a scope change on a running account does not expire its live schedules", async () => {
  // The round-two finding was that an identity change *resumes* a paused
  // account without paying what a resume pays. On an account that is already
  // publishing, expiring its due posts would be a different decision -- about
  // live schedules -- and docs/policy/marketing-automation.md §8.2 does not
  // make it.
  const channel = pausedChannel({
    status: "approval_mode",
    pausedAt: null,
    pausedFromMode: null,
    pauseReasonCode: null,
  });
  const { reads, $queryRaw } = countingReads(channel);
  let postUpdates = 0;
  await changeMarketingChannelScopes(
    {
      $queryRaw,
      marketingPost: {
        updateMany: async () => {
          postUpdates += 1;
          return { count: 1 };
        },
      },
      marketingChannel: { updateMany: async () => ({ count: 1 }) },
    },
    {
      id: channel.id,
      expectedScopesDigest: channel.scopesDigest,
      expectedPolicyVersion: channel.policyVersion,
      expectedGraduationEpoch: channel.graduationEpoch,
      scopesDigest: "c".repeat(64),
    },
  );
  assert.equal(postUpdates, 0);
  // The row and the clock, and no third read: it never went looking.
  assert.equal(reads.total, 2);
});

test("a scope change on a stopped account does look for due schedules", async () => {
  // The other half of the same rule, and the half the finding was about: an
  // identity change walks a stopped account back to approval mode, which is a
  // resume however it is spelled, so it owes the expiry a resume owes.
  const { reads, $queryRaw } = countingReads(pausedChannel());
  await changeMarketingChannelScopes(
    {
      $queryRaw,
      marketingPost: { updateMany: async () => ({ count: 1 }) },
      marketingChannel: { updateMany: async () => ({ count: 1 }) },
    },
    {
      id: "channel-1",
      expectedScopesDigest: DIGEST,
      expectedPolicyVersion: 1,
      expectedGraduationEpoch: 2,
      scopesDigest: "c".repeat(64),
    },
  );
  assert.equal(reads.total, 3);
});

test("the expiry record does not claim a door that was not used", () => {
  // One action name, because it is one fact. But the sentence used to say
  // "while its account resumed", and a drain is not a resume -- so the
  // sentence stopped naming a door and the metadata names it instead.
  const source = readFileSync(
    new URL("../lib/marketingStore.ts", import.meta.url),
    "utf8",
  );
  // The summary line itself, not the paragraph above it explaining why the
  // summary changed -- matching the explanation would fail on the comment that
  // documents the fix.
  assert.ok(
    !source.includes(
      'summary: "Expired a due marketing approval while its account resumed."',
    ),
    "the per-post expiry audit still says every expiry happened during a resume",
  );
  assert.ok(
    source.includes("trigger: options.trigger"),
    "the per-post expiry audit does not record which path expired it",
  );
});

test("the drain reaches every state a resume can refuse from", async () => {
  // The hole this closes: a disconnected account past the bound refused to
  // reconnect (the reconnect owes the expiry, and the expiry refuses a
  // backlog), refused to drain (the drain wanted `paused`), and has no
  // transition into `paused` at all. No Admin route could reduce the backlog,
  // so the account was stuck for good. A drain narrower than the refusal is
  // not a smaller drain, it is a trap.
  for (const status of ["paused", "disconnected", "connect_pending"]) {
    const { reads, $queryRaw } = countingReads(pausedChannel({ status }));
    const result = await drainDueMarketingApprovals(
      { $queryRaw, marketingPost: { updateMany: async () => ({ count: 1 }) } },
      { id: "channel-1" },
    );
    // The state it locked travels back, so the answer names it rather than
    // leaving a reader to infer it from a summary that used to say "paused"
    // whatever it had actually run against.
    assert.deepEqual(
      result,
      { status, expiredPostIds: [], remaining: false },
      status,
    );
    // The row, the clock, and the due query: it looked.
    assert.equal(reads.total, 3, status);
  }
});

test("the console offers the drain in exactly those states", () => {
  // Two lists that have to agree, in two languages, so they are compared
  // rather than trusted. The panel cannot import the store's predicate -- it
  // is a client component and the store is server-only -- and the last time
  // two copies of a closed list existed in this feature, they drifted.
  const panel = readFileSync(
    new URL("../components/admin/AdminMarketingPanel.tsx", import.meta.url),
    "utf8",
  );
  const store = readFileSync(
    new URL("../lib/marketingStore.ts", import.meta.url),
    "utf8",
  );
  const listed = (source, name) => {
    const at = source.indexOf(name);
    assert.ok(at > 0, `${name} is missing`);
    const open = source.indexOf("[", at);
    const close = source.indexOf("]", open);
    return source
      .slice(open + 1, close)
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
      .filter((entry) => entry.length > 0)
      .sort();
  };
  assert.deepEqual(
    listed(panel, "MARKETING_STOPPED_ACCOUNT_STATUSES"),
    listed(store, "MARKETING_STOPPED_STATUSES"),
  );
});

test("an identity change on a disconnected account refuses instead of failing", async () => {
  // Leaving `disconnected` takes a new connection generation -- the channel
  // trigger says so -- and these writers do not issue one. Without this the
  // write reached the database, the trigger raised, and the wrapper answered
  // 500: a refusal dressed as a fault, which tells an operator nothing about
  // what to do next.
  //
  // Bumping the generation here was the other option and is the wrong one. It
  // would make a scope change a way to reconnect an account, and reconnecting
  // is a person confirming a connection.
  for (const [writer, input] of [
    [
      changeMarketingChannelScopes,
      {
        id: "channel-1",
        expectedScopesDigest: DIGEST,
        expectedPolicyVersion: 1,
        expectedGraduationEpoch: 2,
        scopesDigest: "c".repeat(64),
      },
    ],
    [
      changeMarketingChannelPolicyVersion,
      {
        id: "channel-1",
        expectedScopesDigest: DIGEST,
        expectedPolicyVersion: 1,
        expectedGraduationEpoch: 2,
        policyVersion: 2,
      },
    ],
  ]) {
    let writes = 0;
    await assert.rejects(
      writer(
        {
          $queryRaw: async () => [pausedChannel({ status: "disconnected" })],
          marketingPost: {
            updateMany: async () => {
              writes += 1;
              return { count: 1 };
            },
          },
          marketingChannel: {
            updateMany: async () => {
              writes += 1;
              return { count: 1 };
            },
          },
        },
        input,
      ),
      (error) =>
        error instanceof MarketingStoreRefusedError &&
        error.code === "identity_change_needs_connection",
    );
    // Refused before the expiry, so a disconnected account is not half-drained
    // on its way to a refusal.
    assert.equal(writes, 0);
  }
});
