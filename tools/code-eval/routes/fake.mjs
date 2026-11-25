// Tool self-check: applies the task's solution. Every task must pass with it.
import { cpSync } from "node:fs";
import { join } from "node:path";

export const route = {
    name: "fake",
    paid: false,
    description: "copies solution/ over the working folder (proves the checks can pass)",
    async run({ task, workDir }) {
        cpSync(join(task.dir, "solution"), workDir, { recursive: true, force: true });
        return { status: "ok" };
    },
};
