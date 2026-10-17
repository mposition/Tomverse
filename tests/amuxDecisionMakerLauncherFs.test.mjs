// The AMUX Decision Maker launcher's filesystem half, stage S2-3a
// (docs/policy/amux-decision-maker.md policy version 2, §5 and §5a): the
// preflight's checks against a re-rooted host, the checked path chains, the
// deletion of the request's directories and the vendor account's CLI state,
// and the verification whose failure is `cleanup_unknown`. Every test works
// inside its own temporary directory. Tests that need a symbolic link, an
// owner or a permission bit run where the platform has them.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DM_LAUNCH_OUTPUT_MAX_BYTES,
  DM_OUTPUT_SCHEMA_PATH,
  DM_REQUEST_ROOT,
  dmExecutionPlan,
} from "../lib/amux/decisionMakerLauncherCore.ts";
import {
  DM_SYSTEM_HOST,
  dmCleanupRequestDirectory,
  dmCleanupVendor,
  dmCreateTemporaryDirectory,
  dmExpectedExecutableSha256,
  dmFileSha256,
  dmManagedSettingsRefusal,
  dmPreflightRefusals,
  dmReadOutputFile,
  dmReadRequestOutput,
  dmTestHost,
  dmVerifyCliState,
} from "../lib/amux/decisionMakerLauncherFs.ts";
import { PAYLOAD, REQUEST_ID, REQUEST_KEY, makeLauncherFixture, sha256 } from "./support/amuxDmLauncherFixture.mjs";

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

const planOf = (fixture) => {
  const planned = dmExecutionPlan(fixture.spec.instance, REQUEST_ID);
  assert.equal(planned.ok, true);
  return planned.plan;
};

const preflight = (fixture, overrides = {}, options = { expectedExecutableSha256: fixture.executableSha256 }) => {
  const plan = planOf(fixture);
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

/** A directory outside the fixture, holding data no cleanup may touch. */
const withOutside = (run) => {
  const outside = mkdtempSync(join(tmpdir(), "amux-dm-launcher-outside-"));
  try {
    return run(outside);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
};

test("a host set up as §5a requires passes every check", () => {
  for (const instance of [OPENAI, ANTHROPIC]) withFixture(instance, (fixture) => assert.deepEqual(preflight(fixture), []));
});

test("only a test host may expect another executable than §5a's", () => {
  assert.equal(dmExpectedExecutableSha256(DM_SYSTEM_HOST, OPENAI, undefined), "628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1");
  assert.throws(() => dmExpectedExecutableSha256(DM_SYSTEM_HOST, OPENAI, "00".repeat(32)));
  assert.equal(dmExpectedExecutableSha256(dmTestHost("/x"), OPENAI, "ab".repeat(32)), "ab".repeat(32));
  assert.deepEqual(DM_SYSTEM_HOST.owners, {
    root: 0,
    broker: 993,
    vendor: { "decision-maker-openai": 992, "decision-maker-anthropic": 991 },
  });
});

test("§5a: an executable whose sha256 is not the policy's, or that cannot be read, is refused", () => {
  withFixture(OPENAI, (fixture) => {
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
  withFixture(ANTHROPIC, (fixture) => {
    fixture.write("/home/amux-dm-anthropic/.local/share/claude/versions/2.1.296", "binary");
    fixture.write("/home/amux-dm-anthropic/.cache/other/x", "x");
    assert.deepEqual(preflight(fixture), []);
  });
});

test("§5: the request directory must exist and the account's scratch root must hold no earlier request", () => {
  withFixture(ANTHROPIC, (fixture) => {
    rmSync(fixture.at(fixture.paths.requestDirectory), { recursive: true });
    assert.deepEqual(preflight(fixture), ["request_directories_unusable"]);
  });
  withFixture(OPENAI, (fixture) => {
    fixture.directory("/home/amux-dm-openai/dm-scratch/0a1b2c3d-4e5f-4a6b-8c7d-000000000000", 0o700);
    assert.deepEqual(preflight(fixture), ["request_directories_unusable"]);
  });
});

test("every failing check is reported, not only the first", () => {
  withFixture(ANTHROPIC, (fixture) => {
    rmSync(fixture.at(DM_OUTPUT_SCHEMA_PATH));
    fixture.write("/etc/claude-code/managed-settings.json", "{}");
    fixture.write("/home/amux-dm-anthropic/.claude.json", "{}");
    const plan = planOf(fixture);
    const environment = [...plan.environment, ["LD_PRELOAD", "/tmp/x.so"]];
    assert.deepEqual(
      preflight(fixture, { evidence: null, command: { executable: plan.executable, argv: plan.argv, environment } }),
      ["schema_unreadable", "managed_settings_present", "cli_state_residue", "transmit_intent_missing", "environment_not_fixed"],
    );
  });
});

test("the account makes its own 0700 temporary directory once, and the cleanups remove both directories", () => {
  withFixture(OPENAI, (fixture) => {
    const plan = planOf(fixture);
    assert.equal(dmCreateTemporaryDirectory(fixture.host, plan), true);
    assert.equal(existsSync(fixture.at(plan.paths.temporaryDirectory)), true);
    // A second time is refused: the directory is this request's alone.
    assert.equal(dmCreateTemporaryDirectory(fixture.host, plan), false);
    writeFileSync(fixture.at(plan.paths.outputFile), "{}");
    for (const path of [".codex/state_5.sqlite", ".codex/state_5.sqlite-wal", ".codex/models_cache.json", ".codex/skills/.system/x/SKILL.md", ".codex/tmp/arg0/a/.lock", ".codex/installation_id"]) {
      fixture.write(`/home/amux-dm-openai/${path}`, "state");
    }
    fixture.write("/home/amux-dm-openai/.local/bin/codex", "account copy, not in §5a's list");
    assert.deepEqual(dmCleanupVendor(fixture.host, OPENAI, REQUEST_ID), { status: "verified" });
    assert.deepEqual(fixture.homeEntries().sort(), [".codex/", ".codex/auth.json", ".local/", ".local/bin/", ".local/bin/codex", "dm-scratch/"]);
    assert.deepEqual(dmCleanupRequestDirectory(fixture.host, OPENAI, REQUEST_ID), { status: "verified" });
    assert.equal(existsSync(fixture.at(plan.paths.requestDirectory)), false);
    assert.deepEqual(readdirSync(fixture.at(DM_REQUEST_ROOT)), []);
  });
  withFixture(ANTHROPIC, (fixture) => {
    for (const path of [".claude.json", ".claude/sessions/1.json", ".claude/backups/b", ".claude/telemetry/t.json", ".claude/.last-cleanup", ".cache/claude/model-catalog/x.json", ".local/state/claude/locks/2.1.296.lock"]) {
      fixture.write(`/home/amux-dm-anthropic/${path}`, "state");
    }
    assert.deepEqual(dmCleanupVendor(fixture.host, ANTHROPIC, REQUEST_ID), { status: "verified" });
    assert.deepEqual(fixture.homeEntries().sort(), [".cache/", ".claude/", ".claude/.credentials.json", ".local/", ".local/state/"]);
  });
  assert.deepEqual(dmCleanupRequestDirectory(dmTestHost("/x"), OPENAI, "../r1"), {
    status: "cleanup_unknown",
    residue: [{ kind: "request_id_invalid", path: "" }],
  });
});

test("cleanup that cannot verify an empty state is cleanup_unknown, with what it found", () => {
  withFixture(OPENAI, (fixture) => {
    rmSync(fixture.at("/home/amux-dm-openai/.codex/auth.json"));
    mkdirSync(fixture.at("/home/amux-dm-openai/.codex/auth.json/inner"), { recursive: true });
    assert.deepEqual(dmCleanupVendor(fixture.host, OPENAI, REQUEST_ID), {
      status: "cleanup_unknown",
      residue: [{ kind: "state_keep_not_regular_file", path: "/home/amux-dm-openai/.codex/auth.json" }],
    });
    assert.equal(existsSync(fixture.at("/home/amux-dm-openai/.codex/auth.json/inner")), true);
  });
  withFixture(OPENAI, (fixture) => {
    rmSync(fixture.at("/home/amux-dm-openai/.codex"), { recursive: true });
    fixture.write("/home/amux-dm-openai/.codex", "a file where the state directory should be");
    assert.deepEqual(dmCleanupVendor(fixture.host, OPENAI, REQUEST_ID), {
      status: "cleanup_unknown",
      residue: [{ kind: "path_unsafe", path: "/home/amux-dm-openai/.codex" }],
    });
  });
  withFixture(ANTHROPIC, (fixture) => {
    rmSync(fixture.at("/home/amux-dm-anthropic"), { recursive: true });
    assert.deepEqual(dmCleanupVendor(fixture.host, ANTHROPIC, REQUEST_ID), {
      status: "cleanup_unknown",
      residue: [{ kind: "path_unsafe", path: "/home/amux-dm-anthropic" }],
    });
  });
});

// ---------------------------------------------------------------------------
// Review r-20261017-022204-8754f3, finding 1: a linked or foreign directory
// anywhere on a request's path. Nothing outside the request may be read
// through it or deleted under it, and the cleanup says it could not verify.
// ---------------------------------------------------------------------------

test("a link anywhere on the request directory's path: refused, nothing outside deleted, cleanup_unknown", { skip: !posix }, () => {
  for (const linked of ["/var/lib/amux-dm/requests", "/var/lib/amux-dm", "/var"]) {
    withOutside((outside) =>
      withFixture(OPENAI, (fixture) => {
        // Outside holds what the link would make the request directory resolve to.
        const tail = DM_REQUEST_ROOT.slice(linked.length);
        mkdirSync(join(outside, ...tail.split("/").filter(Boolean), REQUEST_ID), { recursive: true });
        writeFileSync(join(outside, ...tail.split("/").filter(Boolean), REQUEST_ID, "precious"), "not the request's");
        rmSync(fixture.at(linked), { recursive: true });
        symlinkSync(outside, fixture.at(linked));
        assert.deepEqual(preflight(fixture), ["request_directories_unusable"], linked);
        const cleanup = dmCleanupRequestDirectory(fixture.host, OPENAI, REQUEST_ID);
        assert.deepEqual(cleanup, { status: "cleanup_unknown", residue: [{ kind: "path_unsafe", path: linked }] }, linked);
        assert.equal(existsSync(join(outside, ...tail.split("/").filter(Boolean), REQUEST_ID, "precious")), true, linked);
      }),
    );
  }
});

test("a link on the account's own paths: nothing outside deleted, cleanup_unknown", { skip: !posix }, () => {
  // The scratch root, a state directory's parent, and a state root.
  for (const [linked, inside] of [
    ["/home/amux-dm-anthropic/dm-scratch", [REQUEST_ID, "precious"]],
    ["/home/amux-dm-anthropic/.cache", ["claude", "precious"]],
    ["/home/amux-dm-anthropic/.local", ["state", "claude", "precious"]],
    ["/home/amux-dm-anthropic/.claude", ["sessions", "precious"]],
  ]) {
    withOutside((outside) =>
      withFixture(ANTHROPIC, (fixture) => {
        mkdirSync(join(outside, ...inside.slice(0, -1)), { recursive: true });
        writeFileSync(join(outside, ...inside), "not the account's request state");
        rmSync(fixture.at(linked), { recursive: true, force: true });
        symlinkSync(outside, fixture.at(linked));
        const cleanup = dmCleanupVendor(fixture.host, ANTHROPIC, REQUEST_ID);
        assert.equal(cleanup.status, "cleanup_unknown", linked);
        assert.ok(cleanup.residue.some((entry) => entry.kind === "path_unsafe" && entry.path === linked), JSON.stringify(cleanup));
        assert.equal(existsSync(join(outside, ...inside)), true, linked);
      }),
    );
  }
});

test("a link entry inside a checked directory is removed as a link, its target left alone", { skip: !posix }, () => {
  withOutside((outside) =>
    withFixture(OPENAI, (fixture) => {
      writeFileSync(join(outside, "target"), "not the account's");
      mkdirSync(join(outside, "dir"));
      writeFileSync(join(outside, "dir", "inner"), "not the account's");
      symlinkSync(join(outside, "target"), fixture.at("/home/amux-dm-openai/.codex/link"));
      symlinkSync(join(outside, "dir"), fixture.at("/home/amux-dm-openai/.codex/dirlink"));
      symlinkSync(join(outside, "dir"), fixture.at(`${fixture.paths.requestDirectory}/snapshot`));
      assert.deepEqual(dmCleanupVendor(fixture.host, OPENAI, REQUEST_ID), { status: "verified" });
      assert.deepEqual(dmCleanupRequestDirectory(fixture.host, OPENAI, REQUEST_ID), { status: "verified" });
      assert.equal(existsSync(join(outside, "target")), true);
      assert.equal(existsSync(join(outside, "dir", "inner")), true);
    }),
  );
  withFixture(OPENAI, (fixture) => {
    // The request directory itself replaced by a link: the link goes, what it points at stays.
    withOutside((outside) => {
      writeFileSync(join(outside, "precious"), "x");
      rmSync(fixture.at(fixture.paths.requestDirectory), { recursive: true });
      symlinkSync(outside, fixture.at(fixture.paths.requestDirectory));
      assert.deepEqual(preflight(fixture), ["request_directories_unusable"]);
      assert.deepEqual(dmCleanupRequestDirectory(fixture.host, OPENAI, REQUEST_ID), { status: "verified" });
      assert.equal(existsSync(join(outside, "precious")), true);
    });
  });
});

test("a directory on the path that its group or others can write is unsafe", { skip: !canChmod }, () => {
  for (const [path, mode] of [["/var/lib/amux-dm", 0o777], [DM_REQUEST_ROOT, 0o731], ["/home", 0o775]]) {
    withFixture(OPENAI, (fixture) => {
      chmodSync(fixture.at(path), mode);
      const cleanup = path === "/home" ? dmCleanupVendor(fixture.host, OPENAI, REQUEST_ID) : dmCleanupRequestDirectory(fixture.host, OPENAI, REQUEST_ID);
      assert.equal(cleanup.status, "cleanup_unknown", path);
      assert.ok(cleanup.residue.some((entry) => entry.kind === "path_unsafe" && entry.path === path), JSON.stringify(cleanup));
      if (path !== "/home") assert.equal(existsSync(fixture.at(fixture.paths.requestDirectory)), true);
    });
  }
  withFixture(OPENAI, (fixture) => {
    // The account's home is private: readable by others is already unsafe.
    chmodSync(fixture.at("/home/amux-dm-openai"), 0o750);
    assert.deepEqual(preflight(fixture), ["cli_state_residue", "request_directories_unusable"]);
  });
});

test("a directory with another owner than S0's on the path is unsafe", { skip: !posix }, () => {
  const uid = process.geteuid();
  // As if the request root belonged to an account other than the broker.
  const owners = { root: uid, broker: uid + 1, vendor: { [OPENAI]: uid, [ANTHROPIC]: uid } };
  withFixture(OPENAI, (fixture) => {
    assert.deepEqual(preflight(fixture), ["request_directories_unusable"]);
    assert.deepEqual(dmCleanupRequestDirectory(fixture.host, OPENAI, REQUEST_ID), {
      status: "cleanup_unknown",
      residue: [{ kind: "path_unsafe", path: DM_REQUEST_ROOT }],
    });
    assert.equal(existsSync(fixture.at(fixture.paths.requestDirectory)), true);
  }, { hostOptions: { owners } });
});

test("an entry the account cannot delete is cleanup_unknown", { skip: !canChmod }, () => {
  withFixture(OPENAI, (fixture) => {
    fixture.write("/home/amux-dm-openai/.codex/locked/state.json", "state");
    chmodSync(fixture.at("/home/amux-dm-openai/.codex/locked"), 0o500);
    const outcome = dmCleanupVendor(fixture.host, OPENAI, REQUEST_ID);
    assert.equal(outcome.status, "cleanup_unknown");
    // Renamed aside, then not removable: reported under the name it now has, and seen again by verification.
    assert.ok(outcome.residue.every((entry) => entry.path.startsWith("/home/amux-dm-openai/.codex/.amux-dm-removing-")), JSON.stringify(outcome));
    assert.deepEqual(outcome.residue.map((entry) => entry.kind).sort(), ["removal_failed", "state_entry_present"]);
  });
});

test("§5a: the -o file is read only as a regular file, through a checked directory, within the cap", () => {
  withFixture(OPENAI, (fixture) => {
    const plan = planOf(fixture);
    assert.equal(dmCreateTemporaryDirectory(fixture.host, plan), true);
    const path = fixture.at(plan.paths.outputFile);
    assert.deepEqual(dmReadRequestOutput(fixture.host, plan, DM_LAUNCH_OUTPUT_MAX_BYTES), { state: "absent" });
    writeFileSync(path, "{}");
    assert.deepEqual(Buffer.from(dmReadRequestOutput(fixture.host, plan, DM_LAUNCH_OUTPUT_MAX_BYTES).bytes).toString(), "{}");
    writeFileSync(path, "x".repeat(11));
    assert.deepEqual(dmReadOutputFile(path, 10), { state: "too_large" });
    rmSync(path);
    mkdirSync(path);
    assert.deepEqual(dmReadOutputFile(path, 10), { state: "unreadable" });
    if (posix) {
      rmSync(path, { recursive: true });
      symlinkSync(fixture.at("/home/amux-dm-openai/.codex/auth.json"), path);
      assert.deepEqual(dmReadRequestOutput(fixture.host, plan, DM_LAUNCH_OUTPUT_MAX_BYTES), { state: "unreadable" });
    }
  });
  withOutside((outside) =>
    withFixture(OPENAI, (fixture) => {
      if (!posix) return;
      const plan = planOf(fixture);
      mkdirSync(join(outside, REQUEST_ID));
      writeFileSync(join(outside, REQUEST_ID, "last-message.json"), '{"output":{"kind":"escalate","reason":"planted"}}');
      symlinkSync(outside, fixture.at("/home/amux-dm-openai/dm-scratch"));
      assert.deepEqual(dmReadRequestOutput(fixture.host, plan, DM_LAUNCH_OUTPUT_MAX_BYTES), { state: "unreadable" });
    }),
  );
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
