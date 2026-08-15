"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bot, Loader2, Plus } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * /settings/assistants — the profile list (Release C, slice C3b).
 *
 * docs/policy/external-conversation-import-and-memory.md §14, §21.
 *
 * Availability is resolved by the API rather than guessed here: the list
 * endpoint is the probe, and a 403 with `ASSISTANT_PROFILES_DISABLED` is what
 * turns this into the disabled notice. That is the same split
 * `/settings/memory` uses, and it matters for the same reason — a page that
 * decided for itself would need a second copy of the flag rule.
 *
 * A profile with no published version is shown as a draft rather than as
 * revision 0. It cannot start a conversation, and saying so is more useful
 * than a number a reader has to interpret.
 */

const interpolate = (
    template: string,
    values: Record<string, string | number>
) =>
    Object.entries(values).reduce(
        (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
        template
    );

const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";

const primaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";

type ProfileSummary = {
    id: string;
    name: string;
    icon: string | null;
    description: string | null;
    published: boolean;
    currentRevision: number | null;
    versionCount: number;
    knowledgeFileCount: number;
};

type ListState =
    | { status: "loading" }
    | { status: "disabled" }
    | { status: "error" }
    | {
          status: "ready";
          profiles: ProfileSummary[];
          maxProfilesPerAccount: number;
      };

export function AssistantProfileList() {
    const { t } = useLanguage();
    const [state, setState] = useState<ListState>({ status: "loading" });

    const load = useCallback(async () => {
        try {
            const response = await fetch("/api/assistant-profiles", {
                cache: "no-store",
            });
            if (response.status === 403) {
                await discardResponseBody(response);
                setState({ status: "disabled" });
                return;
            }
            if (!response.ok) {
                await discardResponseBody(response);
                setState({ status: "error" });
                return;
            }
            const data = (await response.json()) as {
                profiles: ProfileSummary[];
                limits: { maxProfilesPerAccount: number };
            };
            setState({
                status: "ready",
                profiles: data.profiles,
                maxProfilesPerAccount: data.limits.maxProfilesPerAccount,
            });
        } catch {
            setState({ status: "error" });
        }
    }, []);

    useEffect(() => {
        // Deferred, as the other settings screens defer their loads: a state
        // update reachable synchronously from an effect is what
        // `react-hooks/set-state-in-effect` refuses, and the fetch has nothing
        // to gain from starting one tick earlier.
        queueMicrotask(() => {
            void load();
        });
    }, [load]);

    const atCapacity =
        state.status === "ready" &&
        state.profiles.length >= state.maxProfilesPerAccount;

    return (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
            <SettingsDetailNav
                section="assistants"
                currentLabel={t("assistantProfiles.pageTitle")}
                backTestId="assistants-back-to-settings"
            />

            <header className="mt-4">
                <h1 className="text-2xl font-black">
                    {t("assistantProfiles.pageTitle")}
                </h1>
                <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                    {t("assistantProfiles.pageDescription")}
                </p>
            </header>

            {state.status === "loading" && (
                <p
                    className="mt-6 flex items-center gap-2 text-sm text-zinc-500"
                    data-testid="assistants-loading"
                >
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t("assistantProfiles.loading")}
                </p>
            )}

            {state.status === "disabled" && (
                <p
                    className={`mt-6 ${sectionClass} text-sm text-zinc-600 dark:text-zinc-400`}
                    data-testid="assistants-disabled"
                >
                    {t("assistantProfiles.disabled")}
                </p>
            )}

            {state.status === "error" && (
                <p
                    className={`mt-6 ${sectionClass} flex items-start gap-2 text-sm text-red-600 dark:text-red-400`}
                    data-testid="assistants-error"
                >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    {t("assistantProfiles.loadFailed")}
                </p>
            )}

            {state.status === "ready" && (
                <>
                    <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm text-zinc-600 dark:text-zinc-400">
                            {interpolate(t("assistantProfiles.countSummary"), {
                                count: state.profiles.length,
                                max: state.maxProfilesPerAccount,
                            })}
                        </p>
                        {atCapacity ? (
                            <p
                                className="text-sm font-semibold text-amber-600 dark:text-amber-400"
                                data-testid="assistants-at-capacity"
                            >
                                {t("assistantProfiles.atCapacity")}
                            </p>
                        ) : (
                            <Link
                                href="/settings/assistants/new"
                                className={primaryButtonClass}
                                data-testid="assistants-create"
                            >
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                {t("assistantProfiles.create")}
                            </Link>
                        )}
                    </div>

                    {state.profiles.length === 0 ? (
                        <p
                            className={`mt-4 ${sectionClass} text-sm text-zinc-600 dark:text-zinc-400`}
                            data-testid="assistants-empty"
                        >
                            {t("assistantProfiles.empty")}
                        </p>
                    ) : (
                        <ul className="mt-4 flex flex-col gap-3" data-testid="assistants-list">
                            {state.profiles.map((profile) => (
                                <li key={profile.id}>
                                    <Link
                                        href={`/settings/assistants/${profile.id}`}
                                        className={`${sectionClass} flex items-start gap-3 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-900`}
                                        data-testid={`assistant-profile-${profile.id}`}
                                    >
                                        <span
                                            aria-hidden="true"
                                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-200 text-lg dark:border-zinc-800"
                                        >
                                            {profile.icon || <Bot className="h-5 w-5" />}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-base font-bold">
                                                {profile.name}
                                            </span>
                                            {profile.description && (
                                                <span className="mt-1 block text-sm text-zinc-600 dark:text-zinc-400">
                                                    {profile.description}
                                                </span>
                                            )}
                                            <span className="mt-2 block text-xs font-semibold text-zinc-500">
                                                {profile.published
                                                    ? interpolate(
                                                          t("assistantProfiles.publishedStatus"),
                                                          {
                                                              revision:
                                                                  profile.currentRevision ?? 0,
                                                              files: profile.knowledgeFileCount,
                                                          }
                                                      )
                                                    : t("assistantProfiles.draftStatus")}
                                            </span>
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}
