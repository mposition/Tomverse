// The AMUX Decision Maker launcher's filesystem half, stage S2-3a
// (docs/policy/amux-decision-maker.md policy version 2, §5 and §5a): the
// preflight's checks against a re-rooted host, the per-request deletion of
// the vendor account's CLI state and the request's directories, and the
// verification whose failure is `cleanup_unknown`. Every test works inside its
// own temporary directory. Tests that need a symbolic link or a permission
// bit run where the platform has them.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DM_LAUNCH_OUTPUT_MAX_BYTES,
  DM_OUTPUT_SCHEMA_PATH,
  dmExecutionPlan,
} from "../lib/amux/decisionMakerLauncherCore.ts";
import {
  DM_SYSTEM_HOST,
  dmCleanup,
  dmExpectedExecutableSha256,
  dmFileSha256,
  dmManagedSettingsRefusal,
  dmPreflightRefusals,
  dmReadOutputFile,
  dmTestHost,
  dmVerifyCliState,
} from "../lib/amux/decisionMakerLauncherFs.ts";
import { PAYLOAD, REQUEST_KEY, makeLauncherFixture, sha256 } from "./support/amuxDmLauncherFixture.mjs";

const OPENAI = "decision-maker-openai";
const ANTHROPIC = "decision-maker-anthropic";
const posix = process.platform !== "win32";
const canChmod = posix && process.getuid?.() !== 0;

const withFixture = (instance, run, options) => {
  const fixture = makeLauncherFixture(instance, options);
  try {
    return run(fixture);
  } finally {
    fixture.dispose();
  }
};

const preflight = (fixture, overrides = {}, options = { expectedExecutableSha256: fixture.executableSha256 }) => {
  const planned = dmExecutionPlan(fixture.spec.instance, fixture.paths);
  assert.equal(planned.ok, true);
  const { plan } = planned;
  return dmPreflightRefusals(
    fixture.host,
    {
      plan,
      command: { executable: plan.executable, argv: plan.argv, environment: plan.environment },
      evidence: fixture.evidence,
      requestKey: REQUEST_KEY,
      payload: PAYLOAD,
      ...overrides,
    },
    options,
  );
};

test("a host set up as §5a requires passes every check", () => {
  for (const instance of [OPENAI, ANTHROPIC]) withFixture(instance, (fixture) => assert.deepEqual(preflight(fixture), []));
});

test("only a test host may expect another executable than §5a's", () => {
  assert.equal(dmExpectedExecutableSha256(DM_SYSTEM_HOST, OPENAI, undefined), "628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1");
  assert.throws(() => dmExpectedExecutableSha256(DM_SYSTEM_HOST, OPENAI, "00".repeat(32)));
  assert.equal(dmExpectedExecutableSha256(dmTestHost("/x"), OPENAI, "ab".repeat(32)), "ab".repeat(32));
});

test("§5a: an executable whose sha256 is not the policy's, or that cannot be read, is refused", () => {
  withFixture(OPENAI, (fixture) => {
    // No override: the policy's sha256, which the stand-in is not.
    assert.deepEqual(preflight(fixture, {}, {}), ["executable_sha256_mismatch"]);
    writeFileSync(fixture.at(fixture.spec.executablePath), "a changed CLI\n");
    assert.deepEqual(preflight(fixture), ["executable_sha256_mismatch"]);
    rmSync(fixture.at(fixture.spec.executablePath));
    assert.deepEqual(preflight(fixture), ["executable_unreadable"]);
    mkdirSync(fixture.at(fixture.spec.executablePath));
    assert.deepEqual(preflight(fixture), ["executable_unreadable"]);
  });
});

test("§5a: a schema file that is not the launcher's constant, or is missing, is refused", () => {
  withFixture(ANTHROPIC, (fixture) => {
    writeFileSync(fixture.at(DM_OUTPUT_SCHEMA_PATH), '{"type":"object"}');
    assert.deepEqual(preflight(fixture), ["schema_sha256_mismatch"]);
    rmSync(fixture.at(DM_OUTPUT_SCHEMA_PATH));
    assert.deepEqual(preflight(fixture), ["schema_unreadable"]);
  });
});

test("§5a: claude does not start while any managed settings source exists under /etc/claude-code", () => {
  for (const source of ["managed-settings.json", "managed-settings.d/10-team.json", "managed-mcp.json", null]) {
    withFixture(ANTHROPIC, (fixture) => {
      mkdirSync(fixture.at("/etc/claude-code"), { recursive: true });
      if (source) fixture.write(`/etc/claude-code/${source}`, "{}");
      assert.deepEqual(preflight(fixture), ["managed_settings_present"], String(source));
      assert.equal(dmManagedSettingsRefusal(fixture.host, ANTHROPIC), "managed_settings_present");
    });
  }
  // The check is claude's: codex has no managed-settings source in §5a.
  withFixture(OPENAI, (fixture) => {
    fixture.write("/etc/claude-code/managed-settings.json", "{}");
    assert.deepEqual(preflight(fixture), []);
  });
});

test("§5a: CLI state left outside the keep list by an earlier request refuses the next start", () => {
  const cases = [
    [OPENAI, "/home/amux-dm-openai/.codex/state_5.sqlite"],
    [OPENAI, "/home/amux-dm-openai/.codex/tmp/arg0/codex-arg0x/.lock"],
    [OPENAI, "/home/amux-dm-openai/.codex/sessions/rollout.jsonl"],
    [ANTHROPIC, "/home/amux-dm-anthropic/.claude.json"],
    [ANTHROPIC, "/home/amux-dm-anthropic/.claude/sessions/991114.json"],
    [ANTHROPIC, "/home/amux-dm-anthropic/.claude/backups/.claude.json.backup.1"],
    [ANTHROPIC, "/home/amux-dm-anthropic/.cache/claude/model-catalog.json"],
    [ANTHROPIC, "/home/amux-dm-anthropic/.local/state/claude/locks/2.1.296.lock"],
  ];
  for (const [instance, path] of cases) {
    withFixture(instance, (fixture) => {
      fixture.write(path, "state");
      assert.deepEqual(preflight(fixture), ["cli_state_residue"], path);
      assert.ok(dmVerifyCliState(fixture.host, instance).some((residue) => path.startsWith(residue.path)), path);
    });
  }
  // What §5a does not list is not the launcher's to judge.
  withFixture(ANTHROPIC, (fixture) => {
    fixture.write("/home/amux-dm-anthropic/.local/share/claude/versions/2.1.296", "binary");
    fixture.write("/home/amux-dm-anthropic/.cache/other/x", "x");
    assert.deepEqual(preflight(fixture), []);
  });
});

test("§5: the request's directories must exist, and the temporary one must be empty", () => {
  withFixture(OPENAI, (fixture) => {
    // A stale -o file would read as this request's result.
    fixture.write(fixture.paths.outputFile, '{"output":{"kind":"escalate","reason":"old"}}');
    assert.deepEqual(preflight(fixture), ["request_directories_unusable"]);
  });
  withFixture(ANTHROPIC, (fixture) => {
    rmSync(fixture.at(fixture.paths.requestDirectory), { recursive: true });
    assert.deepEqual(preflight(fixture), ["request_directories_unusable"]);
  });
  withFixture(ANTHROPIC, (fixture) => {
    rmSync(fixture.at(fixture.paths.temporaryDirectory), { recursive: true });
    assert.deepEqual(preflight(fixture), ["request_directories_unusable"]);
  });
});

test("every failing check is reported, not only the first", () => {
  withFixture(ANTHROPIC, (fixture) => {
    rmSync(fixture.at(DM_OUTPUT_SCHEMA_PATH));
    fixture.write("/etc/claude-code/managed-settings.json", "{}");
    fixture.write("/home/amux-dm-anthropic/.claude.json", "{}");
    const planned = dmExecutionPlan(ANTHROPIC, fixture.paths);
    const environment = [...planned.plan.environment, ["LD_PRELOAD", "/tmp/x.so"]];
    assert.deepEqual(
      preflight(fixture, {
        evidence: null,
        command: { executable: planned.plan.executable, argv: planned.plan.argv, environment },
      }),
      ["schema_unreadable", "managed_settings_present", "cli_state_residue", "transmit_intent_missing", "environment_not_fixed"],
    );
  });
});

test("cleanup deletes the request's directories and every CLI state entry but the authentication file", () => {
  withFixture(OPENAI, (fixture) => {
    for (const path of [".codex/state_5.sqlite", ".codex/state_5.sqlite-wal", ".codex/models_cache.json", ".codex/skills/.system/x/SKILL.md", ".codex/tmp/arg0/a/.lock", ".codex/installation_id"]) {
      fixture.write(`/home/amux-dm-openai/${path}`, "state");
    }
    fixture.write(fixture.paths.outputFile, "{}");
    fixture.write(`${fixture.paths.requestDirectory}/card.json`, "{}");
    fixture.write("/home/amux-dm-openai/.local/bin/codex", "account copy, not in §5a's list");
    assert.deepEqual(dmCleanup(fixture.host, OPENAI, fixture.paths), { status: "verified" });
    assert.deepEqual(fixture.homeEntries().sort(), [".codex/", ".codex/auth.json", ".local/", ".local/bin/", ".local/bin/codex"]);
    assert.equal(existsSync(fixture.at(fixture.paths.requestDirectory)), false);
    assert.equal(existsSync(fixture.at(fixture.paths.temporaryDirectory)), false);
  });
  withFixture(ANTHROPIC, (fixture) => {
    for (const path of [".claude.json", ".claude/sessions/1.json", ".claude/backups/b", ".claude/telemetry/t.json", ".claude/.last-cleanup", ".cache/claude/model-catalog/x.json", ".local/state/claude/locks/2.1.296.lock"]) {
      fixture.write(`/home/amux-dm-anthropic/${path}`, "state");
    }
    assert.deepEqual(dmCleanup(fixture.host, ANTHROPIC, fixture.paths), { status: "verified" });
    assert.deepEqual(fixture.homeEntries().sort(), [".cache/", ".claude/", ".claude/.credentials.json", ".local/", ".local/state/"]);
  });
});

test("cleanup that cannot verify an empty state is cleanup_unknown, with what it found", () => {
  withFixture(OPENAI, (fixture) => {
    // A kept name that is not a regular file is not deleted and not accepted.
    rmSync(fixture.at("/home/amux-dm-openai/.codex/auth.json"));
    mkdirSync(fixture.at("/home/amux-dm-openai/.codex/auth.json/inner"), { recursive: true });
    assert.deepEqual(dmCleanup(fixture.host, OPENAI, fixture.paths), {
      status: "cleanup_unknown",
      residue: [{ kind: "state_keep_not_regular_file", path: "/home/amux-dm-openai/.codex/auth.json" }],
    });
    assert.equal(existsSync(fixture.at("/home/amux-dm-openai/.codex/auth.json/inner")), true);
  });
  withFixture(OPENAI, (fixture) => {
    rmSync(fixture.at("/home/amux-dm-openai/.codex"), { recursive: true });
    fixture.write("/home/amux-dm-openai/.codex", "a file where the state directory should be");
    assert.deepEqual(dmCleanup(fixture.host, OPENAI, fixture.paths), {
      status: "cleanup_unknown",
      residue: [{ kind: "state_root_not_directory", path: "/home/amux-dm-openai/.codex" }],
    });
  });
  withFixture(ANTHROPIC, (fixture) => {
    rmSync(fixture.at("/home/amux-dm-anthropic"), { recursive: true });
    assert.deepEqual(dmCleanup(fixture.host, ANTHROPIC, fixture.paths), {
      status: "cleanup_unknown",
      residue: [{ kind: "home_not_directory", path: "/home/amux-dm-anthropic" }],
    });
  });
  withFixture(ANTHROPIC, (fixture) => {
    // Paths that failed validation cannot be deleted safely, so they are not verified either.
    const outcome = dmCleanup(fixture.host, ANTHROPIC, null);
    assert.deepEqual(outcome, { status: "cleanup_unknown", residue: [{ kind: "request_paths_invalid", path: "" }] });
  });
});

test("cleanup never follows a link: a linked ancestor or root is residue, a link entry is removed, not its target", { skip: !posix }, () => {
  withFixture(ANTHROPIC, (fixture) => {
    const outside = mkdtempSync(join(tmpdir(), "amux-dm-launcher-outside-"));
    try {
      mkdirSync(join(outside, "claude"));
      writeFileSync(join(outside, "claude", "keep-me"), "not the account's");
      writeFileSync(join(outside, "target"), "not the account's");
      symlinkSync(outside, fixture.at("/home/amux-dm-anthropic/.cache"));
      fixture.write("/home/amux-dm-anthropic/.claude/sessions/1.json", "state");
      symlinkSync(join(outside, "target"), fixture.at("/home/amux-dm-anthropic/.claude/link"));
      const outcome = dmCleanup(fixture.host, ANTHROPIC, fixture.paths);
      assert.deepEqual(outcome, {
        status: "cleanup_unknown",
        residue: [{ kind: "state_ancestor_not_directory", path: "/home/amux-dm-anthropic/.cache" }],
      });
      assert.equal(existsSync(join(outside, "claude", "keep-me")), true);
      assert.equal(existsSync(join(outside, "target")), true);
      assert.equal(existsSync(fixture.at("/home/amux-dm-anthropic/.claude/link")), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  withFixture(OPENAI, (fixture) => {
    const outside = mkdtempSync(join(tmpdir(), "amux-dm-launcher-outside-"));
    try {
      writeFileSync(join(outside, "auth.json"), "{}");
      writeFileSync(join(outside, "state_5.sqlite"), "state elsewhere");
      rmSync(fixture.at("/home/amux-dm-openai/.codex"), { recursive: true });
      symlinkSync(outside, fixture.at("/home/amux-dm-openai/.codex"));
      assert.deepEqual(dmCleanup(fixture.host, OPENAI, fixture.paths), {
        status: "cleanup_unknown",
        residue: [{ kind: "state_root_not_directory", path: "/home/amux-dm-openai/.codex" }],
      });
      assert.equal(existsSync(join(outside, "state_5.sqlite")), true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  withFixture(OPENAI, (fixture) => {
    rmSync(fixture.at("/home/amux-dm-openai/.codex/auth.json"));
    symlinkSync("/etc/hostname", fixture.at("/home/amux-dm-openai/.codex/auth.json"));
    assert.deepEqual(dmCleanup(fixture.host, OPENAI, fixture.paths).status, "cleanup_unknown");
  });
});

test("an entry the account cannot delete is cleanup_unknown", { skip: !canChmod }, () => {
  withFixture(OPENAI, (fixture) => {
    fixture.write("/home/amux-dm-openai/.codex/locked/state.json", "state");
    chmodSync(fixture.at("/home/amux-dm-openai/.codex/locked"), 0o500);
    const outcome = dmCleanup(fixture.host, OPENAI, fixture.paths);
    assert.equal(outcome.status, "cleanup_unknown");
    assert.deepEqual(outcome.residue, [{ kind: "state_entry_present", path: "/home/amux-dm-openai/.codex/locked" }]);
  });
});

test("§5a: the -o file is read only as a regular file, within the cap", () => {
  withFixture(OPENAI, (fixture) => {
    const path = fixture.at(fixture.paths.outputFile);
    assert.deepEqual(dmReadOutputFile(path, DM_LAUNCH_OUTPUT_MAX_BYTES), { state: "absent" });
    writeFileSync(path, "{}");
    assert.deepEqual(Buffer.from(dmReadOutputFile(path, DM_LAUNCH_OUTPUT_MAX_BYTES).bytes).toString(), "{}");
    writeFileSync(path, "x".repeat(11));
    assert.deepEqual(dmReadOutputFile(path, 10), { state: "too_large" });
    rmSync(path);
    mkdirSync(path);
    assert.deepEqual(dmReadOutputFile(path, 10), { state: "unreadable" });
    if (posix) {
      rmSync(path, { recursive: true });
      symlinkSync(fixture.at("/home/amux-dm-openai/.codex/auth.json"), path);
      assert.deepEqual(dmReadOutputFile(path, DM_LAUNCH_OUTPUT_MAX_BYTES), { state: "unreadable" });
    }
  });
});

test("the sha256 of a file is computed from its bytes and never through a link", () => {
  withFixture(OPENAI, (fixture) => {
    const path = fixture.at(fixture.spec.executablePath);
    assert.equal(dmFileSha256(path), fixture.executableSha256);
    assert.equal(fixture.executableSha256, sha256(Buffer.from("not a real CLI\n")));
    if (posix) {
      const link = fixture.at("/opt/tomverse-amux-dm/link");
      symlinkSync(path, link);
      assert.equal(dmFileSha256(link), null);
    }
  });
});
