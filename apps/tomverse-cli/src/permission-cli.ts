import { safeLine } from "./display.js";
import { PermissionRuleStore, RuleFileError } from "./permission-rules.js";
import { describeRule, type PermissionRule, type RuleEffect, type RuleScope } from "./permissions.js";

/**
 * `tomverse permissions`: the same files the Desktop settings screen edits.
 *
 *   permissions [list]
 *   permissions add <allow|ask|deny> <tool> [pattern] [--project] [--exact]
 *   permissions remove <allow|ask|deny> <tool> [pattern] [--project]
 *   permissions trust [--revoke]       (confirms or withdraws this project's own allow rules)
 */

export const PERMISSIONS_HELP = [
    "tomverse permissions [list]     Allow, ask and deny rules (user: your CLI folder; project: .tomverse/permissions.json)",
    "tomverse permissions add <allow|ask|deny> <apply_patch|run_command|web_fetch|web_search|mcp__server__tool> [pattern] [--project] [--exact]",
    "tomverse permissions remove <allow|ask|deny> <tool> [pattern] [--project]",
    "tomverse permissions trust [--revoke] [--yes]   Apply (or stop applying) the allow rules this project came with",
];

export class PermissionsUsageError extends Error {}

type Flags = { project?: boolean; user?: boolean; exact?: boolean; revoke?: boolean; yes?: boolean };
type Io = { write: (text: string) => void; confirm: (question: string) => Promise<boolean>; interactive: boolean };

const effectArg = (value: string | undefined): RuleEffect => {
    if (value === "allow" || value === "ask" || value === "deny") return value;
    throw new PermissionsUsageError("The first word must be allow, ask or deny.");
};

export const permissionsCommand = async (args: string[], root: string, flags: Flags, io: Io): Promise<number> => {
    const store = new PermissionRuleStore({ root });
    const [sub = "list", ...rest] = args;
    if (flags.project && flags.user) throw new PermissionsUsageError("Choose --project or --user, not both.");
    const scope: RuleScope = flags.project ? "project" : "user";
    try {
        if (sub === "list") {
            const listed = store.list();
            const show = (title: string, rules: PermissionRule[]) => {
                io.write(`${title}\n`);
                for (const rule of rules) io.write(`  ${safeLine(describeRule(rule))}\n`);
                if (!rules.length) io.write("  (none)\n");
            };
            show(`User rules (${store.userPath()})`, listed.user);
            show(`Project rules (${store.projectPath()})`, listed.project);
            if (listed.trust === "untrusted" || listed.trust === "changed") {
                io.write(`This project's allow rules are NOT applied (${listed.trust === "changed" ? "they changed since you confirmed them" : "you have not confirmed them"}); its deny and ask rules are. Review them, then run: tomverse permissions trust\n`);
            }
            for (const problem of listed.problems) io.write(`Problem: ${safeLine(problem)}\n`);
            io.write("Order: deny, then ask, then allow. Commands that send something out of the computer, and credential files, are never allowed by a rule.\n");
            return 0;
        }
        if (sub === "add" || sub === "remove") {
            const [effect, tool, pattern] = rest;
            if (!tool) throw new PermissionsUsageError(`Usage: tomverse permissions ${sub} <allow|ask|deny> <tool> [pattern]`);
            const rule: PermissionRule = { effect: effectArg(effect), tool, ...(pattern !== undefined ? { pattern } : {}), ...(flags.exact ? { exact: true } : {}) };
            const changed = sub === "add" ? store.add(scope, rule) : store.remove(scope, rule);
            io.write(`${changed ? (sub === "add" ? "Added" : "Removed") : sub === "add" ? "Already there" : "No such rule"} (${scope}): ${safeLine(describeRule(rule))}\n`);
            return changed ? 0 : 1;
        }
        if (sub === "trust") {
            if (flags.revoke) {
                store.untrustProject();
                io.write("This project's own allow rules are no longer applied.\n");
                return 0;
            }
            const allow = store.read("project").filter((rule) => rule.effect === "allow");
            if (!allow.length) {
                io.write("This project has no allow rules of its own; nothing to confirm.\n");
                return 0;
            }
            io.write(`The project's own allow rules (from the repository):\n${allow.map((rule) => `  ${safeLine(describeRule(rule))}`).join("\n")}\n`);
            if (!flags.yes) {
                if (!io.interactive) throw new PermissionsUsageError("Confirming needs a terminal, or add --yes after reading the rules above.");
                if (!(await io.confirm("Apply these rules? They let the agent act without asking."))) return 4;
            }
            store.trustProject();
            io.write("Confirmed. These rules apply to this project; if the file changes, you will be asked again.\n");
            return 0;
        }
    } catch (error) {
        if (error instanceof RuleFileError) throw new PermissionsUsageError(error.message);
        throw error;
    }
    throw new PermissionsUsageError(`Unknown permissions command '${sub}'.`);
};
