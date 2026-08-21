"use client";

import { useEffect, useState } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";

/**
 * The preference centre.
 *
 * Contract: .github/audits/email-notification-architecture-2026-08-21.md §11.2.
 *
 * Three decisions are worth stating, because each looks like an omission:
 *
 *  - **Locked rows are shown, not hidden.** Security alerts and billing
 *    receipts cannot be switched off, and saying so is the point. "There is no
 *    setting for it" is a common reason people reach for the spam button, and a
 *    complaint costs the sending domain far more than the honest sentence does.
 *  - **The country sits with the toggles.** Marketing needs a confirmed
 *    jurisdiction before it will send, so a screen that offered the switches
 *    without it would let somebody turn something on and then quietly receive
 *    nothing (§6.3 rule 2).
 *  - **No confirmation dialog on switching something off.** Making a person
 *    argue with a modal about leaving is the friction the Australian rules
 *    exist to prevent, and it does not change the outcome -- it changes which
 *    button they press to achieve it.
 */

type Preference = {
    purpose: string;
    enabled: boolean;
    locked: boolean;
};

type CountryState = {
    selfDeclared: string | null;
    resolved: string;
    confidence: "high" | "conflict" | "low" | "unknown";
    conflicts: string[];
    needsConfirmation: boolean;
};

type PreferenceState = { preferences: Preference[]; country: CountryState };

const MARKETING_PURPOSES = new Set(["product_updates", "newsletter", "promotions"]);

export function EmailNotificationSettings() {
    const { t } = useLanguage();
    const [state, setState] = useState<PreferenceState | null>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "saving" | "failed">(
        "loading"
    );
    const [country, setCountry] = useState("");

    // The fetch is what the effect synchronises with; state is set from its
    // callback rather than in the effect body, which is both what the React 19
    // rule asks for and what AnalyticsProvider already does here. The abort and
    // the flag together stop a response that arrives after unmount from setting
    // state on a component that is gone.
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        fetch("/api/user/email-preferences", {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) {
                    await response.text().catch(() => "");
                    throw new Error("Email preferences unavailable");
                }
                return (await response.json()) as PreferenceState;
            })
            .then((body) => {
                if (cancelled) return;
                setState(body);
                setCountry(body.country.selfDeclared ?? "");
                setStatus("ready");
            })
            .catch((error: unknown) => {
                if (
                    cancelled ||
                    (error instanceof DOMException && error.name === "AbortError")
                ) {
                    return;
                }
                setStatus("failed");
            });

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, []);

    const save = async (body: Record<string, unknown>) => {
        setStatus("saving");
        try {
            const response = await fetch("/api/user/email-preferences", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                await response.text().catch(() => "");
                setStatus("failed");
                return;
            }
            // The saved state read back from the server, never the request
            // echoed: a screen built from what was asked for would show a
            // change a constraint refused.
            const next = (await response.json()) as PreferenceState;
            setState(next);
            setCountry(next.country.selfDeclared ?? "");
            setStatus("ready");
        } catch {
            setStatus("failed");
        }
    };

    const busy = status === "loading" || status === "saving";

    return (
        <div className="mx-auto w-full max-w-2xl px-6 py-10">
            <SettingsDetailNav
                section="email-notifications"
                currentLabel={t("emailNotifications.dataTabTitle")}
                backTestId="email-notifications-back"
            />

            <h1 className="mt-6 text-2xl font-black">
                {t("emailNotifications.title")}
            </h1>
            <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                {t("emailNotifications.description")}
            </p>

            {status === "failed" && !state ? (
                <p className="mt-8 text-sm text-zinc-600 dark:text-zinc-300">
                    {t("emailNotifications.loadFailed")}
                </p>
            ) : null}

            {state ? (
                <>
                    {state.country.needsConfirmation ? (
                        <section
                            className="mt-8 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40"
                            data-testid="email-country-confirmation"
                        >
                            <h2 className="text-sm font-bold">
                                {t("emailNotifications.countryNeededTitle")}
                            </h2>
                            <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                                {state.country.confidence === "conflict"
                                    ? t("emailNotifications.countryConflictBody").replace(
                                          "{countries}",
                                          state.country.conflicts.join(", ")
                                      )
                                    : t("emailNotifications.countryNeededBody")}
                            </p>
                        </section>
                    ) : null}

                    <ul className="mt-8 divide-y divide-zinc-200 dark:divide-zinc-800">
                        {state.preferences.map((preference) => (
                            <li
                                key={preference.purpose}
                                className="flex items-start justify-between gap-6 py-4"
                                data-testid={`email-preference-${preference.purpose}`}
                            >
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold">
                                        {t(`emailNotifications.purpose.${preference.purpose}.title`)}
                                    </p>
                                    <p className="mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                                        {t(
                                            `emailNotifications.purpose.${preference.purpose}.description`
                                        )}
                                    </p>
                                    {preference.locked ? (
                                        <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                                            {t("emailNotifications.lockedNote")}
                                        </p>
                                    ) : null}
                                    {!preference.locked &&
                                    MARKETING_PURPOSES.has(preference.purpose) &&
                                    state.country.needsConfirmation ? (
                                        <p className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-500">
                                            {t("emailNotifications.needsCountryNote")}
                                        </p>
                                    ) : null}
                                </div>

                                {preference.locked ? (
                                    <span
                                        className="shrink-0 rounded-full bg-zinc-200 px-3 py-1 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                                        data-testid={`email-preference-${preference.purpose}-locked`}
                                    >
                                        {t("emailNotifications.alwaysOn")}
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={preference.enabled}
                                        aria-label={t(
                                            `emailNotifications.purpose.${preference.purpose}.title`
                                        )}
                                        disabled={busy}
                                        onClick={() =>
                                            save({
                                                purpose: preference.purpose,
                                                enabled: !preference.enabled,
                                            })
                                        }
                                        data-testid={`email-preference-${preference.purpose}-toggle`}
                                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                                            preference.enabled
                                                ? "bg-zinc-900 dark:bg-white"
                                                : "bg-zinc-300 dark:bg-zinc-700"
                                        }`}
                                    >
                                        <span
                                            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform dark:bg-zinc-950 ${
                                                preference.enabled
                                                    ? "translate-x-[22px]"
                                                    : "translate-x-0.5"
                                            }`}
                                        />
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>

                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => save({ withdrawAllMarketing: true })}
                        data-testid="email-withdraw-all"
                        className="mt-6 w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm font-semibold transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                        {t("emailNotifications.withdrawAll")}
                    </button>

                    <section className="mt-10 border-t border-zinc-200 pt-6 dark:border-zinc-800">
                        <label
                            htmlFor="email-country"
                            className="text-sm font-semibold"
                        >
                            {t("emailNotifications.countryLabel")}
                        </label>
                        <p
                            id="email-country-description"
                            className="mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400"
                        >
                            {t("emailNotifications.countryDescription")}
                        </p>
                        <div className="mt-3 flex gap-2">
                            <input
                                id="email-country"
                                value={country}
                                aria-describedby="email-country-description"
                                onChange={(event) =>
                                    setCountry(
                                        event.target.value
                                            .replace(/[^a-zA-Z]/g, "")
                                            .slice(0, 2)
                                            .toUpperCase()
                                    )
                                }
                                placeholder="KR"
                                className="w-24 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-center font-mono text-sm uppercase dark:border-zinc-700 dark:bg-zinc-950"
                            />
                            <button
                                type="button"
                                disabled={busy || country.length !== 2}
                                onClick={() => save({ country })}
                                data-testid="email-country-save"
                                className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-zinc-950"
                            >
                                {t("emailNotifications.countrySave")}
                            </button>
                        </div>
                    </section>
                </>
            ) : null}
        </div>
    );
}
