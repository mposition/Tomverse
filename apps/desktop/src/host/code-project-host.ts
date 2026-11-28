import { execFile } from "node:child_process";
import { same } from "../../../tomverse-cli/src/runtime.js";
import {
  codeProjectInput, parseWslList, sortCodeProjects,
  type CodeProject, type CodeProjectFailure, type CodeProjectInput, type CodeProjectPermission, type CodeProjectReply, type CodeProjectResult,
  type CodeProjectsView, type CodeWslState,
} from "../code-project-contract";
import type { PermissionModeId } from "../permission-contract";
import {
  addProject, canonicalProjectFolder, createProjectFolder, readCodeProjects, updateProject, validFolderName, writeCodeProjects,
  type CodeProjectFile,
} from "./code-project-store";

/**
 * The main process side of Code projects: the register file of the signed-in account, the folder dialogs, opening a project
 * as the open folder, and the WSL list. Every request is parsed here whatever the screen sent. A project is only a saved
 * folder: removing one never touches the folder, and nothing here is sent to the server.
 */

export type CodeProjectHostDeps = {
  /** The register file of the account that is signed in, or null when no account is (nothing is read or written then). */
  file(): string | null;
  now(): number;
  newId(): string;
  /** Nothing is running or being chosen: the open project may change. */
  canChange(): boolean;
  /** The folder a dialog returned, or null when the person closed it. `parent` is where a new folder is made. */
  pickFolder(kind: "existing" | "parent" | "relocate"): Promise<string | null>;
  /** Makes the folder the open project (the same window path a folder dialog used before). */
  open(folder: string): Promise<unknown>;
  /** The open project's folder, when it is a folder of this computer. */
  current(): string | null;
  /** The permission mode now in force, and a way to change it (the same typed command the Settings screen sends). */
  permission(): PermissionModeId;
  setPermission(mode: PermissionModeId): void;
  /** The folders this account opened before the register existed (read from the history Code kept for them); null while that history cannot be read yet. */
  historyFolders(): string[] | null;
  /** `wsl.exe -l -q` as bytes, or null when it cannot run. Tests give their own. */
  wslList(): Promise<Uint8Array | null>;
  platform: string;
  changed(): void;
};

/** What `wsl.exe -l -q` prints, read with a fixed argument list and a short timeout. */
export function runWslList(): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    execFile("wsl.exe", ["-l", "-q"], { timeout: 5_000, windowsHide: true, encoding: "buffer", maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

export function createCodeProjectHost(deps: CodeProjectHostDeps) {
  let cache: { file: string; data: CodeProjectFile } | null = null;
  let wsl: CodeWslState | null = null;
  let working = false;

  const load = () => {
    const file = deps.file();
    if (!file) { cache = null; return null; }
    if (cache?.file !== file) cache = { file, data: readCodeProjects(file) };
    return cache;
  };
  const save = (entry: { file: string; data: CodeProjectFile }) => writeCodeProjects(entry.file, entry.data);

  /** Moves the folders the account opened before into the register, once. Runs when the history can be read. */
  function migrate() {
    const entry = load();
    if (!entry || entry.data.migratedHistory) return;
    let folders: string[] | null;
    try { folders = deps.historyFolders(); } catch { return; }
    if (!folders) return;
    for (const folder of folders) addProject(entry.data, { folder }, deps.now(), deps.newId());
    entry.data.migratedHistory = true;
    save(entry);
  }

  const selectedOf = (data: CodeProjectFile) => {
    const folder = deps.current();
    return folder ? data.projects.find((project) => same(project.folder, folder))?.id ?? null : null;
  };

  const view = (): CodeProjectsView => {
    migrate();
    const entry = load();
    return entry ? { items: sortCodeProjects(entry.data.projects), selectedId: selectedOf(entry.data), platform: deps.platform }
      : { items: [], selectedId: null, platform: deps.platform };
  };

  const done = (result: CodeProjectResult, extra: Partial<CodeProjectReply> = {}): CodeProjectReply => { deps.changed(); return { result, ...extra }; };
  const fail = (failure: CodeProjectFailure) => done({ ok: false, failure });

  /** The mode a conversation in this project starts with: the project's own, else the current one (Allow all never follows to another project). */
  const startMode = (project: CodeProject, switching: boolean): PermissionModeId => {
    const now = deps.permission();
    return project.permissionMode ?? (switching && now === "allow_all" ? "ask" : now);
  };

  async function openProject(entry: { file: string; data: CodeProjectFile }, project: CodeProject): Promise<CodeProjectReply> {
    if (!deps.canChange()) return fail("busy");
    const bound = canonicalProjectFolder(project.folder);
    if (!bound.ok) return fail(bound.failure);
    const switching = !deps.current() || !same(deps.current()!, bound.folder);
    // The project that is open already is not opened again: that would drop the conversation on screen.
    if (switching) await deps.open(bound.folder);
    if (!deps.current() || !same(deps.current()!, bound.folder)) return fail("failed");
    updateProject(entry.data, project.id, { folder: bound.folder, lastUsedAt: deps.now() });
    // The conversation that stays open keeps the mode it has; only a project that is newly open brings its own.
    if (switching) {
      const mode = startMode(project, true);
      if (mode !== deps.permission()) deps.setPermission(mode);
    }
    save(entry);
    return done({ ok: true, id: project.id, changed: switching });
  }

  return {
    view,
    migrate,
    /** The person changed the permission mode: the open project remembers it (Allow all is remembered as Ask). */
    rememberPermission(mode: PermissionModeId) {
      const entry = load();
      const folder = deps.current();
      const project = entry && folder ? entry.data.projects.find((item) => same(item.folder, folder)) : undefined;
      if (!entry || !project) return;
      const stored: CodeProjectPermission = mode === "allow_all" ? "ask" : mode;
      if (project.permissionMode === stored) return;
      project.permissionMode = stored;
      save(entry);
    },
    async run(value: unknown): Promise<CodeProjectReply> {
      const input: CodeProjectInput = codeProjectInput.parse(value);
      if (input.action === "wsl") {
        if (deps.platform !== "win32") return { result: { ok: true }, wsl: { state: "unsupported" } };
        const bytes = await deps.wslList();
        wsl = bytes ? { state: "ready", distributions: parseWslList(bytes) } : { state: "unavailable" };
        return { result: { ok: true }, wsl };
      }
      const entry = load();
      if (!entry) return { result: { ok: false, failure: "signed-out" } };
      if (working) return { result: { ok: false, failure: "busy" } };
      working = true;
      try {
        migrate();
        if (input.action === "add-existing") {
          if (!deps.canChange()) return fail("busy");
          const picked = await deps.pickFolder("existing");
          if (!picked) return { result: { ok: false, failure: "cancelled" } };
          const bound = canonicalProjectFolder(picked);
          if (!bound.ok) return fail(bound.failure);
          const added = addProject(entry.data, { folder: bound.folder }, deps.now(), deps.newId());
          if (!added.ok) return fail(added.failure);
          if (added.created) save(entry);
          return openProject(entry, added.project);
        }
        if (input.action === "create-new") {
          if (!validFolderName(input.name)) return fail("invalid-name");
          if (!deps.canChange()) return fail("busy");
          const parent = await deps.pickFolder("parent");
          if (!parent) return { result: { ok: false, failure: "cancelled" } };
          const made = await createProjectFolder(parent, input.name, input.initGit);
          if (!made.ok) return fail(made.failure);
          const added = addProject(entry.data, { folder: made.folder, name: input.name }, deps.now(), deps.newId());
          if (!added.ok) return fail(added.failure);
          save(entry);
          const opened = await openProject(entry, added.project);
          return opened.result.ok && made.gitInit ? { ...opened, result: { ...opened.result, gitInit: made.gitInit } } : opened;
        }
        const project = entry.data.projects.find((item) => item.id === input.id);
        if (!project) return fail("not-found");
        switch (input.action) {
          case "select": return openProject(entry, project);
          case "rename": updateProject(entry.data, project.id, { name: input.name }); break;
          case "favorite": updateProject(entry.data, project.id, { favorite: input.favorite }); break;
          case "set-location":
            // Only Local is a default that can be applied: a cloud task needs the person's credit approval each time, and an SSH
            // project names its own remote folder. The other two stay in the contract for when they can be.
            if (input.location !== "local") return fail("failed");
            updateProject(entry.data, project.id, { defaultLocation: "local" });
            break;
          case "set-worktree": updateProject(entry.data, project.id, { worktree: input.worktree }); break;
          case "relocate": {
            if (!deps.canChange()) return fail("busy");
            const picked = await deps.pickFolder("relocate");
            if (!picked) return { result: { ok: false, failure: "cancelled" } };
            const bound = canonicalProjectFolder(picked);
            if (!bound.ok) return fail(bound.failure);
            if (entry.data.projects.some((item) => item.id !== project.id && same(item.folder, bound.folder))) return fail("exists");
            updateProject(entry.data, project.id, { folder: bound.folder });
            break;
          }
          case "remove": {
            // The registration only: the folder, its files and its saved conversations stay where they are.
            entry.data.projects = entry.data.projects.filter((item) => item.id !== project.id);
            break;
          }
        }
        save(entry);
        return done({ ok: true, id: project.id });
      } catch {
        return fail("failed");
      } finally {
        working = false;
      }
    },
  };
}
