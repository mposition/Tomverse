#!/usr/bin/env node
// The page service's child process (docs/policy/sre-ops.md §1 item 1). The
// supervisor starts it with only the page child's variables and kills it at
// its deadline; everything it does is runPage() in run-page-core.mjs.

import { runPage } from "./run-page-core.mjs";

const { exitCode } = await runPage({ env: process.env });
process.exit(exitCode);
