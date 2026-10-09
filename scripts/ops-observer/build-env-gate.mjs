#!/usr/bin/env node
// The first command the ops-observer image runs at build time
// (docs/policy/sre-ops.md §3 rule 6).
//
// A runtime secret must never be visible while dependencies install or code
// builds. The Dockerfile declares no ARG, so the build should carry none of the
// services' variables; this gate proves it on every build instead of trusting
// the platform. It prints names only, never a value, and fails the build on the
// first sight of one.

import { buildEnvironmentViolations } from "./runtime-variables-core.mjs";

const violations = buildEnvironmentViolations(Object.keys(process.env));
if (violations.length > 0) {
  console.error(`ops_observer_build_env_gate=fail names=${violations.join(",")}`);
  process.exit(1);
}
console.log("ops_observer_build_env_gate=pass");
