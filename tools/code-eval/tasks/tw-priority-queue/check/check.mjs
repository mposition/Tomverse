import { runMutationCheck } from "./mutation-check.mjs";

const report = runMutationCheck({ minTests: 4 });
process.exit(report.ok ? 0 : 1);
