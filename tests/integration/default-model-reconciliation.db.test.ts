import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";

const run = promisify(execFile);

// The reconciliation script's preconditions, exercised through the script
// itself (ML-10).
//
// Contract: docs/policy/default-model-luna-migration.md §7,
// .github/audits/model-lifecycle-email-2026-08-22.md ML-10.
//
// The unit tests cover the rules. What only the real command can show is that
// the rules are actually reached: that --apply queries the registry before it
// scans anything, refuses on what it finds, and leaves every row alone. A rule
// nothing calls is a rule that does not hold.

const SCRIPT = "scripts/run-default-model-reconciliation.mjs";

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ModelMigrationRecord", "UserSettings", "ModelRegistryEntry", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

/** A registry row, retired or live depending on what the test is about. */
const model = (
  id: string,
  state: { enabled: boolean; publiclyListed: boolean }
) =>
  prisma.modelRegistryEntry.create({
    data: {
      id,
      name: id,
      apiModel: id,
      provider: "openai",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKeyEnvName: "OPENAI_API_KEY",
      minimumPlan: "Free",
      usageClass: "standard",
      creditWeight: 1,
      enabled: state.enabled,
      publiclyListed: state.publiclyListed,
    },
  });

const accountOn = async (modelId: string) => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test` },
  });
  await prisma.userSettings.create({
    data: { userId: user.id, defaultModel: modelId },
  });
  return user.id;
};

const reconcile = async (args: string[]) => {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--import", "tsx", SCRIPT, ...args],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          // The script refuses outright in CI, and this suite runs there.
          // Cleared so the test exercises the precondition rather than the
          // automation guard, which has its own unit coverage.
          CI: "",
          GITHUB_ACTIONS: "",
          npm_lifecycle_event: "",
        },
      }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

const APPROVAL = [
  "--apply",
  "--approved-retirement",
  "--ticket=https://github.com/mposition/tomverse/issues/999",
  "--actor=@mposition",
];

test("an enabled model may not be moved off, however complete the approval", async () => {
  // The acceptance criterion. Everything an operator can supply is present;
  // what refuses the run is the state of the database.
  await model("old-model", { enabled: true, publiclyListed: true });
  await model("new-model", { enabled: true, publiclyListed: true });
  const userId = await accountOn("old-model");

  const result = await reconcile([
    ...APPROVAL,
    "--from=old-model",
    "--to=new-model",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /from_not_retired/);
  const settings = await prisma.userSettings.findUniqueOrThrow({
    where: { userId },
    select: { defaultModel: true },
  });
  assert.equal(settings.defaultModel, "old-model", "no row may be touched");
  assert.equal(await prisma.modelMigrationRecord.count(), 0);
});

test("a retired source and a live replacement is allowed to write", async () => {
  await model("old-model", { enabled: false, publiclyListed: false });
  await model("new-model", { enabled: true, publiclyListed: true });
  const userId = await accountOn("old-model");

  const result = await reconcile([
    ...APPROVAL,
    "--from=old-model",
    "--to=new-model",
  ]);

  assert.equal(result.code, 0, result.stderr);
  const settings = await prisma.userSettings.findUniqueOrThrow({
    where: { userId },
    select: { defaultModel: true },
  });
  assert.equal(settings.defaultModel, "new-model");
  // The record is what makes the notice honest about who to tell.
  const records = await prisma.modelMigrationRecord.findMany({
    select: { userId: true, field: true, fromModelId: true, toModelId: true },
  });
  assert.deepEqual(records, [
    {
      userId,
      field: "user_settings_default_model",
      fromModelId: "old-model",
      toModelId: "new-model",
    },
  ]);
});

test("the script is not tied to one migration any more", async () => {
  // ML-10's point. Two ids it has never heard of, and it works -- which is what
  // stops the next retirement being done by copying the file and losing the
  // approval gate on the way.
  await model("some-2024-model", { enabled: false, publiclyListed: false });
  await model("some-2027-model", { enabled: true, publiclyListed: true });
  const userId = await accountOn("some-2024-model");

  const result = await reconcile([
    ...APPROVAL,
    "--from=some-2024-model",
    "--to=some-2027-model",
  ]);

  assert.equal(result.code, 0, result.stderr);
  const settings = await prisma.userSettings.findUniqueOrThrow({
    where: { userId },
    select: { defaultModel: true },
  });
  assert.equal(settings.defaultModel, "some-2027-model");
});

test("a replacement that cannot answer is refused", async () => {
  await model("old-model", { enabled: false, publiclyListed: false });
  await model("new-model", { enabled: false, publiclyListed: false });
  const userId = await accountOn("old-model");

  const result = await reconcile([
    ...APPROVAL,
    "--from=old-model",
    "--to=new-model",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /to_not_usable/);
  const settings = await prisma.userSettings.findUniqueOrThrow({
    where: { userId },
    select: { defaultModel: true },
  });
  assert.equal(settings.defaultModel, "old-model");
});

test("a model the registry does not know fails closed", async () => {
  await model("new-model", { enabled: true, publiclyListed: true });
  await accountOn("ghost-model");

  const result = await reconcile([
    ...APPROVAL,
    "--from=ghost-model",
    "--to=new-model",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /from_unknown/);
});

test("a dry run reports on a live model without touching it", async () => {
  // The safe half stays one command away: no approval, no precondition, and
  // no write. An operator has to be able to see the scope before deciding.
  await model("old-model", { enabled: true, publiclyListed: true });
  await model("new-model", { enabled: true, publiclyListed: true });
  const userId = await accountOn("old-model");

  const result = await reconcile(["--from=old-model", "--to=new-model"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN/);
  assert.match(result.stdout, /1 matched/);
  const settings = await prisma.userSettings.findUniqueOrThrow({
    where: { userId },
    select: { defaultModel: true },
  });
  assert.equal(settings.defaultModel, "old-model");
  assert.equal(await prisma.modelMigrationRecord.count(), 0);
});

test("a dry run without the pair says so instead of guessing", async () => {
  const result = await reconcile([]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--from=<model id> and --to=<model id> are required/);
});
