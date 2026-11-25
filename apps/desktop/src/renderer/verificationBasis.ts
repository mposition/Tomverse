import type { Verification } from "../contract";

export function verificationBasis(checks: ReadonlyArray<Pick<Verification, "state" | "exitCode">>) {
  let passed = 0;
  let failed = 0;
  let unconfirmed = 0;
  for (const check of checks) {
    if (check.state === "ok" && check.exitCode === 0) passed += 1;
    else if (check.state === "timeout" || check.state === "error" || (check.state === "ok" && Number.isInteger(check.exitCode))) failed += 1;
    else unconfirmed += 1;
  }
  return { passed, failed, unconfirmed };
}
