import { readFileSync, statSync } from "node:fs";
import { PermissionRuleStore, RuleFileError, ruleProblem, writeFileAtomic } from "../../../tomverse-cli/src/runtime.js";
import { tomverseHome } from "../../../tomverse-cli/src/config.js";
import { permissionMode, type PermissionCommand, type PermissionModeId, type PermissionResult, type PermissionsView } from "../permission-contract";

/**
 * The main process's side of permission modes and rules. It is the only place
 * the mode changes (a typed command from the Code screen) and the rule files
 * are written; the Code runtime gets the mode from a message of the main
 * process and reads the same rule files itself.
 *
 * Allow all is never saved: the app starts in ask mode again, so it is never
 * on by surprise. The other modes are remembered between runs.
 */

export class DesktopPermissions {
  private mode: PermissionModeId = "ask";
  private cache: { key: string; view: PermissionsView } | null = null;

  constructor(private readonly options: { modeFile: () => string; root: () => string | null; env?: NodeJS.ProcessEnv }) {}

  /** The folder the CLI keeps its configuration in (TOMVERSE_HOME, or ~/.tomverse): the same user rules the CLI uses. */
  get home() {
    return tomverseHome(this.options.env ?? process.env);
  }

  load() {
    try {
      const saved = permissionMode.parse(readFileSync(this.options.modeFile(), "utf8").trim());
      this.mode = saved === "allow_all" ? "ask" : saved;
    } catch { /* A new profile starts in ask mode. */ }
  }

  get current() {
    return this.mode;
  }

  /** What the runtime needs: the mode, and where the user's rules are. */
  runtimeMessage() {
    return { type: "permissions" as const, mode: this.mode, home: this.home };
  }

  private store() {
    return new PermissionRuleStore({ root: this.options.root(), env: { ...(this.options.env ?? process.env), TOMVERSE_HOME: this.home } });
  }

  private fileSignature(path: string | null) {
    if (!path) return "-";
    try {
      const stat = statSync(path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch { return "-"; }
  }

  view(): PermissionsView {
    const store = this.store();
    const key = [this.mode, this.options.root(), ...[store.userPath(), store.projectPath(), store.trustPath()].map((path) => this.fileSignature(path))].join("|");
    if (this.cache?.key === key) return this.cache.view;
    const listed = store.list();
    const view: PermissionsView = { mode: this.mode, rules: { user: listed.user, project: listed.project, trust: listed.trust, hasProject: listed.hasProject, problems: listed.problems } };
    this.cache = { key, view };
    return view;
  }

  run(command: PermissionCommand): PermissionResult {
    try {
      if (command.action === "set-mode") {
        if (command.mode === "allow_all" && command.confirmed !== true) return { ok: false, error: "Allow all needs your confirmation." };
        if (command.mode === this.mode) return { ok: true };
        writeFileAtomic(this.options.modeFile(), command.mode === "allow_all" ? "ask" : command.mode);
        this.mode = command.mode;
        return { ok: true };
      }
      const store = this.store();
      if (command.action === "trust-project") { store.trustProject(); return { ok: true }; }
      if (command.action === "revoke-trust") { store.untrustProject(); return { ok: true }; }
      const problem = ruleProblem(command.rule);
      if (problem) return { ok: false, error: problem };
      if (command.action === "add-rule") store.add(command.scope, command.rule);
      else store.remove(command.scope, command.rule);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof RuleFileError ? error.message : "The permission settings could not be saved." };
    }
  }
}
