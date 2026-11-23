"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import {
    PROJECT_UI_LIMITS,
    deleteProjectAfterConfirmation,
    isRevisionConflict,
    loadProjectDeletionPlan,
    projectNameValid,
    projectSettingsPatch,
    saveProjectSettings,
    settingsDraftFromProject,
    type ProjectDeletionPlan,
    type ProjectSettingsDraft,
} from "@/lib/projectWorkspaceUi";
import { ConfirmDialog, ErrorLine, projectUi, useCopy } from "./projectUi";
import type { ProjectTabProps } from "./ProjectWorkspaceScreen";

export function ProjectSettingsTab(props: ProjectTabProps & { onDeleted: () => void }) {
    // Keyed on the revision: after any save (here or from another tab) the form
    // starts again from what the server now holds.
    return <SettingsForm key={`${props.project.id}:${props.project.revision}`} {...props} />;
}

function SettingsForm({ project, archived, onProjectChanged, onDeleted }: ProjectTabProps & { onDeleted: () => void }) {
    const { t, tf } = useCopy();
    const client = webProjectWorkspaceClient();
    const [draft, setDraft] = useState<ProjectSettingsDraft>(() => settingsDraftFromProject(project));
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [failure, setFailure] = useState<unknown>(null);
    const [archiveBusy, setArchiveBusy] = useState(false);
    const [archiveError, setArchiveError] = useState<unknown>(null);

    const patch = projectSettingsPatch(project, draft);
    const update = <K extends keyof ProjectSettingsDraft>(key: K, value: ProjectSettingsDraft[K]) => {
        setDraft((current) => ({ ...current, [key]: value }));
        setSaved(false);
    };

    const save = async (event: FormEvent) => {
        event.preventDefault();
        if (!patch || saving || !projectNameValid(draft.name)) return;
        setSaving(true);
        setFailure(null);
        try {
            await saveProjectSettings(client, project, patch);
            setSaved(true);
            onProjectChanged();
        } catch (error) {
            setFailure(error);
        } finally {
            setSaving(false);
        }
    };

    const setArchived = async (next: boolean) => {
        setArchiveBusy(true);
        setArchiveError(null);
        try {
            await client.update(project.id, project.revision, { archived: next });
            onProjectChanged();
        } catch (error) {
            setArchiveError(error);
        } finally {
            setArchiveBusy(false);
        }
    };

    // ----- delete
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [plan, setPlan] = useState<ProjectDeletionPlan | null>(null);
    const [planError, setPlanError] = useState<unknown>(null);
    const [stale, setStale] = useState(false);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [deleteError, setDeleteError] = useState<unknown>(null);

    const openDelete = async () => {
        setDeleteOpen(true);
        setPlan(null);
        setPlanError(null);
        setStale(false);
        setDeleteError(null);
        try {
            setPlan(await loadProjectDeletionPlan(client, project.id));
        } catch (error) {
            setPlanError(error);
        }
    };

    const confirmDelete = async () => {
        if (!plan) return;
        setDeleteBusy(true);
        setDeleteError(null);
        try {
            const outcome = await deleteProjectAfterConfirmation(client, project.id, plan);
            if (outcome.status === "stale") {
                // Show what changed and ask again; the old confirmation is not reused.
                setPlan(outcome.plan);
                setStale(true);
                return;
            }
            setDeleteOpen(false);
            onDeleted();
        } catch (error) {
            setDeleteError(error);
        } finally {
            setDeleteBusy(false);
        }
    };

    const memoryOptionsDisabled = !draft.contextEnabled;

    return (
        <div className="space-y-6" data-testid="project-settings">
            <form onSubmit={(event) => void save(event)} className={`${projectUi.card} space-y-4`} data-testid="project-settings-form">
                <div>
                    <label className={projectUi.label} htmlFor="project-setting-name">{t("projectWorkspace.settings.name")}</label>
                    <input id="project-setting-name" value={draft.name} maxLength={PROJECT_UI_LIMITS.maxNameLength} onChange={(event) => update("name", event.target.value)} className={projectUi.input} aria-invalid={!projectNameValid(draft.name)} />
                </div>
                <div>
                    <label className={projectUi.label} htmlFor="project-setting-description">{t("projectWorkspace.settings.description")}</label>
                    <textarea id="project-setting-description" rows={3} value={draft.description} maxLength={PROJECT_UI_LIMITS.maxDescriptionLength} onChange={(event) => update("description", event.target.value)} className={`${projectUi.input} resize-y`} />
                </div>
                <div>
                    <label className={projectUi.label} htmlFor="project-setting-instructions">{t("projectWorkspace.settings.instructions")}</label>
                    <textarea id="project-setting-instructions" rows={6} value={draft.instructions} maxLength={PROJECT_UI_LIMITS.maxInstructionsLength} onChange={(event) => update("instructions", event.target.value)} className={`${projectUi.input} resize-y`} disabled={!draft.contextEnabled && !draft.instructions} />
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t("projectWorkspace.settings.instructionsHint")}</p>
                </div>

                <fieldset className="space-y-3">
                    <legend className="text-sm font-bold">{t("projectWorkspace.settings.contextLegend")}</legend>
                    <label className="flex min-h-11 items-start gap-3 text-sm">
                        <input type="checkbox" checked={draft.contextEnabled} onChange={(event) => update("contextEnabled", event.target.checked)} className="mt-1 h-5 w-5" data-testid="project-setting-context" />
                        <span>
                            <span className="block font-semibold">{t("projectWorkspace.settings.contextEnabled")}</span>
                            <span className={projectUi.muted}>{t(draft.contextEnabled ? "projectWorkspace.settings.contextOnHint" : "projectWorkspace.settings.contextOffHint")}</span>
                        </span>
                    </label>
                    <label className="flex min-h-11 items-start gap-3 text-sm">
                        <input type="checkbox" checked={draft.includePersonalMemory} disabled={memoryOptionsDisabled} onChange={(event) => update("includePersonalMemory", event.target.checked)} className="mt-1 h-5 w-5" data-testid="project-setting-personal" />
                        <span>
                            <span className="block font-semibold">{t("projectWorkspace.settings.personalMemory")}</span>
                            <span className={projectUi.muted}>{t("projectWorkspace.settings.personalMemoryHint")}</span>
                        </span>
                    </label>
                    <label className="flex min-h-11 items-start gap-3 text-sm">
                        <input type="checkbox" checked={draft.autoMemoryEnabled} disabled={memoryOptionsDisabled} onChange={(event) => update("autoMemoryEnabled", event.target.checked)} className="mt-1 h-5 w-5" data-testid="project-setting-auto-memory" />
                        <span>
                            <span className="block font-semibold">{t("projectWorkspace.settings.autoMemory")}</span>
                            <span className={projectUi.muted} data-testid="project-setting-auto-memory-hint">{t("projectWorkspace.settings.autoMemoryHint")}</span>
                        </span>
                    </label>
                </fieldset>

                <div className="flex flex-wrap items-center gap-3">
                    <button type="submit" disabled={!patch || saving || !projectNameValid(draft.name)} className={projectUi.primary} data-testid="project-settings-save">
                        {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                        {t("projectWorkspace.saveButton")}
                    </button>
                    {patch && !saving && <span className={projectUi.muted}>{t("projectWorkspace.settings.unsaved")}</span>}
                    {saved && !patch && <span role="status" className="text-sm font-semibold text-blue-700 dark:text-blue-300" data-testid="project-settings-saved">{t("projectWorkspace.settings.saved")}</span>}
                </div>
                {failure ? (
                    <div className="space-y-2" data-testid="project-settings-failure">
                        <ErrorLine error={failure} />
                        {isRevisionConflict(failure) && (
                            <button type="button" className={projectUi.button} onClick={onProjectChanged} data-testid="project-settings-reload">
                                {t("projectWorkspace.settings.reloadLatest")}
                            </button>
                        )}
                    </div>
                ) : null}
            </form>

            <section className={`${projectUi.card} space-y-3`} data-testid="project-archive">
                <h3 className="text-base font-bold">{t(archived ? "projectWorkspace.settings.restoreTitle" : "projectWorkspace.settings.archiveTitle")}</h3>
                <p className={projectUi.muted}>{t(archived ? "projectWorkspace.settings.restoreBody" : "projectWorkspace.settings.archiveBody")}</p>
                <button type="button" disabled={archiveBusy} onClick={() => void setArchived(!archived)} className={projectUi.button} data-testid="project-archive-toggle">
                    {archiveBusy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    {t(archived ? "projectWorkspace.settings.restore" : "projectWorkspace.settings.archive")}
                </button>
                {archiveError ? <ErrorLine error={archiveError} /> : null}
            </section>

            <section className={`${projectUi.card} space-y-3 border-red-200 dark:border-red-900`} data-testid="project-delete-section">
                <h3 className="text-base font-bold text-red-700 dark:text-red-300">{t("projectWorkspace.delete.title")}</h3>
                <p className={projectUi.muted}>{t("projectWorkspace.delete.intro")}</p>
                <button type="button" onClick={() => void openDelete()} className={projectUi.danger} data-testid="project-delete-open">{t("projectWorkspace.delete.open")}</button>
            </section>

            <ConfirmDialog
                open={deleteOpen}
                title={tf("projectWorkspace.delete.dialogTitle", { name: project.name })}
                confirmLabel={t("projectWorkspace.delete.confirm")}
                cancelLabel={t("projectWorkspace.cancel")}
                destructive
                busy={deleteBusy}
                confirmDisabled={!plan}
                error={planError ?? deleteError}
                onCancel={() => setDeleteOpen(false)}
                onConfirm={() => void confirmDelete()}
                testId="project-delete-dialog"
            >
                {!plan && !planError && <p role="status">{t("projectWorkspace.loading")}</p>}
                {stale && <p role="alert" data-testid="project-delete-stale" className="font-semibold text-amber-800 dark:text-amber-200">{t("projectWorkspace.delete.stale")}</p>}
                {plan && (
                    <ul className="list-disc space-y-1 pl-5" data-testid="project-delete-summary" data-revision={plan.summary.revision}>
                        <li>{tf("projectWorkspace.delete.conversations", { count: plan.summary.conversations })}</li>
                        <li className="font-semibold text-red-700 dark:text-red-300">{tf("projectWorkspace.delete.materials", { count: plan.summary.materials })}</li>
                        <li className="font-semibold text-red-700 dark:text-red-300">{tf("projectWorkspace.delete.memories", { count: plan.summary.memories })}</li>
                    </ul>
                )}
                {plan && <p className={projectUi.muted}>{t("projectWorkspace.delete.irreversible")}</p>}
            </ConfirmDialog>
        </div>
    );
}
