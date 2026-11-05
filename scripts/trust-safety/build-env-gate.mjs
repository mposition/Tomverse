#!/usr/bin/env node
// The first command the trust-safety observer image runs at build time
// (docs/policy/trust-safety-compliance-agent.md §4).
//
// A runtime secret must never be visible while the image is built. The
// Dockerfile declares no ARG, so the build should carry none of the service's
// variables; this gate proves it on every build that runs it rather than
// trusting the platform. Names only, never a value, and it fails the build on
// the first sight of one.

import { buildEnvironmentViolations } from "./runtime-variables-core.mjs";

const violations = buildEnvironmentViolations(Object.keys(process.env));
if (violations.length > 0) {
  console.error(`trust_safety_build_env_gate=fail names=${violations.join(",")}`);
  process.exit(1);
}
console.log("trust_safety_build_env_gate=pass");
