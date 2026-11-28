import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { listSessions, same, sha256 } from "../../../tomverse-cli/src/runtime.js";
import {
  CODE_PROJECT_LIMIT, CODE_PROJECT_NAME_MAX, codeProjectLocation, codeProjectPermission,
  type CodeProject, type CodeProjectFailure, type CodeProjectLocation, type CodeProjectPermission,
} from "../code-project-contract";
import { bindProjectRoot } from "./project-root";

/**
 * The register of Code projects, one file per signed-in account in the app's own data folder. The renderer never names a
 * path: every folder here came from a dialog of the main process (or from the history of a folder this account already
 * opened), and is bound to the folder's canonical path before it is saved.
 */

export type CodeProjectFile = {
  version: 1;
  /** The folders this account opened before the register existed were moved in once. */
  migratedHistory: boolean;
  projects: CodeProject[];
};

export const emptyCodeProjectFile = (): CodeProjectFile => ({ version: 1, migratedHistory: false, projects: [] });

export const codeProjectFile = (profile: string, accountId: string | null) =>
  join(profile, "code-projects", sha256(JSON.stringify(["code-projects", accountId ?? "fixture"])).slice(0, 40) + ".json");

const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** A damaged or hand-edited file keeps whatever still reads as a project and loses the rest. */
export function readCodeProjects(file: string): CodeProjectFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { migratedHistory?: unknown; projects?: unknown };
    const projects: CodeProject[] = [];
    if (Array.isArray(parsed.projects)) {
      for (const item of parsed.projects.slice(0, CODE_PROJECT_LIMIT)) {
        const raw = item as Record<string, unknown>;
        const id = typeof raw.id === "string" && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : null;
        const name = typeof raw.name === "string" ? raw.name.trim().slice(0, CODE_PROJECT_NAME_MAX) : "";
        const folder = typeof raw.folder === "string" ? raw.folder : "";
        if (!id || !name || !isAbsolute(folder) || folder.length > 1_000 || projects.some((known) => known.id === id || same(known.folder, folder))) continue;
        const location = codeProjectLocation.safeParse(raw.defaultLocation);
        const permission = codeProjectPermission.safeParse(raw.permissionMode);
        projects.push({
          id, name, folder, favorite: raw.favorite === true, createdAt: timestamp(raw.createdAt) ?? 0, lastUsedAt: timestamp(raw.lastUsedAt),
          defaultLocation: location.success ? location.data : "local", permissionMode: permission.success ? permission.data : null,
          worktree: typeof raw.worktree === "boolean" ? raw.worktree : null,
        });
      }
    }
    return { version: 1, migratedHistory: parsed.migratedHistory === true, projects };
  } catch {
    return emptyCodeProjectFile();
  }
}

export function writeCodeProjects(file: string, data: CodeProjectFile) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...data, projects: data.projects.slice(0, CODE_PROJECT_LIMIT) }), { mode: 0o600 });
  renameSync(temporary, file);
}

/** The folder as the app will bind it, or why it cannot be a project. Only a local, existing, absolute folder passes. */
export function canonicalProjectFolder(path: string): { ok: true; folder: string } | { ok: false; failure: CodeProjectFailure } {
  if (typeof path !== "string" || !path || path.length > 1_000 || !isAbsolute(path) ||
      (process.platform === "win32" && /^[\\/]{2}/.test(path))) return { ok: false, failure: "bad-folder" };
  try {
    const bound = bindProjectRoot(path);
    if (!statSync(bound.path).isDirectory()) return { ok: false, failure: "bad-folder" };
    return { ok: true, folder: bound.path };
  } catch {
    return { ok: false, failure: existsSync(path) ? "bad-folder" : "missing-folder" };
  }
}

export const defaultProjectName = (folder: string) => (basename(folder) || folder).slice(0, CODE_PROJECT_NAME_MAX);

export function addProject(data: CodeProjectFile, input: { folder: string; name?: string }, now: number, id: string):
  { ok: true; project: CodeProject; created: boolean } | { ok: false; failure: CodeProjectFailure } {
  const known = data.projects.find((project) => same(project.folder, input.folder));
  if (known) return { ok: true, project: known, created: false };
  if (data.projects.length >= CODE_PROJECT_LIMIT) return { ok: false, failure: "too-many" };
  const project: CodeProject = {
    id, name: (input.name ?? defaultProjectName(input.folder)).trim().slice(0, CODE_PROJECT_NAME_MAX) || defaultProjectName(input.folder),
    folder: input.folder, favorite: false, createdAt: now, lastUsedAt: null, defaultLocation: "local", permissionMode: null, worktree: null,
  };
  data.projects.push(project);
  return { ok: true, project, created: true };
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A new folder's name is one name: no separators, no dots-only, nothing Windows would rename or refuse. */
export function validFolderName(name: string) {
  if (typeof name !== "string" || name !== name.trim() || !name || name.length > CODE_PROJECT_NAME_MAX) return false;
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || name === "." || name === ".." || /[. ]$/.test(name) || RESERVED.test(name)) return false;
  return true;
}

/** `parent/name`, only when it is directly inside the parent the person chose. */
export function newFolderIn(parent: string, name: string): { ok: true; folder: string } | { ok: false; failure: CodeProjectFailure } {
  if (!validFolderName(name)) return { ok: false, failure: "invalid-name" };
  const base = canonicalProjectFolder(parent);
  if (!base.ok) return base;
  const folder = join(base.folder, name);
  const inside = relative(base.folder, folder);
  if (inside !== name || inside.includes(sep) || isAbsolute(inside)) return { ok: false, failure: "outside-parent" };
  return { ok: true, folder };
}

function runGit(folder: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    execFile("git", args, { cwd: folder, timeout: 20_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error) => resolve(!error));
  });
}

/** Makes the folder inside the parent (it must not exist) and, when asked, a Git repository in it. */
export async function createProjectFolder(parent: string, name: string, initGit: boolean):
  Promise<{ ok: true; folder: string; gitInit?: "done" | "failed" } | { ok: false; failure: CodeProjectFailure }> {
  const target = newFolderIn(parent, name);
  if (!target.ok) return target;
  try {
    mkdirSync(target.folder, { mode: 0o755 });
  } catch (error) {
    return { ok: false, failure: (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed" };
  }
  const bound = canonicalProjectFolder(target.folder);
  if (!bound.ok) return bound;
  if (!initGit) return { ok: true, folder: bound.folder };
  return { ok: true, folder: bound.folder, gitInit: (await runGit(bound.folder, ["init"])) ? "done" : "failed" };
}

/**
 * The folders this account already opened, from the history Code kept for them (one folder per saved conversation).
 * A history folder counts only when the account's own namespace for that folder is the folder the history sits in, so a
 * history that belongs to another account, another key or a worktree is never read as this account's project.
 */
export function foldersFromHistory(profile: string, scopeHomes: (folder: string) => string[], limit = 40): string[] {
  const codeHome = join(profile, "code");
  const found: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(codeHome).slice(0, 2_000); } catch { return found; }
  for (const name of names) {
    let sessions: ReturnType<typeof listSessions> = [];
    try { sessions = listSessions(join(codeHome, name)); } catch { continue; }
    for (const { root, readable } of sessions) {
      if (!readable || !root || !isAbsolute(root) || found.some((folder) => same(folder, root))) continue;
      const folder = canonicalProjectFolder(root);
      if (!folder.ok || !scopeHomes(folder.folder).some((home) => basename(home) === name)) continue;
      found.push(folder.folder);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

export function updateProject(data: CodeProjectFile, id: string, change: Partial<Pick<CodeProject, "name" | "favorite" | "folder" | "lastUsedAt" | "worktree">> &
  { defaultLocation?: CodeProjectLocation; permissionMode?: CodeProjectPermission | null }): CodeProject | null {
  const project = data.projects.find((item) => item.id === id);
  if (!project) return null;
  Object.assign(project, change);
  return project;
}
