"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { ProjectSummary } from "@tomverse/api-client";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import {
    DEFAULT_PROJECT_CREATE_FORM,
    PROJECT_UI_LIMITS,
    announceProjectChanged,
    buildProjectCreateInput,
    projectNameValid,
    type ProjectCreateForm,
} from "@/lib/projectWorkspaceUi";
import { ErrorLine, projectUi, useCopy } from "./projectUi";

/**
 * Creating a workspace. Context is on by default and the choice is stated
 * plainly: a project with context off is a folder, a project with context on
 * answers with its own materials, memories and related chats.
 */
export function ProjectCreateScreen({
    initialName = "",
    onCreated,
    onCancel,
}: {
    initialName?: string;
    onCreated: (project: ProjectSummary) => void;
    onCancel: () => void;
}) {
    const { t } = useCopy();
    const [form, setForm] = useState<ProjectCreateForm>({ ...DEFAULT_PROJECT_CREATE_FORM, name: initialName.slice(0, PROJECT_UI_LIMITS.maxNameLength) });
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<unknown>(null);
    const set = <K extends keyof ProjectCreateForm>(key: K, value: ProjectCreateForm[K]) => setForm((current) => ({ ...current, [key]: value }));

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy || !projectNameValid(form.name)) return;
        setBusy(true);
        setFailure(null);
        try {
            const project = await webProjectWorkspaceClient().create(buildProjectCreateInput(form));
            announceProjectChanged();
            onCreated(project);
        } catch (error) {
            setFailure(error);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div data-testid="project-create" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <form onSubmit={(event) => void submit(event)} className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4 md:py-6">
                <header className="flex items-center gap-3">
                    <button type="button" onClick={onCancel} className={projectUi.button} aria-label={t("projectWorkspace.back")} data-testid="project-create-cancel">
                        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <h1 className="text-xl font-bold md:text-2xl">{t("projectWorkspace.create.title")}</h1>
                </header>
                <p className="text-sm text-zinc-700 dark:text-zinc-300">{t("projectWorkspace.create.intro")}</p>

                <div>
                    <label className={projectUi.label} htmlFor="project-create-name">{t("projectWorkspace.settings.name")}</label>
                    <input id="project-create-name" autoFocus value={form.name} maxLength={PROJECT_UI_LIMITS.maxNameLength} onChange={(event) => set("name", event.target.value)} className={projectUi.input} data-testid="project-create-name" />
                </div>
                <div>
                    <label className={projectUi.label} htmlFor="project-create-description">{t("projectWorkspace.settings.description")}</label>
                    <textarea id="project-create-description" rows={3} value={form.description} maxLength={PROJECT_UI_LIMITS.maxDescriptionLength} onChange={(event) => set("description", event.target.value)} className={`${projectUi.input} resize-y`} />
                </div>
                <div>
                    <label className={projectUi.label} htmlFor="project-create-instructions">{t("projectWorkspace.settings.instructions")}</label>
                    <textarea id="project-create-instructions" rows={5} value={form.instructions} maxLength={PROJECT_UI_LIMITS.maxInstructionsLength} onChange={(event) => set("instructions", event.target.value)} className={`${projectUi.input} resize-y`} />
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t("projectWorkspace.settings.instructionsHint")}</p>
                </div>

                <fieldset className={`${projectUi.card} space-y-3`}>
                    <legend className="px-1 text-sm font-bold">{t("projectWorkspace.settings.contextLegend")}</legend>
                    <label className="flex min-h-11 items-start gap-3 text-sm">
                        <input type="checkbox" checked={form.contextEnabled} onChange={(event) => set("contextEnabled", event.target.checked)} className="mt-1 h-5 w-5" data-testid="project-create-context" />
                        <span>
                            <span className="block font-semibold">{t("projectWorkspace.settings.contextEnabled")}</span>
                            <span className={projectUi.muted} data-testid="project-create-context-hint">{t(form.contextEnabled ? "projectWorkspace.create.contextOnHint" : "projectWorkspace.create.contextOffHint")}</span>
                        </span>
                    </label>
                    <label className="flex min-h-11 items-start gap-3 text-sm">
                        <input type="checkbox" checked={form.includePersonalMemory} disabled={!form.contextEnabled} onChange={(event) => set("includePersonalMemory", event.target.checked)} className="mt-1 h-5 w-5" data-testid="project-create-personal" />
                        <span>
                            <span className="block font-semibold">{t("projectWorkspace.settings.personalMemory")}</span>
                            <span className={projectUi.muted}>{t("projectWorkspace.settings.personalMemoryHint")}</span>
                        </span>
                    </label>
                    <label className="flex min-h-11 items-start gap-3 text-sm">
                        <input type="checkbox" checked={form.autoMemoryEnabled} disabled={!form.contextEnabled} onChange={(event) => set("autoMemoryEnabled", event.target.checked)} className="mt-1 h-5 w-5" data-testid="project-create-auto-memory" />
                        <span>
                            <span className="block font-semibold">{t("projectWorkspace.settings.autoMemory")}</span>
                            <span className={projectUi.muted}>{t("projectWorkspace.settings.autoMemoryHint")}</span>
                        </span>
                    </label>
                </fieldset>

                {failure ? <ErrorLine error={failure} testId="project-create-error" /> : null}
                <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={onCancel} className={projectUi.button}>{t("projectWorkspace.cancel")}</button>
                    <button type="submit" disabled={busy || !projectNameValid(form.name)} className={projectUi.primary} data-testid="project-create-submit">
                        {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                        {t("projectWorkspace.create.submit")}
                    </button>
                </div>
            </form>
        </div>
    );
}
