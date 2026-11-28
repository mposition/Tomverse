import { z } from "zod";

/**
 * Code projects: the folders this person registered on this computer, and the environment picker built from them.
 *
 * This is a local register of the Desktop app, kept per account. It is NOT the web Chat "project" (a bundle of
 * conversations and materials, project-contract.ts): nothing here is sent to the server, and the two are not linked.
 * The renderer names an action and its typed arguments; the main process owns the folder dialogs, the register file
 * and every path check, so no path ever comes from the renderer.
 */

export const CODE_PROJECT_LIMIT = 100;
export const CODE_PROJECT_NAME_MAX = 80;

export const codeProjectId = z.uuid();
/** Where a project's tasks run by default. SSH names a remote folder, so it is chosen from the SSH list, not stored here yet. */
export const codeProjectLocation = z.enum(["local", "ssh", "cloud"]);
export type CodeProjectLocation = z.infer<typeof codeProjectLocation>;
/** The permission mode a project starts its conversations with. Allow all is never remembered (permission-host.ts). */
export const codeProjectPermission = z.enum(["read_only", "ask", "auto_review"]);
export type CodeProjectPermission = z.infer<typeof codeProjectPermission>;

const projectName = z.string().trim().min(1).max(CODE_PROJECT_NAME_MAX);

export type CodeProject = {
  id: string;
  name: string;
  /** An absolute folder of this computer, bound when the project was added. */
  folder: string;
  favorite: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  defaultLocation: CodeProjectLocation;
  /** The mode the person last picked in this project; null starts with the app's current mode. */
  permissionMode: CodeProjectPermission | null;
  /** The Worktree box as the person last left it in this project; null follows the default (on for a Git project). */
  worktree: boolean | null;
};

export const codeProjectInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add-existing") }).strict(),
  /** The folder is made inside the parent the person picks next; the name is one folder name, never a path. */
  z.object({ action: z.literal("create-new"), name: projectName, initGit: z.boolean() }).strict(),
  z.object({ action: z.literal("select"), id: codeProjectId }).strict(),
  z.object({ action: z.literal("rename"), id: codeProjectId, name: projectName }).strict(),
  z.object({ action: z.literal("favorite"), id: codeProjectId, favorite: z.boolean() }).strict(),
  z.object({ action: z.literal("set-location"), id: codeProjectId, location: codeProjectLocation }).strict(),
  z.object({ action: z.literal("set-worktree"), id: codeProjectId, worktree: z.boolean() }).strict(),
  /** Opens the folder dialog again for a project whose folder moved. */
  z.object({ action: z.literal("relocate"), id: codeProjectId }).strict(),
  /** Removes the registration only. The folder and its files are never touched. */
  z.object({ action: z.literal("remove"), id: codeProjectId }).strict(),
  z.object({ action: z.literal("wsl") }).strict(),
]);
export type CodeProjectInput = z.infer<typeof codeProjectInput>;

export const CODE_PROJECT_FAILURES = [
  "busy", "cancelled", "invalid-name", "exists", "not-found", "missing-folder", "bad-folder", "outside-parent", "too-many", "failed", "signed-out",
] as const;
export type CodeProjectFailure = (typeof CODE_PROJECT_FAILURES)[number];

export type CodeProjectResult =
  | { ok: true; id?: string; /** Another project is open now than before (false: the same one was chosen again, and what hangs on it stays). */ changed?: boolean;
      /** The new folder was made, and whether `git init` ran. */ gitInit?: "done" | "failed" }
  | { ok: false; failure: CodeProjectFailure };

/** What the WSL submenu knows. Only Windows can have distributions. */
export type CodeWslState = { state: "unsupported" } | { state: "unavailable" } | { state: "ready"; distributions: string[] };
export type CodeProjectReply = { result: CodeProjectResult; wsl?: CodeWslState };

/** What the snapshot carries: the register of the signed-in account and the project that is open now. */
export type CodeProjectsView = { items: CodeProject[]; selectedId: string | null; platform: string };

/** `wsl.exe -l -q` writes UTF-16 LE (with a byte-order mark) and, depending on the build, plain text. Reads both. */
export function parseWslList(output: Uint8Array | string): string[] {
  let text: string;
  if (typeof output === "string") text = output;
  else if (output.length >= 2 && output[0] === 0xff && output[1] === 0xfe) text = new TextDecoder("utf-16le").decode(output.subarray(2));
  else if (output.length >= 2 && output[1] === 0 && output[0] !== 0) text = new TextDecoder("utf-16le").decode(output);
  else text = new TextDecoder("utf-8").decode(output);
  const names: string[] = [];
  for (const line of text.replace(/﻿/g, "").split(/\r?\n/)) {
    const name = line.replace(/[\u0000-\u001f]/g, "").trim();
    if (name && name.length <= 100 && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 20);
}

/** The most recently used first, favourites above all, then by name. Stable for equal keys. */
export function sortCodeProjects(projects: readonly CodeProject[]): CodeProject[] {
  return [...projects].sort((a, b) =>
    Number(b.favorite) - Number(a.favorite) ||
    (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
    a.id.localeCompare(b.id));
}

/** Why an environment row cannot be chosen. The renderer owns the sentence for each code. */
export type EnvironmentDisabledReason =
  | "cloud-not-offered" | "cloud-no-project" | "cloud-remote-project" | "cloud-not-git"
  | "wsl-not-windows" | "wsl-unavailable" | "wsl-no-support" | "ssh-off";

export type EnvironmentRow =
  | { kind: "project"; id: string; project: CodeProject; selected: boolean }
  | { kind: "cloud"; id: "auto" | "default"; disabled?: EnvironmentDisabledReason }
  | { kind: "wsl"; id: string; disabled: EnvironmentDisabledReason }
  | { kind: "ssh"; id: string; label: string; destination: string; port?: number; folder: string; disabled?: EnvironmentDisabledReason };

export type EnvironmentGroups = {
  local: Extract<EnvironmentRow, { kind: "project" }>[];
  cloud: Extract<EnvironmentRow, { kind: "cloud" }>[];
  /** null: the WSL group is not shown (not Windows). */
  wsl: { rows: Extract<EnvironmentRow, { kind: "wsl" }>[]; disabled: EnvironmentDisabledReason } | null;
  ssh: Extract<EnvironmentRow, { kind: "ssh" }>[];
};

export type EnvironmentInput = {
  platform: string;
  projects: readonly CodeProject[];
  selectedId: string | null;
  query: string;
  /** The server's `desktopCloudExecution` capability. */
  cloudOffered: boolean;
  /** The selected project is a folder of this computer, and whether it is a Git repository (null: not known). */
  selectedIsGit: boolean | null;
  /** The open project is on another machine (SSH). */
  remoteOpen: boolean;
  wsl: CodeWslState | null;
  remoteEnabled: boolean;
  remoteRecent: readonly { destination: string; port?: number; folder: string }[];
  /** Names shown for the two cloud rows and used by the search; the group titles are matched too. */
  names: { cloudAuto: string; cloudDefault: string; local: string; cloud: string; wsl: string; ssh: string };
};

const matches = (query: string, ...values: string[]) => !query || values.some((value) => value.toLowerCase().includes(query));

/**
 * The picker's groups. Rows that cannot be used stay in the list with the reason, so the person sees why. Cloud means
 * something only for a Git repository of this computer; WSL is Windows-only and Code does not run inside a WSL
 * distribution yet, so its rows are listed and switched off.
 */
export function buildEnvironmentGroups(input: EnvironmentInput): EnvironmentGroups {
  const query = input.query.trim().toLowerCase();
  const local = sortCodeProjects(input.projects)
    .filter((project) => matches(query, project.name, project.folder))
    .map((project) => ({ kind: "project" as const, id: project.id, project, selected: project.id === input.selectedId }));

  const cloudReason: EnvironmentDisabledReason | undefined = !input.cloudOffered ? "cloud-not-offered"
    : input.remoteOpen ? "cloud-remote-project"
    : !input.selectedId ? "cloud-no-project"
    : input.selectedIsGit === false ? "cloud-not-git" : undefined;
  const cloud = ([["auto", input.names.cloudAuto], ["default", input.names.cloudDefault]] as const)
    .filter(([, name]) => matches(query, name, input.names.cloud))
    .map(([id]) => ({ kind: "cloud" as const, id, ...(cloudReason ? { disabled: cloudReason } : {}) }));

  let wsl: EnvironmentGroups["wsl"] = null;
  if (input.platform === "win32") {
    const reason: EnvironmentDisabledReason = input.wsl?.state === "unavailable" ? "wsl-unavailable" : "wsl-no-support";
    const names = input.wsl?.state === "ready" ? input.wsl.distributions : [];
    wsl = { disabled: reason, rows: names.filter((name) => matches(query, name, input.names.wsl))
      .map((name) => ({ kind: "wsl" as const, id: name, disabled: "wsl-no-support" as const })) };
  }

  const ssh = input.remoteEnabled
    ? input.remoteRecent
      .filter((target) => matches(query, target.destination, target.folder, input.names.ssh))
      .map((target) => ({ kind: "ssh" as const, id: `${target.destination}|${target.port ?? ""}|${target.folder}`, label: target.destination,
        destination: target.destination, ...(target.port !== undefined ? { port: target.port } : {}), folder: target.folder }))
    : [];
  return { local, cloud, wsl, ssh };
}

/** The rows in the order the keyboard walks them: Local, Cloud, WSL, SSH. Disabled rows are skipped. */
export function pickerOrder(groups: EnvironmentGroups): EnvironmentRow[] {
  return [...groups.local, ...groups.cloud, ...(groups.wsl?.rows ?? []), ...groups.ssh].filter((row) => !("disabled" in row && row.disabled));
}
