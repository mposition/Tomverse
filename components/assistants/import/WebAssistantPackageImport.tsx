"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, type ReactNode } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import { webImportRequests } from "@/lib/assistantPackageImportClient";
import type {
    ImportMergeTarget,
    ResumableImport,
} from "@/lib/assistantPackageImportWizard";
import {
    trackProductEvent,
    trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import {
    ASSISTANT_PROFILE_LIST_PATH,
    assistantProfileHierarchy,
} from "@/lib/settingsNavigation";

import {
    AssistantPackageImportWizard,
    type AssistantPackageImportHost,
} from "./AssistantPackageImportWizard";

/**
 * The package import wizard as /settings/assistants/import runs it.
 *
 * The wizard itself takes everything app-specific through its `host`. This
 * file is the web's half of that: the settings navigation, the link to the
 * list, the product analytics, and the routes the run's requests go to. It is
 * the only place the wizard meets `next/*`, which is what lets the Desktop app
 * run the same component without a router.
 */

function WebDoneLink({
    children,
    ...props
}: {
    className: string;
    "data-testid": string;
    children: ReactNode;
}) {
    return (
        <Link href={ASSISTANT_PROFILE_LIST_PATH} {...props}>
            {children}
        </Link>
    );
}

export function WebAssistantPackageImport({
    mergeTargets,
    resumable,
}: {
    mergeTargets: readonly ImportMergeTarget[];
    resumable: readonly ResumableImport[];
}) {
    const { t } = useLanguage();
    const router = useRouter();
    const host = useMemo<AssistantPackageImportHost>(
        () => ({
            requests: webImportRequests,
            track: trackProductEvent,
            trackOnce: trackProductEventOnce,
            header: (
                <SettingsDetailNav
                    hierarchy={assistantProfileHierarchy()}
                    currentLabel={t("assistantPackageImport.title")}
                    backTestId="assistant-package-import-back"
                />
            ),
            DoneLink: WebDoneLink,
            refresh: () => router.refresh(),
        }),
        [router, t]
    );
    return (
        <AssistantPackageImportWizard
            mergeTargets={mergeTargets}
            resumable={resumable}
            host={host}
        />
    );
}
