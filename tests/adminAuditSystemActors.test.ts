import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import {
  SYSTEM_AUDIT_ACTORS,
  SYSTEM_AUDIT_ACTOR_METADATA_KEY,
  auditRowActorKind,
  isSystemAuditActor,
  metadataClaimsSystemActor,
} from "../lib/adminAuditSystemActors.ts";

// The closed list of system actors and the reserved metadata key.
//
// Contract: docs/policy/development-agent-orchestration.md. What counts as a
// human or system audit actor is decided here, once.

const ROOT = resolve(import.meta.dirname, "..");

test("the system actor list is closed and changes only by review", () => {
  assert.deepEqual([...SYSTEM_AUDIT_ACTORS], ["tomverse-amux-orchestrator"]);
  assert.equal(SYSTEM_AUDIT_ACTOR_METADATA_KEY, "systemActor");
  assert.equal(isSystemAuditActor("tomverse-amux-orchestrator"), true);
  assert.equal(isSystemAuditActor("Tomverse-AMUX-Orchestrator"), false);
  assert.equal(isSystemAuditActor(undefined), false);
});

test("only a top-level key of an object claims the marker", () => {
  assert.equal(metadataClaimsSystemActor({ systemActor: "x" }), true);
  assert.equal(metadataClaimsSystemActor({ systemActor: undefined }), true);
  assert.equal(metadataClaimsSystemActor({ nested: { systemActor: "x" } }), false);
  assert.equal(metadataClaimsSystemActor(["systemActor"]), false);
  assert.equal(metadataClaimsSystemActor(null), false);
  assert.equal(metadataClaimsSystemActor("systemActor"), false);
  // An inherited property is not the row's own claim.
  assert.equal(
    metadataClaimsSystemActor(Object.create({ systemActor: "x" })),
    false
  );
});

const row = (overrides: Record<string, unknown>) => ({
  actorUserId: null,
  actorEmail: null,
  ipAddress: null,
  userAgent: null,
  metadata: null,
  ...overrides,
});

test("a stored row is human, system, or unknown -- never guessed", () => {
  assert.equal(
    auditRowActorKind(row({ actorUserId: "admin-1", actorEmail: "a@example.test" })),
    "human"
  );
  assert.equal(
    auditRowActorKind(
      row({ metadata: { systemActor: "tomverse-amux-orchestrator" } })
    ),
    "system"
  );
  // Neither an actor nor a marker.
  assert.equal(auditRowActorKind(row({})), "unknown");
  // A marker beside session fields cannot come from either writer.
  assert.equal(
    auditRowActorKind(
      row({
        actorUserId: "admin-1",
        metadata: { systemActor: "tomverse-amux-orchestrator" },
      })
    ),
    "unknown"
  );
  assert.equal(
    auditRowActorKind(
      row({
        ipAddress: "203.0.113.7",
        metadata: { systemActor: "tomverse-amux-orchestrator" },
      })
    ),
    "unknown"
  );
  // A marker naming an actor that is not listed.
  assert.equal(
    auditRowActorKind(row({ metadata: { systemActor: "unlisted-worker" } })),
    "unknown"
  );
});

const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });

test("no administrator audit call site names the reserved key", () => {
  // The administrator writer began refusing `metadata.systemActor` in the same
  // change that introduced the system writer. That refusal throws, so a caller
  // already passing the key would have started failing its action. None did
  // when this was written (a repository search found the word only in the two
  // audit modules); this keeps every file that calls the administrator writer
  // free of it, so a future caller that needs both has to come through review.
  // It reads source text only: metadata built at runtime (a parsed body, a
  // result object) is covered by the writer's own refusal, not by this scan.
  const allowed = new Set(["lib/adminAudit.ts", "lib/adminAuditSystemActors.ts"]);
  const callSites = ["app", "lib", "components", "scripts", "packages"]
    .flatMap((top) => walk(resolve(ROOT, top)))
    .map((path) => relative(ROOT, path).split("\\").join("/"))
    .filter((path) => !allowed.has(path))
    .map((path) => ({ path, source: readFileSync(resolve(ROOT, path), "utf8") }))
    .filter(({ source }) => source.includes("writeAdminAuditLog("));
  assert.ok(callSites.length > 50, "the scan must actually reach the call sites");
  assert.deepEqual(
    callSites
      .filter(({ source }) => source.includes(SYSTEM_AUDIT_ACTOR_METADATA_KEY))
      .map(({ path }) => path),
    []
  );
});
