/**
 * Where the Project workspace lives in the URL.
 *
 * The workspace is a pane of the Chat page, not a route of its own, so its
 * state is carried as query parameters on the Chat path (the same convention
 * the page already uses for `conversation`). A reload or Back restores it.
 *
 * A project id in the URL is a request, never an authority: every read the
 * pane makes is re-checked by the server against the signed-in owner.
 */

export const PROJECT_WORKSPACE_PARAM = "project";
export const PROJECT_WORKSPACE_TAB_PARAM = "projectTab";
/** `?project=new` opens the create screen. A real id can never be this value. */
export const PROJECT_WORKSPACE_NEW = "new";

export const PROJECT_WORKSPACE_TABS = ["overview", "conversations", "materials", "memories", "settings"] as const;
export type ProjectWorkspaceTab = (typeof PROJECT_WORKSPACE_TABS)[number];

export type ProjectWorkspaceRoute =
    | { kind: "project"; projectId: string; tab: ProjectWorkspaceTab }
    | { kind: "new" };

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export const isProjectWorkspaceTab = (value: unknown): value is ProjectWorkspaceTab =>
    typeof value === "string" && (PROJECT_WORKSPACE_TABS as readonly string[]).includes(value);

/** Reads the workspace route out of a query string; anything malformed is "no workspace". */
export function parseProjectWorkspaceRoute(search: string | URLSearchParams): ProjectWorkspaceRoute | null {
    const params = typeof search === "string" ? new URLSearchParams(search) : search;
    const project = params.get(PROJECT_WORKSPACE_PARAM);
    if (!project) return null;
    if (project === PROJECT_WORKSPACE_NEW) return { kind: "new" };
    if (!PROJECT_ID_PATTERN.test(project)) return null;
    const tab = params.get(PROJECT_WORKSPACE_TAB_PARAM);
    return { kind: "project", projectId: project, tab: isProjectWorkspaceTab(tab) ? tab : "overview" };
}

/**
 * The query string for a route, keeping every unrelated parameter (language,
 * conversation, billing return) exactly as it was. `null` closes the pane.
 */
export function projectWorkspaceSearch(route: ProjectWorkspaceRoute | null, currentSearch: string | URLSearchParams = ""): string {
    const params = new URLSearchParams(typeof currentSearch === "string" ? currentSearch : currentSearch.toString());
    params.delete(PROJECT_WORKSPACE_PARAM);
    params.delete(PROJECT_WORKSPACE_TAB_PARAM);
    if (route?.kind === "new") {
        params.set(PROJECT_WORKSPACE_PARAM, PROJECT_WORKSPACE_NEW);
    } else if (route?.kind === "project") {
        params.set(PROJECT_WORKSPACE_PARAM, route.projectId);
        if (route.tab !== "overview") params.set(PROJECT_WORKSPACE_TAB_PARAM, route.tab);
    }
    const query = params.toString();
    return query ? `?${query}` : "";
}

export const sameProjectWorkspaceRoute = (a: ProjectWorkspaceRoute | null, b: ProjectWorkspaceRoute | null) => {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind) return false;
    return a.kind === "new" || (b.kind === "project" && a.projectId === b.projectId && a.tab === b.tab);
};
