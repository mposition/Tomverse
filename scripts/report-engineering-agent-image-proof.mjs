#!/usr/bin/env node
/** Read-only deployment measurement. A complete path list must be retained
 * with the exact image digest and source commit before it can be reviewed as
 * possible T1 evidence; this report alone never changes a tier or switch. */
import { listEngineeringAgentImagePaths,
  summarizeEngineeringAgentImagePaths } from
  "./report-engineering-agent-image-proof-core.mjs";

const root = process.argv[2];
if (!root || process.argv.length !== 3) {
  console.error("usage: npm run report:engineering-agent-image-proof -- <image-root>");
  process.exitCode = 2;
} else {
  try {
    const paths = await listEngineeringAgentImagePaths(root);
    console.log(JSON.stringify({
      ...summarizeEngineeringAgentImagePaths(paths), paths,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "image_scan_failed");
    process.exitCode = 1;
  }
}
