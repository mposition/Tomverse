// Task discovery and validation. A task is a directory:
//   task.json   metadata and the check command
//   repo/       what the agent receives
//   solution/   files copied over repo/ by the `fake` route
//   check/      hidden tests, copied into <work>/__check__ only after the agent finished
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CATEGORIES = ["bugfix", "feature", "refactor", "test-writing", "multi-file"];
export const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

const isDir = (path) => existsSync(path) && statSync(path).isDirectory();

export const validateTask = (task, dirName) => {
    const problems = [];
    if (task.id !== dirName) problems.push(`id "${task.id}" must equal the directory name "${dirName}"`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(task.id))) problems.push("id must be lowercase letters, digits and dashes");
    if (!CATEGORIES.includes(task.category)) problems.push(`category must be one of ${CATEGORIES.join(", ")}`);
    if (typeof task.title !== "string" || !task.title) problems.push("title is required");
    if (typeof task.prompt !== "string" || task.prompt.length < 20) problems.push("prompt is required");
    if (!Array.isArray(task.check) || !task.check.length || task.check.some((a) => typeof a !== "string"))
        problems.push("check must be a non-empty argv array of strings");
    if (!Number.isFinite(task.timeoutSeconds) || task.timeoutSeconds <= 0) problems.push("timeoutSeconds must be a positive number");
    return problems;
};

export const loadTask = (dir, tasksDir = TASKS_DIR) => {
    const root = join(tasksDir, dir);
    const file = join(root, "task.json");
    if (!existsSync(file)) throw new Error(`Task ${dir}: task.json is missing`);
    const task = JSON.parse(readFileSync(file, "utf8"));
    const problems = validateTask(task, dir);
    for (const sub of ["repo", "solution", "check"]) if (!isDir(join(root, sub))) problems.push(`${sub}/ is missing`);
    if (problems.length) throw new Error(`Task ${dir}: ${problems.join("; ")}`);
    return { ...task, dir: root };
};

export const loadTasks = (tasksDir = TASKS_DIR) => {
    if (!isDir(tasksDir)) return [];
    return readdirSync(tasksDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => loadTask(entry.name, tasksDir))
        .sort((a, b) => a.id.localeCompare(b.id));
};

/** Applies --task and --category filters; an unknown id is an error, not an empty run. */
export const selectTasks = (all, { ids = [], categories = [] } = {}) => {
    for (const id of ids) if (!all.some((t) => t.id === id)) throw new Error(`Unknown task "${id}". Use --list to see task ids.`);
    for (const category of categories) if (!CATEGORIES.includes(category)) throw new Error(`Unknown category "${category}" (${CATEGORIES.join(", ")}).`);
    return all.filter((t) => (!ids.length || ids.includes(t.id)) && (!categories.length || categories.includes(t.category)));
};
