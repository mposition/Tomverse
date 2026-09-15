"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import { MARKETING_ALLOWED_COUNTRY_CODES } from "@/lib/emailJurisdictionCore";

/**
 * The preference centre.
 *
 * Contract: docs/policy/email-notifications.md §11.2.
 *
 * Three decisions are worth stating, because each looks like an omission:
 *
 *  - **Locked rows are shown, not hidden.** Security alerts and billing
 *    receipts cannot be switched off, and saying so is the point. "There is no
 *    setting for it" is a common reason people reach for the spam button, and a
 *    complaint costs the sending domain far more than the honest sentence does.
 *  - **Country confirmation and opt-in are one action.** Marketing needs a
 *    confirmed jurisdiction before it will send. The API stores the country
 *    and the consent record in the same transaction, so the interface cannot
 *    show an enabled switch whose legal profile was never captured.
 *  - **Switching marketing on sends a confirmation mail, not a consent.** The
 *    switch stays off and the row says a confirmation is waiting, with a way to
 *    send it again (docs/policy/email-double-opt-in.md §11 item 11). Showing it
 *    as on would tell somebody they are subscribed before they are.
 *  - **No confirmation dialog on switching something off.** Making a person
 *    argue with a modal about leaving is the friction the Australian rules
 *    exist to prevent, and it does not change the outcome -- it changes which
 *    button they press to achieve it.
 */

type Preference = {
    purpose: string;
    enabled: boolean;
    locked: boolean;
    /** Double opt-in state for marketing purposes; null for the rest. */
    confirmation?: "off" | "pending" | "on" | "unconfirmed" | null;
    /** ISO instant; present while a confirmation is pending. */
    confirmationExpiresAt?: string | null;
};

type CountryState = {
    selfDeclared: string | null;
    resolved: string;
    confidence: "high" | "conflict" | "low" | "unknown";
    conflicts: string[];
    needsConfirmation: boolean;
    marketingSupported: boolean;
};

type PreferenceState = { preferences: Preference[]; country: CountryState };

type SaveError =
    | "COUNTRY_REQUIRED"
    | "COUNTRY_CONFLICT"
    | "COUNTRY_UNSUPPORTED"
    | "CONFIRMATION_UNAVAILABLE"
    | "SAVE_FAILED";

const MARKETING_PURPOSES = new Set([
    "product_updates",
    "newsletter",
    "promotions",
]);
const SUPPORTED_COUNTRIES = new Set<string>(MARKETING_ALLOWED_COUNTRY_CODES);

const isExpired = (expiresAt: string | null | undefined) => {
    if (!expiresAt) return false;
    const at = Date.parse(expiresAt);
    return Number.isFinite(at) && at <= Date.now();
};

const countryValueFrom = (next: PreferenceState) => {
    if (next.country.selfDeclared) return next.country.selfDeclared;
    if (
        next.country.confidence === "high" &&
        next.country.resolved !== "ZZ"
    ) {
        // A billing country is high-confidence and useful as a proposed value,
        // but it is not silently persisted. Pressing the opt-in button is the
        // affirmative confirmation that turns it into a declaration.
        return next.country.resolved;
    }
    return "";
};

export function EmailNotificationSettings() {
    const { lang, t } = useLanguage();
    const [state, setState] = useState<PreferenceState | null>(null);
    const [status, setStatus] = useState<
        "loading" | "ready" | "saving" | "failed"
    >("loading");
    const [country, setCountry] = useState("");
    const [saveError, setSaveError] = useState<SaveError | null>(null);
    const countryRef = useRef<HTMLSelectElement>(null);

    const countryOptions = useMemo(() => {
        const displayNames = new Intl.DisplayNames([lang], { type: "region" });
        return MARKETING_ALLOWED_COUNTRY_CODES.map((code) => ({
            code,
            name: displayNames.of(code) ?? code,
        })).sort((left, right) => left.name.localeCompare(right.name, lang));
    }, [lang]);

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
                setCountry(countryValueFrom(body));
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
        setSaveError(null);
        setStatus("saving");
        try {
            const response = await fetch("/api/user/email-preferences", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const errorBody = (await response.json().catch(() => null)) as {
                    code?: string;
                } | null;
                const code = errorBody?.code;
                setSaveError(
                    code === "COUNTRY_REQUIRED" ||
                        code === "COUNTRY_CONFLICT" ||
                        code === "COUNTRY_UNSUPPORTED" ||
                        code === "CONFIRMATION_UNAVAILABLE"
                        ? code
                        : "SAVE_FAILED"
                );
                setStatus("failed");
                return false;
            }
            // The saved state read back from the server, never the request
            // echoed: a screen built from what was asked for would show a
            // change a constraint refused.
            const next = (await response.json()) as PreferenceState;
            setState(next);
            setCountry(countryValueFrom(next));
            setStatus("ready");
            return true;
        } catch {
            setSaveError("SAVE_FAILED");
            setStatus("failed");
            return false;
        }
    };

    const enableMarketing = (purpose: string) => {
        if (!country) {
            setSaveError("COUNTRY_REQUIRED");
            countryRef.current?.focus();
            return;
        }
        void save({ purpose, enabled: true, country });
    };

    const togglePreference = (preference: Preference) => {
        if (
            MARKETING_PURPOSES.has(preference.purpose) &&
            !preference.enabled
        ) {
            enableMarketing(preference.purpose);
            return;
        }
        void save({
            purpose: preference.purpose,
            enabled: !preference.enabled,
        });
    };

    const busy = status === "loading" || status === "saving";
    const productUpdates = state?.preferences.find(
        (preference) => preference.purpose === "product_updates"
    );
    const hasMarketingEnabled = state?.preferences.some(
        (preference) =>
            MARKETING_PURPOSES.has(preference.purpose) && preference.enabled
    );
    const savedCountryIsUnsupported =
        Boolean(country) && !SUPPORTED_COUNTRIES.has(country);
    // A country we know -- declared or from billing -- that marketing does not
    // reach. Told apart from "no country yet" so the screen never suggests that
    // confirming a country would make marketing arrive where it cannot.
    const countryIsUnsupported = Boolean(
        state &&
            !state.country.marketingSupported &&
            (state.country.selfDeclared ||
                (state.country.confidence === "high" &&
                    state.country.resolved !== "ZZ"))
    );

    const errorMessage = saveError
        ? t(`emailNotifications.error.${saveError}`)
        : null;

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
                    <section className="mt-8 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
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
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                            <select
                                ref={countryRef}
                                id="email-country"
                                value={country}
                                aria-describedby="email-country-description email-country-error"
                                aria-invalid={
                                    saveError === "COUNTRY_REQUIRED" ||
                                    saveError === "COUNTRY_CONFLICT" ||
                                    saveError === "COUNTRY_UNSUPPORTED"
                                }
                                onChange={(event) => {
                                    setCountry(event.target.value);
                                    setSaveError(null);
                                }}
                                data-testid="email-country-select"
                                className="min-h-11 min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                            >
                                <option value="">
                                    {t("emailNotifications.countryPlaceholder")}
                                </option>
                                {savedCountryIsUnsupported ? (
                                    <option value={country}>{country}</option>
                                ) : null}
                                {countryOptions.map((option) => (
                                    <option key={option.code} value={option.code}>
                                        {option.name} ({option.code})
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                disabled={busy || !country}
                                onClick={() => void save({ country })}
                                data-testid="email-country-save"
                                className="min-h-11 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                            >
                                {t("emailNotifications.countrySave")}
                            </button>
                        </div>
                        <p
                            id="email-country-error"
                            className="mt-2 min-h-5 text-sm text-red-600 dark:text-red-400"
                            aria-live="polite"
                        >
                            {errorMessage}
                        </p>
                    </section>

                    {state.country.needsConfirmation ? (
                        <section
                            className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40"
                            data-testid="email-country-confirmation"
                        >
                            <h2 className="text-sm font-bold">
                                {t("emailNotifications.countryNeededTitle")}
                            </h2>
                            <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                                {countryIsUnsupported
                                    ? t("emailNotifications.countryUnsupportedBody")
                                    : state.country.confidence === "conflict"
                                      ? t(
                                            "emailNotifications.countryConflictBody"
                                        ).replace(
                                            "{countries}",
                                            state.country.conflicts.join(", ")
                                        )
                                      : t("emailNotifications.countryNeededBody")}
                            </p>
                        </section>
                    ) : null}

                    {/* Not offered where it cannot be granted: the server would
                        refuse it, and a button next to "not available for your
                        country" contradicts it. Confirming a different country
                        above brings it back. */}
                    {productUpdates &&
                    !productUpdates.enabled &&
                    productUpdates.confirmation !== "pending" &&
                    !countryIsUnsupported ? (
                        <section className="mt-6 rounded-2xl border border-blue-200 bg-blue-50 p-5 dark:border-blue-900 dark:bg-blue-950/30">
                            <p className="text-xs font-bold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-300">
                                {t("emailNotifications.marketingOptional")}
                            </p>
                            <h2 className="mt-2 text-lg font-black">
                                {t("emailNotifications.marketingCalloutTitle")}
                            </h2>
                            <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                                {t("emailNotifications.marketingCalloutBody")}
                            </p>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => enableMarketing("product_updates")}
                                data-testid="email-product-updates-opt-in"
                                className="mt-4 min-h-11 w-full rounded-xl bg-blue-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-blue-600 disabled:opacity-50 sm:w-auto"
                            >
                                {t("emailNotifications.marketingCalloutAction")}
                            </button>
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
                                        {t(
                                            `emailNotifications.purpose.${preference.purpose}.title`
                                        )}
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
                                        <p
                                            className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-500"
                                            data-testid={`email-preference-${preference.purpose}-country-note`}
                                        >
                                            {countryIsUnsupported
                                                ? t(
                                                      "emailNotifications.countryUnsupportedNote"
                                                  )
                                                : t(
                                                      "emailNotifications.needsCountryNote"
                                                  )}
                                        </p>
                                    ) : null}
                                    {preference.confirmation === "pending" ||
                                    preference.confirmation === "unconfirmed" ? (
                                        <div
                                            className="mt-2"
                                            data-testid={`email-preference-${preference.purpose}-confirmation`}
                                        >
                                            <p
                                                className="text-xs leading-5 text-amber-700 dark:text-amber-500"
                                                aria-live="polite"
                                            >
                                                {preference.confirmation ===
                                                "unconfirmed"
                                                    ? t(
                                                          "emailNotifications.confirmationUnconfirmedNote"
                                                      )
                                                    : isExpired(
                                                            preference.confirmationExpiresAt
                                                        )
                                                      ? t(
                                                            "emailNotifications.confirmationExpiredNote"
                                                        )
                                                      : t(
                                                            "emailNotifications.confirmationPendingNote"
                                                        )}
                                            </p>
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() =>
                                                    enableMarketing(
                                                        preference.purpose
                                                    )
                                                }
                                                data-testid={`email-preference-${preference.purpose}-resend`}
                                                className="mt-1 min-h-11 text-xs font-semibold text-zinc-700 underline underline-offset-2 hover:text-zinc-950 disabled:opacity-50 dark:text-zinc-300 dark:hover:text-white"
                                            >
                                                {preference.confirmation ===
                                                "unconfirmed"
                                                    ? t(
                                                          "emailNotifications.confirmationSend"
                                                      )
                                                    : t(
                                                          "emailNotifications.confirmationResend"
                                                      )}
                                            </button>
                                            {preference.confirmation === "pending" ? (
                                                // Invalidates the link already
                                                // mailed; the switch cannot, because
                                                // it is off and pressing it asks for
                                                // another confirmation.
                                                <button
                                                    type="button"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        void save({
                                                            purpose: preference.purpose,
                                                            enabled: false,
                                                        })
                                                    }
                                                    data-testid={`email-preference-${preference.purpose}-cancel`}
                                                    className="ml-4 mt-1 min-h-11 text-xs font-semibold text-zinc-500 underline underline-offset-2 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-white"
                                                >
                                                    {t(
                                                        "emailNotifications.confirmationCancel"
                                                    )}
                                                </button>
                                            ) : null}
                                        </div>
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
                                        // Switching marketing on is unavailable
                                        // for a country outside the allowlist;
                                        // switching it off never is.
                                        disabled={
                                            busy ||
                                            (countryIsUnsupported &&
                                                MARKETING_PURPOSES.has(
                                                    preference.purpose
                                                ) &&
                                                !preference.enabled)
                                        }
                                        onClick={() =>
                                            togglePreference(preference)
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

                    {hasMarketingEnabled ? (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                                void save({ withdrawAllMarketing: true })
                            }
                            data-testid="email-withdraw-all"
                            className="mt-6 w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm font-semibold transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                        >
                            {t("emailNotifications.withdrawAll")}
                        </button>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
