"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ProjectSearchHit, ProjectSummary } from "@tomverse/api-client";
import { projectContextActive } from "@tomverse/api-client";
import type { ProjectWorkspaceRoute } from "@/lib/projectWorkspaceRoute";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import { PROJECT_CHANGED_EVENT, toggleProjectReference } from "@/lib/projectWorkspaceUi";
import { useProjectResource } from "./projectUi";

/**
 * What the chat surface knows about "the project this conversation belongs to".
 *
 * The id comes from the server's own record of the open conversation (or from
 * the pending "new chat in project" choice), never from the URL. Everything
 * here is display and request-shaping; the server decides context on every
 * turn from the stored conversation.
 */
export type ProjectChatScopeValue = {
    /** False for guests and for surfaces without projects: consumers render nothing. */
    enabled: boolean;
    projectId: string | null;
    project: ProjectSummary | null;
    /** The project answers with its own context right now (context on, not archived). */
    contextActive: boolean;
    /** References that will ride on the next question (already scoped to `projectId`). */
    references: ProjectSearchHit[];
    toggleReference: (projectId: string, hit: ProjectSearchHit) => void;
    removeReference: (ref: string) => void;
    clearReferences: () => void;
    referencesFor: (projectId: string) => ProjectSearchHit[];
    openWorkspace: (route: ProjectWorkspaceRoute) => void;
};

const noop = () => undefined;

const DISABLED_SCOPE: ProjectChatScopeValue = {
    enabled: false,
    projectId: null,
    project: null,
    contextActive: false,
    references: [],
    toggleReference: noop,
    removeReference: noop,
    clearReferences: noop,
    referencesFor: () => [],
    openWorkspace: noop,
};

const ProjectChatScopeContext = createContext<ProjectChatScopeValue>(DISABLED_SCOPE);

export const ProjectChatScopeProvider = ProjectChatScopeContext.Provider;
export const useProjectChatScope = () => useContext(ProjectChatScopeContext);

type StoredReferences = { projectId: string | null; hits: ProjectSearchHit[] };

/**
 * The page-level state behind the context: the effective project's summary and
 * the references picked for the next question. References belong to one project
 * at a time; switching the composer to another project shows none of them.
 */
export function useProjectChatScopeState({
    enabled,
    projectId,
    openWorkspace,
}: {
    enabled: boolean;
    projectId: string | null;
    openWorkspace: (route: ProjectWorkspaceRoute) => void;
}) {
    const activeProjectId = enabled ? projectId : null;
    const detail = useProjectResource<ProjectSummary | null>(
        () => (activeProjectId ? webProjectWorkspaceClient().detail(activeProjectId) : Promise.resolve(null)),
        `chat-scope:${activeProjectId ?? "none"}`
    );
    const reload = detail.reload;
    useEffect(() => {
        if (!activeProjectId) return;
        const onChanged = () => void reload({ quiet: true });
        window.addEventListener(PROJECT_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(PROJECT_CHANGED_EVENT, onChanged);
    }, [activeProjectId, reload]);

    const [stored, setStored] = useState<StoredReferences>({ projectId: null, hits: [] });
    const toggleReference = useCallback((forProjectId: string, hit: ProjectSearchHit) => {
        setStored((current) => {
            const base = current.projectId === forProjectId ? current.hits : [];
            return { projectId: forProjectId, hits: toggleProjectReference(base, hit) };
        });
    }, []);
    const removeReference = useCallback((ref: string) => {
        setStored((current) => ({ ...current, hits: current.hits.filter((hit) => hit.ref !== ref) }));
    }, []);
    const clearReferences = useCallback(() => setStored({ projectId: null, hits: [] }), []);
    const referencesFor = useCallback(
        (forProjectId: string) => (stored.projectId === forProjectId ? stored.hits : []),
        [stored]
    );

    const project = detail.status === "ready" ? detail.data ?? null : null;
    const effectiveReferences = useMemo(
        () => (activeProjectId && stored.projectId === activeProjectId && projectContextActive(project) ? stored.hits : []),
        [activeProjectId, project, stored]
    );

    const value = useMemo<ProjectChatScopeValue>(
        () => ({
            enabled,
            projectId: activeProjectId,
            project,
            contextActive: projectContextActive(project),
            references: effectiveReferences,
            toggleReference,
            removeReference,
            clearReferences,
            referencesFor,
            openWorkspace,
        }),
        [activeProjectId, clearReferences, effectiveReferences, enabled, openWorkspace, project, referencesFor, removeReference, toggleReference]
    );
    return value;
}
