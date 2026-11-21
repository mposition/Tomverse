import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderWithLanguage } from "../support/renderWithLanguage.tsx";
import { DeveloperSettingsView } from "../../components/settings/DeveloperSettingsTab.tsx";
import { AllowedModels, ConnectSection, UsageRows } from "../../components/settings/ExternalApiSettings.tsx";
import { ACCOUNT_SETTINGS_TABS } from "../../lib/accountSettingsEvents.ts";
import { SETTINGS_SECTION_TAB, SETTINGS_TAB_LABEL_KEY, settingsSectionHref } from "../../lib/settingsNavigation.ts";
import { externalApiCopy } from "../../locales/externalApi.ts";
import type { Language } from "../../lib/language.ts";

/**
 * Settings > Developer and the API keys page, rendered (owner decision
 * 2026-11-21). Server-side markup only: it shows each state's first paint,
 * which is what the values below are read from. Run without the react-server
 * condition (client components).
 */

const render = (element: React.ReactElement, lang: Language = "ko") => renderWithLanguage(element, lang);

// The fixtures below are partial on purpose (only what each view reads), so they
// are passed untyped rather than restating every prop type here.
const element = (type: unknown, props: unknown) => React.createElement(type as never, props as never) as React.ReactElement;

// Markup puts an attribute's value in quotes and escapes `"`; compare as text.
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const model = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    provider: "x",
    tools: true,
    vision: false,
    reasoning: false,
    contextWindowTokens: 128000,
    maxOutputTokens: 8000,
    creditWeight: 1,
    protocols: ["chat_completions"],
    ...extra,
});
const smart = model("smart-adaptive", { name: "Smart Adaptive", provider: "tomverse" });
const luna = model("gpt-6-luna", { name: "GPT 6 Luna" });
const generalOnly = model("general-only", { name: "General Only" });
const codingOnly = model("coding-only", { name: "Coding Only" });
const GENERAL = "https://tomverse.app/api/v1";
const CODING = "https://tomverse.app/api/code/v1";

const ready = (extra: Record<string, unknown> = {}) => ({
    kind: "ready",
    baseUrl: GENERAL,
    codingBaseUrl: CODING,
    keys: [
        { state: "active", lastUsedAt: "2026-11-20T01:00:00.000Z" },
        { state: "active", lastUsedAt: null },
        { state: "revoked", lastUsedAt: "2026-11-21T01:00:00.000Z" },
    ],
    tomverseCli: { install: "npm install -g @tomverse/cli" },
    ...extra,
});

test("the Developer tab sits between data and plan, and names itself through the shared label key", () => {
    const tabs = [...ACCOUNT_SETTINGS_TABS];
    assert.deepEqual(tabs, ["account", "preferences", "assistants", "ai", "data", "developer", "plan"]);
    assert.equal(SETTINGS_TAB_LABEL_KEY.developer, "externalApi.developerTab");
    // The tab strip and the breadcrumb read one key, in every language.
    for (const [lang, copy] of Object.entries(externalApiCopy)) {
        assert.ok(copy.developerTab, `${lang} has no developer tab name`);
    }
    // The API keys section lives in this tab, and its back link opens it.
    assert.equal(SETTINGS_SECTION_TAB["api-keys"], "developer");
    assert.match(settingsSectionHref("api-keys"), /[?&]settings=developer(&|$)/);
});

test("the Account tab no longer has an API keys row; the panel renders the Developer tab", () => {
    const source = readFileSync(new URL("../../components/auth/AuthButton.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(source, /api-keys-entry/);
    assert.doesNotMatch(source, /settings-account-api-keys/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_EXTERNAL_API_SETTINGS_VISIBLE/);
    assert.match(source, /id: "developer"/);
    assert.match(source, /activeSettingsTab === "developer"/);
    const order = ["id: \"data\"", "id: \"developer\"", "id: \"plan\""].map((needle) => source.indexOf(needle));
    assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], "tab order is data, developer, plan");
});

test("a Pro account sees the key summary, all four addresses, the tool names and the CLI card", () => {
    const markup = render(element(DeveloperSettingsView, { overview: ready() }), "en");
    const body = text(markup);
    assert.match(body, /Use Tomverse models and credits in other apps and coding tools\. One key works with both APIs\./);
    assert.match(body, /2 keys in use/);
    assert.match(body, /Last used/);
    assert.match(markup, /data-testid="developer-manage-keys"/);
    assert.match(markup, /href="\/settings\/api"/);
    assert.match(markup, /id="settings-entry-api-keys"/);
    for (const address of [
        "https://tomverse.app/api/v1",
        "https://tomverse.app/api/anthropic",
        "https://tomverse.app/api/code/v1",
        "https://tomverse.app/api/code/anthropic",
    ]) {
        assert.ok(markup.includes(`>${address}</code>`), `${address} is shown`);
    }
    assert.equal((markup.match(/-copy"/g) ?? []).length, 4, "one copy button per address");
    assert.match(body, /Aside · Brave Leo · Raycast · BrowserOS · Other/);
    assert.match(body, /Tomverse CLI · Claude Code · Codex · Cursor · VS Code · JetBrains/);
    assert.match(markup, /href="\/settings\/api#connect"/);
    assert.match(markup, /href="\/settings\/api\?tool=tomverse-cli#connect"/);
    assert.ok(markup.includes("npm install -g @tomverse/cli &amp;&amp; tomverse doctor"));
    assert.match(body, /available on Pro and above\. Requests use the same account credits as Chat\./);
});

test("the Korean tab reads as designed", () => {
    const body = text(render(element(DeveloperSettingsView, { overview: ready({ keys: [] }) })));
    assert.match(body, /개발자/);
    assert.match(body, /다른 앱과 코딩 도구에서 Tomverse 모델과 크레딧을 씁니다\. 키 하나로 두 API를 모두 쓸 수 있습니다\./);
    assert.match(body, /사용 중인 키 없음/);
    assert.match(body, /도구별 설정 방법/);
    assert.match(body, /API와 CLI는 Pro 이상에서 쓸 수 있습니다\. 요청은 Chat과 같은 계정 크레딧을 씁니다\./);
});

test("the CLI card and banner stay hidden until the install guide is published", () => {
    const markup = render(element(DeveloperSettingsView, { overview: ready({ tomverseCli: null }) }), "en");
    assert.doesNotMatch(markup, /developer-cli/);
});

// The anchor tag of one link, so attribute order never matters.
const hrefOf = (markup: string, testId: string) => new RegExp(`<a[^>]*data-testid="${testId}"[^>]*>`).exec(markup)?.[0].match(/href="([^"]*)"/)?.[1] ?? null;

test("the CLI banner opens the tab and links to the install page in the current language", () => {
    const en = render(element(DeveloperSettingsView, { overview: ready() }), "en");
    assert.match(text(en), /Tomverse CLI — a coding agent in your terminal/);
    assert.match(text(en), /Installers for Windows, macOS and Linux, winget and npm./);
    assert.match(text(en), /See install instructions/);
    assert.equal(hrefOf(en, "developer-cli-banner-link"), "/en/developers/cli");
    // Above the key summary: the first thing in the tab.
    assert.ok(en.indexOf('data-testid="developer-cli-banner"') < en.indexOf('data-testid="developer-keys"'));

    const ko = render(element(DeveloperSettingsView, { overview: ready() }), "ko");
    assert.match(text(ko), /Tomverse CLI — 터미널의 코딩 에이전트/);
    assert.match(text(ko), /설치 안내 보기/);
    assert.equal(hrefOf(ko, "developer-cli-banner-link"), "/ko/developers/cli");
});

test("a Free account sees the Pro notice and an upgrade button, no keys and no addresses", () => {
    const markup = render(element(DeveloperSettingsView, { overview: { kind: "plan" } }), "en");
    assert.match(markup, /data-testid="developer-plan-required"/);
    assert.match(markup, /data-testid="developer-upgrade"/);
    assert.match(text(markup), /available on Pro and above/);
    assert.doesNotMatch(markup, /developer-keys|developer-endpoints/);
});

test("a signed-out visitor is asked to sign in", () => {
    const markup = render(element(DeveloperSettingsView, { overview: { kind: "signedOut" } }), "en");
    assert.match(markup, /data-testid="developer-signin"/);
    assert.doesNotMatch(markup, /developer-endpoints/);
});

const connect = (focusTool: string | null, extra: Record<string, unknown> = {}) =>
    render(
        element(ConnectSection, {
            baseUrl: GENERAL,
            models: [smart, luna, generalOnly],
            codingBaseUrl: CODING,
            codingModels: [codingOnly, luna],
            apiKey: null,
            tomverseCli: null,
            focusTool,
            ...extra,
        }),
        "en"
    );

test("the connect section starts on the General API tab with its two addresses and its tools", () => {
    const markup = connect(null);
    assert.equal(pressed(markup, "external-api-connect-api-general"), true);
    assert.equal(pressed(markup, "external-api-connect-api-coding"), false);
    assert.ok(markup.includes(">https://tomverse.app/api/v1</code>"));
    assert.ok(markup.includes(">https://tomverse.app/api/anthropic</code>"));
    for (const id of ["aside", "brave-leo", "raycast", "browseros", "other"]) {
        assert.match(markup, new RegExp(`external-api-platform-${id}"`));
    }
    for (const id of ["claude-code", "codex", "cursor", "vscode", "jetbrains"]) {
        assert.doesNotMatch(markup, new RegExp(`external-api-platform-${id}"`));
    }
});

test("opening a coding tool selects the Coding API tab with the coding addresses", () => {
    const markup = connect("jetbrains");
    assert.equal(pressed(markup, "external-api-connect-api-coding"), true);
    assert.equal(pressed(markup, "external-api-connect-api-general"), false);
    assert.ok(markup.includes(">https://tomverse.app/api/code/v1</code>"));
    assert.ok(markup.includes(">https://tomverse.app/api/code/anthropic</code>"));
    for (const id of ["claude-code", "codex", "cursor", "vscode", "jetbrains"]) {
        assert.match(markup, new RegExp(`external-api-platform-${id}"`));
    }
    assert.doesNotMatch(markup, /external-api-platform-aside"/);
    // The CLI choice needs its guide.
    assert.doesNotMatch(markup, /external-api-platform-tomverse-cli"/);
});

test("Brave Leo shows the full path, Raycast the /v1 base and a model list, JetBrains the coding URL", () => {
    const brave = text(connect("brave-leo"));
    assert.match(brave, /Server endpoint: https:\/\/tomverse\.app\/api\/v1\/chat\/completions/);
    assert.match(brave, /Model request name: smart-adaptive/);

    const raycast = text(connect("raycast", { apiKey: "tvk_example" }));
    assert.match(raycast, /base_url: https:\/\/tomverse\.app\/api\/v1 /);
    assert.doesNotMatch(raycast, /base_url: [^ ]*chat\/completions/);
    assert.match(raycast, /id: "smart-adaptive"/);
    assert.match(raycast, /tomverse: "tvk_example"/);
    assert.match(raycast, /top-level tools block/);

    const jetbrains = text(connect("jetbrains"));
    assert.match(jetbrains, /URL: https:\/\/tomverse\.app\/api\/code\/v1 API Key: <YOUR_TOMVERSE_API_KEY>/);
    assert.match(jetbrains, /Test Connection/);

    const browserOs = text(connect("browseros"));
    assert.match(browserOs, /Base URL: https:\/\/tomverse\.app\/api\/v1 Model ID: smart-adaptive/);
});

test("the CLI choice appears once the guide is published", () => {
    const markup = connect("tomverse-cli", {
        tomverseCli: { install: "npm install -g @tomverse/cli", powershell: "$env:TOMVERSE_API_KEY", posix: "export TOMVERSE_API_KEY" },
    });
    assert.match(markup, /external-api-platform-tomverse-cli"/);
    assert.match(markup, /data-testid="external-api-tool-tomverse-cli"/);
});

test("the CLI install picks an operating system, starts on Windows with winget, and links to the installers", () => {
    const markup = connect("tomverse-cli", {
        tomverseCli: {
            install: "npm install -g @tomverse/cli",
            installWindows: "winget install Tomverse.CLI",
            powershell: "$env:TOMVERSE_API_KEY",
            posix: "export TOMVERSE_API_KEY",
        },
    });
    // Windows, macOS and Linux; no operating system is read on the server, so Windows is the first paint.
    for (const os of ["windows", "macos", "linux"]) assert.match(markup, new RegExp(`data-testid="external-api-cli-os-${os}"`), os);
    assert.equal(pressed(markup, "external-api-cli-os-windows"), true);
    assert.equal(pressed(markup, "external-api-cli-os-macos"), false);
    const install = text(markup);
    assert.match(install, /winget install Tomverse\.CLI/);
    assert.doesNotMatch(install, /npm install -g @tomverse\/cli/);
    assert.match(markup, /data-testid="external-api-tomverse-cli-powershell"/);
    assert.doesNotMatch(markup, /data-testid="external-api-tomverse-cli-posix"/);
    assert.match(install, /Install it with an installer or with Node\.js 22\./);
    assert.match(install, /To install with an installer \(\.msi · \.pkg · \.deb · \.rpm\) or npm, see the install instructions by operating system/);
    assert.equal(hrefOf(markup, "external-api-cli-install-guide"), "/en/developers/cli#install");
});

// Each button's own tag, so attribute order never matters.
const pressed = (markup: string, testId: string) => new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(markup)?.[0].includes('aria-pressed="true"') ?? null;

const checked = (markup: string, id: string) =>
    new RegExp(`<input[^>]*data-testid="external-api-pick-${id}"[^>]*>`).exec(markup)?.[0].includes('checked=""') ?? null;

test("each API keeps its own model list: a ticked box and the copied file always agree", () => {
    // Coding models share nothing with the general selection by default: the
    // coding tab starts on its own first model, ticked, and VS Code carries it.
    const vscode = connect("vscode");
    assert.equal(checked(vscode, "coding-only"), true);
    assert.equal(checked(vscode, "gpt-6-luna"), false);
    assert.equal(checked(vscode, "smart-adaptive"), null, "a general model is not in the coding list");
    assert.match(text(vscode), /"id": "coding-only"/);
    assert.doesNotMatch(text(vscode), /"id": "smart-adaptive"/);

    // The general tab starts on Smart Adaptive, ticked, and Aside carries it.
    const aside = connect("aside");
    assert.equal(checked(aside, "smart-adaptive"), true);
    assert.equal(checked(aside, "gpt-6-luna"), false);
    assert.equal(checked(aside, "coding-only"), null);
    assert.match(text(aside), /"id": "smart-adaptive"/);
    assert.doesNotMatch(text(aside), /"id": "coding-only"/);

    // Without Smart Adaptive in a list, its first model is ticked.
    const noSmart = connect("aside", { models: [luna, generalOnly] });
    assert.equal(checked(noSmart, "gpt-6-luna"), true);
    assert.match(text(noSmart), /"id": "gpt-6-luna"/);
});

test("the allowed models split by API and mark a coding-only model", () => {
    const overview = {
        enabled: true,
        baseUrl: GENERAL,
        codingBaseUrl: CODING,
        limits: { maxKeys: 10, maxCreditCap: 1000, expiryDays: [30] },
        models: [smart, luna],
        codingModels: [codingOnly, luna],
        keys: [],
    };
    const general = render(element(AllowedModels, { overview }), "en");
    assert.match(general, /GPT 6 Luna/);
    assert.doesNotMatch(general, /Coding Only/);
    assert.doesNotMatch(general, /external-api-model-badge/);
    assert.match(text(general), /Aside · Brave Leo · Raycast · BrowserOS · Other/);

    const coding = render(element(AllowedModels, { overview, initialApi: "coding" }), "en");
    assert.match(coding, /Coding Only/);
    assert.equal((coding.match(/external-api-model-badge/g) ?? []).length, 1);
    assert.match(text(coding), /Coding only/);
    assert.match(text(coding), /Claude Code|VS Code · JetBrains/);
    assert.doesNotMatch(coding, /Smart Adaptive/);
});

test("recent requests carry an API column: coding, general, or a dash", () => {
    const row = (requestId: string, surface: string | null) => ({
        requestId,
        modelId: "gpt-6-luna",
        surface,
        createdAt: "2026-11-21T00:00:00.000Z",
        status: "settled",
        outcome: "completed",
        heldCredits: 0,
        chargedCredits: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        errorCode: null,
    });
    const markup = render(
        element(UsageRows, { rows: [row("req_c", "coding"), row("req_g", "general"), row("req_old", null)] })
    );
    const cells = [...markup.matchAll(/data-testid="external-api-usage-api">([^<]*(?:<!-- -->)?[^<]*(?:<!-- -->)?[^<]*)</g)].map((match) =>
        match[1].replace(/<!-- -->/g, "")
    );
    assert.deepEqual(cells, ["API: 코딩 API", "API: 일반 API", "API: —"]);
});
