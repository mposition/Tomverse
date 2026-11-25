import { z } from "zod";
import { sha256 } from "../../../tomverse-cli/src/session.js";
import { pathIdentity } from "../../../tomverse-cli/src/patch.js";
import type { Workspace } from "../../../tomverse-cli/src/workspace.js";
import { assertProjectRoot, type ProjectRoot } from "./project-root";

export const claudeReadInput = z.object({ file_path: z.string().min(1).max(4096) });
export const claudeReadReceipt = z.object({
  type: z.enum(["text", "file_unchanged"]),
  file: z.object({ filePath: z.string().min(1).max(4096) }),
});

export function bindClaudeRead(workspace: Workspace, project: ProjectRoot, path: string) {
  try {
    assertProjectRoot(project);
    const { absolute } = workspace.resolve(path, "read");
    const identity = pathIdentity(absolute, "file");
    if (!identity) return undefined;
    const canonical = process.platform === "win32" || process.platform === "darwin" ? absolute.toLowerCase() : absolute;
    return sha256(JSON.stringify([canonical, identity]));
  } catch { return undefined; }
}
