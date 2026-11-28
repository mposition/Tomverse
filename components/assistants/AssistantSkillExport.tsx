"use client";

import { Download } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";

/**
 * The `SKILL.md` download on an assistant's edit page.
 *
 * docs/policy/assistant-package-import.md §6.6.
 *
 * A plain link to a read-only route, so there is no request state to manage
 * here. The route enforces the two flags and ownership; the edit page decides
 * only whether to offer it.
 */
export function AssistantSkillExport({
    profileId,
    className,
    buttonClassName,
}: {
    profileId: string;
    className: string;
    buttonClassName: string;
}) {
    const { t } = useLanguage();
    return (
        <section className={className} data-testid="assistant-skill-export">
            <h2 className="text-lg font-bold">
                {t("assistantProfiles.skillExportHeading")}
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                {t("assistantProfiles.skillExportHint")}
            </p>
            <a
                href={`/api/assistant-profiles/${encodeURIComponent(profileId)}/skill`}
                download="SKILL.md"
                className={`mt-3 ${buttonClassName}`}
                data-testid="assistant-skill-export-download"
            >
                <Download className="h-4 w-4" aria-hidden="true" />
                {t("assistantProfiles.skillExportAction")}
            </a>
        </section>
    );
}
