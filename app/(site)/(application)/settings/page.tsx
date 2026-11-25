import { AuthButton } from "@/components/auth/AuthButton";
import {
    parseSettingsDeepLink,
    settingsReturnProductFrom,
    SETTINGS_DESKTOP_QUERY_PARAM,
    SETTINGS_PRODUCT_QUERY_PARAM,
    SETTINGS_SECTION_QUERY_PARAM,
    SETTINGS_TAB_QUERY_PARAM,
    type SettingsDeepLink,
} from "@/lib/settingsNavigation";

export default async function SettingsPage({ searchParams }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const query = await searchParams;
    const params = new URLSearchParams();
    for (const key of [SETTINGS_PRODUCT_QUERY_PARAM, SETTINGS_TAB_QUERY_PARAM, SETTINGS_SECTION_QUERY_PARAM]) {
        const value = query[key];
        if (typeof value === "string") params.set(key, value);
    }
    const product = settingsReturnProductFrom(params.get(SETTINGS_PRODUCT_QUERY_PARAM));
    const selection: SettingsDeepLink = parseSettingsDeepLink(params.toString()) ?? { tab: "account", section: null };
    const embedded = query[SETTINGS_DESKTOP_QUERY_PARAM] === "1";

    return (
        <main>
            <AuthButton
                key={`${product}:${selection.tab}:${selection.section ?? ""}:${embedded}`}
                settingsPage={{ ...selection, product, embedded }}
            />
        </main>
    );
}
