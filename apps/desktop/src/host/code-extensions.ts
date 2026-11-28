import { applyImport, collectImport, discoverExtensions, expandInvocation, ExtensionError, slashEntries } from "../../../tomverse-cli/src/runtime.js";
import type { CodeExtensionsInput, CodeExtensionsView } from "../contract";

/**
 * What the settings screen and the composer's / list show about the open project's skills, commands and agent definitions, and the
 * import from Claude Code / Codex. The renderer sends a typed action and gets text back: it never names a path, and every secret
 * value of an MCP server stays hidden (the real values are read again here, in the main process, when the person confirms the import).
 */

/**
 * Where the skills, commands, agents and installed plugins are read from. The main process has its own HOME and TOMVERSE_HOME.
 * The task runtime has neither, so it is handed the folders this process resolved (see extensionWorkerEnv): the user's home, the
 * Claude Code folder and the Tomverse folder, the same ones the settings screens list.
 */
export const discoverOptions = (env: NodeJS.ProcessEnv = process.env) => {
  const home = env.TOMVERSE_DESKTOP_USER_HOME?.trim();
  const claude = env.TOMVERSE_DESKTOP_CLAUDE_DIR?.trim();
  const tomverse = env.TOMVERSE_DESKTOP_EXTENSIONS_HOME?.trim();
  return {
    ...(home ? { home } : {}),
    ...(claude || tomverse ? { env: { ...env, ...(claude ? { CLAUDE_CONFIG_DIR: claude } : {}), ...(tomverse ? { TOMVERSE_HOME: tomverse } : {}) } } : {}),
  };
};

/** The skills, commands and agents the task runtime reads. */
export function discoverForRuntime(root: string, env: NodeJS.ProcessEnv = process.env) {
  return discoverExtensions(root, discoverOptions(env));
}

const emptyView = (): CodeExtensionsView => ({ project: false, skills: [], commands: [], agents: [], slash: [], issues: [] });

export function codeExtensionsView(root: string | null, input: CodeExtensionsInput): CodeExtensionsView {
  if (!root) return emptyView();
  const registry = discoverExtensions(root, discoverOptions());
  const view: CodeExtensionsView = {
    project: true,
    skills: registry.skills.map(({ name, description, source, scope, implicit, ignored }) => ({ name, description, source, scope, implicit, ignored })),
    commands: registry.commands.map(({ name, description, argumentHint, source, scope, ignored }) => ({ name, description, ...(argumentHint ? { argumentHint } : {}), source, scope, ignored })),
    agents: registry.agents.map(({ name, description, source, scope, base, model, ignored }) => ({ name, description, source, scope, base, ...(model ? { model } : {}), ignored })),
    slash: slashEntries(registry).map(({ name, kind, description, argumentHint }) => ({ name, kind, description, ...(argumentHint ? { argumentHint } : {}) })),
    issues: registry.issues,
  };
  if (input.action === "import-preview") view.importItems = collectImport(root, {}, registry).items;
  if (input.action === "import-apply") {
    const result = applyImport(root, input.ids);
    view.imported = { written: result.written, skipped: result.skipped.length };
    view.importItems = collectImport(root).items;
  }
  return view;
}


/**
 * `/name arguments` typed at the start of a Code task, when `name` is a skill or command of the project or the user's own folders:
 * the prompt it stands for (what the person sees is still what they typed) and a line for the event log. Null for anything else.
 */
export function slashPromptFor(root: string, text: string): { prompt: string; notice: string } | null {
  if (!text.startsWith("/")) return null;
  try {
    const invocation = expandInvocation(root, discoverForRuntime(root), text, discoverOptions());
    if (!invocation) return null;
    return {
      prompt: invocation.prompt,
      notice: `Running ${invocation.kind} /${invocation.name} (${invocation.source})${invocation.ignored.length ? `; not applied: ${invocation.ignored.join(", ")}` : ""}.`,
    };
  } catch (error) {
    if (error instanceof ExtensionError) return null;
    throw error;
  }
}
