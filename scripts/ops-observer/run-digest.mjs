#!/usr/bin/env node
// The digest service's child process (docs/policy/sre-ops.md §1 item 3). The
// supervisor starts it with only the digest child's variables and kills it at
// its deadline; everything it does is runDigest() in run-digest-core.mjs.

import { runDigest } from "./run-digest-core.mjs";

const { exitCode } = await runDigest({ env: process.env });
process.exit(exitCode);
