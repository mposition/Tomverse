import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { tomverseHome } from "./config.js";
import { canonicalDigest, writeFileAtomic } from "./session.js";
import { ruleProblem, type PermissionRule, type RuleScope, type ScopedRule } from "./permissions.js";

/**
 * Where the permission rules live, following the CLI's configuration folder
 * (`tomverseHome()`, or TOMVERSE_HOME):
 *
 *   - user rules:    <home>/permissions.json
 *   - project rules: <project>/.tomverse/permissions.json (in the repository)
 *   - trust:         <home>/permission-trust.json (never in the repository)
 *
 * The file tools never touch `.tomverse` or the home folder, so a task cannot
 * edit its own rules. A repository can bring its own rules, but a clone must
 * not be able to widen what the agent may do: the project's DENY and ASK rules
 * apply at once (they can only restrict); its ALLOW rules apply only after the
 * user has confirmed the project, and only for exactly the allow rules they
 * confirmed (a changed file asks again).
 */

export class RuleFileError extends Error {}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_RULES = 500;

const fileSchema = z.object({
    version: z.literal(1),
    rules: z.array(z.object({
        effect: z.enum(["allow", "ask", "deny"]),
        tool: z.string(),
        pattern: z.string().optional(),
        exact: z.boolean().optional(),
    }).strict()).max(MAX_RULES),
}).strict();

const trustSchema = z.object({ version: z.literal(1), projects: z.record(z.string(), z.string()) }).strict();

export type ProjectTrust = "not_needed" | "trusted" | "untrusted" | "changed";

const ruleKey = (rule: PermissionRule) => canonicalDigest({ e: rule.effect, t: rule.tool, p: rule.pattern ?? null, x: rule.exact ?? false });
const clean = (rule: PermissionRule): PermissionRule => ({
    effect: rule.effect, tool: rule.tool, ...(rule.pattern !== undefined ? { pattern: rule.pattern } : {}), ...(rule.exact ? { exact: true } : {}),
});

export class PermissionRuleStore {
    /** `root`: the real path of the work folder; null when no project is open (only user rules exist). */
    constructor(private readonly options: { root: string | null; env?: NodeJS.ProcessEnv }) {}

    private get home() {
        return tomverseHome(this.options.env ?? process.env);
    }

    userPath() {
        return join(this.home, "permissions.json");
    }

    projectPath() {
        return this.options.root ? join(this.options.root, ".tomverse", "permissions.json") : null;
    }

    trustPath() {
        return join(this.home, "permission-trust.json");
    }

    private pathFor(scope: RuleScope) {
        const path = scope === "user" ? this.userPath() : this.projectPath();
        if (!path) throw new RuleFileError("Open a project folder first.");
        return path;
    }

    /** The rules of one file. A missing file has none; one that cannot be read throws, so nobody assumes it was empty. */
    read(scope: RuleScope): PermissionRule[] {
        const path = scope === "user" ? this.userPath() : this.projectPath();
        if (!path || !existsSync(path)) return [];
        let text: string;
        try {
            const stat = lstatSync(path);
            if (stat.isSymbolicLink() || !stat.isFile()) throw new RuleFileError(`${path} must be a regular file.`);
            if (stat.size > MAX_FILE_BYTES) throw new RuleFileError(`${path} is too large.`);
            text = readFileSync(path, "utf8");
        } catch (error) {
            throw error instanceof RuleFileError ? error : new RuleFileError(`${path} could not be read.`);
        }
        let parsed;
        try {
            parsed = fileSchema.safeParse(JSON.parse(text));
        } catch {
            throw new RuleFileError(`${path} is not valid JSON.`);
        }
        if (!parsed.success) throw new RuleFileError(`${path} is not a permission rules file (version 1).`);
        for (const [index, rule] of parsed.data.rules.entries()) {
            const problem = ruleProblem(rule);
            if (problem) throw new RuleFileError(`${path}: rule ${index + 1}: ${problem}`);
        }
        return parsed.data.rules.map(clean);
    }

    private write(scope: RuleScope, rules: readonly PermissionRule[]) {
        const path = this.pathFor(scope);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileAtomic(path, `${JSON.stringify({ version: 1, rules: rules.map(clean) }, null, 2)}\n`);
    }

    private trustKey() {
        const root = this.options.root;
        if (!root) return null;
        let real = root;
        try {
            real = realpathSync.native(root);
        } catch { /* a folder that is gone has no trust to look up */ }
        return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
    }

    private readTrust(): Record<string, string> {
        const path = this.trustPath();
        if (!existsSync(path)) return {};
        try {
            const parsed = trustSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
            return parsed.success ? parsed.data.projects : {};
        } catch {
            // An unreadable trust file trusts nothing.
            return {};
        }
    }

    private static allowDigest(rules: readonly PermissionRule[]) {
        return canonicalDigest(rules.filter((rule) => rule.effect === "allow").map(ruleKey).sort());
    }

    /** Whether this project's own allow rules apply. */
    trust(projectRules = this.read("project")): ProjectTrust {
        if (!projectRules.some((rule) => rule.effect === "allow")) return "not_needed";
        const key = this.trustKey();
        const recorded = key ? this.readTrust()[key] : undefined;
        if (!recorded) return "untrusted";
        return recorded === PermissionRuleStore.allowDigest(projectRules) ? "trusted" : "changed";
    }

    private writeTrust(digest: string | null) {
        const key = this.trustKey();
        if (!key) throw new RuleFileError("Open a project folder first.");
        const projects = { ...this.readTrust() };
        if (digest) projects[key] = digest;
        else delete projects[key];
        mkdirSync(this.home, { recursive: true, mode: 0o700 });
        writeFileAtomic(this.trustPath(), `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
    }

    /** The user confirms this project's current allow rules. */
    trustProject() {
        this.writeTrust(PermissionRuleStore.allowDigest(this.read("project")));
    }

    untrustProject() {
        this.writeTrust(null);
    }

    /** What applies: the user's rules, the project's deny and ask rules, and the project's allow rules once trusted. */
    effective(): ScopedRule[] {
        const user = this.read("user").map((rule) => ({ ...rule, scope: "user" as const }));
        const project = this.read("project");
        const trusted = this.trust(project) !== "untrusted" && this.trust(project) !== "changed";
        return [...user, ...project.filter((rule) => rule.effect !== "allow" || trusted).map((rule) => ({ ...rule, scope: "project" as const }))];
    }

    /** Both files for a settings screen; a file that cannot be read is reported, not hidden. */
    list(): { user: PermissionRule[]; project: PermissionRule[]; trust: ProjectTrust; hasProject: boolean; problems: string[] } {
        const problems: string[] = [];
        const load = (scope: RuleScope) => {
            try {
                return this.read(scope);
            } catch (error) {
                problems.push((error as Error).message);
                return [];
            }
        };
        const user = load("user");
        const project = load("project");
        return { user, project, trust: this.trust(project), hasProject: this.options.root !== null, problems };
    }

    /**
     * Adds a rule the person chose. If the project's allow rules were trusted (or it had none), the new
     * rule is part of what they trust; otherwise rules that came with the repository stay unconfirmed.
     */
    add(scope: RuleScope, rule: PermissionRule): boolean {
        const problem = ruleProblem(rule);
        if (problem) throw new RuleFileError(problem);
        const current = this.read(scope);
        const key = ruleKey(rule);
        if (current.some((existing) => ruleKey(existing) === key)) return false;
        if (current.length >= MAX_RULES) throw new RuleFileError("There are too many rules.");
        const before = scope === "project" ? this.trust(current) : null;
        const next = [...current, clean(rule)];
        this.write(scope, next);
        if (scope === "project" && (before === "trusted" || before === "not_needed") && next.some((r) => r.effect === "allow")) {
            this.writeTrust(PermissionRuleStore.allowDigest(next));
        }
        return true;
    }

    remove(scope: RuleScope, rule: PermissionRule): boolean {
        const current = this.read(scope);
        const key = ruleKey(rule);
        const next = current.filter((existing) => ruleKey(existing) !== key);
        if (next.length === current.length) return false;
        const before = scope === "project" ? this.trust(current) : null;
        this.write(scope, next);
        if (scope === "project" && before === "trusted") this.writeTrust(next.some((r) => r.effect === "allow") ? PermissionRuleStore.allowDigest(next) : null);
        return true;
    }
}
