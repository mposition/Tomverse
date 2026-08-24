// What the package import reports, and what it structurally cannot (Slice 7).
//
// docs/policy/assistant-package-import.md §9.
//
// Two things are pinned. That the analytics schema's step list is the wizard's
// step list -- they are written out separately on purpose, because pulling the
// wizard's module into the analytics one would drag the package adapter and a
// YAML parser onto every page. And that there is no key in the schema an
// instruction, a filename, a URL or a digest could travel in.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ASSISTANT_PACKAGE_IMPORT_STEPS } from "../lib/assistantPackageImportWizard.ts";
import {
    PACKAGE_IMPORT_SOURCES,
    PACKAGE_IMPORT_WARNING_KINDS,
    summarizePackageImportEvents,
} from "../lib/assistantPackageImportMetricsCore.ts";
import {
    PRODUCT_ANALYTICS_EVENT_NAMES,
    analyticsPropertiesSchema,
} from "../lib/productAnalyticsShared.ts";

const EVENTS = [
    "assistant_package_import_step_entered",
    "assistant_package_import_step_abandoned",
    "assistant_package_import_warning",
    "assistant_package_import_completed",
];

const MIGRATION = readFileSync(
    new URL(
        "../prisma/migrations/20260823140000_assistant_package_import_analytics_events/migration.sql",
        import.meta.url
    ),
    "utf8"
);

const WIZARD_SOURCE = readFileSync(
    new URL(
        "../components/assistants/import/AssistantPackageImportWizard.tsx",
        import.meta.url
    ),
    "utf8"
);

/* ------------------------------------------------------- the registrations */

test("the four events are registered and constrained", () => {
    for (const event of EVENTS) {
        assert.ok(
            PRODUCT_ANALYTICS_EVENT_NAMES.includes(event),
            `${event} is not a registered event name`
        );
        // A name the application sends and the database refuses is a 500 where
        // a 400 belongs, so the constraint has to have been recreated.
        assert.ok(MIGRATION.includes(`'${event}'`), `${event} is not in the constraint`);
    }
});

test("the analytics step list is the wizard's step list", () => {
    for (const step of ASSISTANT_PACKAGE_IMPORT_STEPS) {
        const parsed = analyticsPropertiesSchema.safeParse({
            package_import_step: step,
        });
        assert.equal(parsed.success, true, `${step} is not an accepted property value`);
    }
    // And nothing beyond it: a value the wizard cannot produce would be a
    // bucket on a dashboard that nothing in the code explains.
    assert.equal(
        analyticsPropertiesSchema.safeParse({ package_import_step: "publish" }).success,
        false
    );
});

test("the warning kinds the metrics count are the ones the schema accepts", () => {
    for (const kind of PACKAGE_IMPORT_WARNING_KINDS) {
        assert.equal(
            analyticsPropertiesSchema.safeParse({ package_import_warning: kind })
                .success,
            true,
            kind
        );
    }
    assert.equal(
        analyticsPropertiesSchema.safeParse({ package_import_warning: "something" })
            .success,
        false
    );
});

test("the source values are what the parser can read a package as", () => {
    for (const source of PACKAGE_IMPORT_SOURCES) {
        assert.equal(
            analyticsPropertiesSchema.safeParse({ package_import_source: source })
                .success,
            true,
            source
        );
    }
});

/* ------------------------------------------------------------ the boundary */

test("there is no property an instruction or a filename could travel in", () => {
    // The schema is strict, so this is a structural guarantee rather than a
    // convention: an event carrying content is refused, not trimmed.
    for (const forbidden of [
        { instructions: "Be brief." },
        { filename: "style.md" },
        { package_name: "code-reviewer" },
        { digest: "sha256:abc" },
        { url: "https://example.test" },
        { secret_match: "ghp_x" },
    ]) {
        assert.equal(
            analyticsPropertiesSchema.safeParse(forbidden).success,
            false,
            JSON.stringify(forbidden)
        );
    }
});

test("the wizard sends no count with any of its events", () => {
    // §9: a count is not content, but in a small population it is close to an
    // identifier. The events are sent with a model count of 0 and one closed
    // enum, and this reads the call sites to say so.
    const sent = new Set();
    for (const match of WIZARD_SOURCE.matchAll(
        /"(assistant_package_import_[a-z_]+)"/g
    )) {
        sent.add(match[1]);
        // The properties object follows the event name; a window past it is
        // enough to see what travels with it without parsing TypeScript.
        const window = WIZARD_SOURCE.slice(match.index, match.index + 300);
        const properties = window.slice(0, window.indexOf("});") + 1);
        assert.ok(
            !/\b(count|bytes|length|characters|size)\b/i.test(properties),
            `${match[1]} is sent with a measurement: ${properties}`
        );
    }
    assert.deepEqual([...sent].sort(), [...EVENTS].sort());
});

/* --------------------------------------------------------- the aggregation */

const row = (eventName, properties) => ({ eventName, properties });

test("every step is reported, including the ones nobody reached", () => {
    // A step missing from the table would read as a step that does not exist,
    // and the number worth having is the drop between consecutive steps.
    const summary = summarizePackageImportEvents([
        row("assistant_package_import_step_entered", { package_import_step: "source" }),
    ]);
    assert.deepEqual(
        summary.steps.map((step) => step.step),
        [...ASSISTANT_PACKAGE_IMPORT_STEPS]
    );
    assert.equal(summary.steps[0].entered, 1);
    assert.equal(summary.steps[1].entered, 0);
});

test("entered and abandoned are counted separately", () => {
    const summary = summarizePackageImportEvents([
        row("assistant_package_import_step_entered", { package_import_step: "fields" }),
        row("assistant_package_import_step_entered", { package_import_step: "fields" }),
        row("assistant_package_import_step_abandoned", {
            package_import_step: "fields",
        }),
    ]);
    const fields = summary.steps.find((step) => step.step === "fields");
    assert.equal(fields.entered, 2);
    assert.equal(fields.abandoned, 1);
});

test("warnings come back with the biggest first", () => {
    const summary = summarizePackageImportEvents([
        row("assistant_package_import_warning", {
            package_import_warning: "license_absent",
        }),
        row("assistant_package_import_warning", {
            package_import_warning: "license_absent",
        }),
        row("assistant_package_import_warning", {
            package_import_warning: "secret_finding",
        }),
    ]);
    assert.equal(summary.warnings[0].kind, "license_absent");
    assert.equal(summary.warnings[0].count, 2);
    assert.equal(
        summary.warnings.length,
        PACKAGE_IMPORT_WARNING_KINDS.length,
        "every kind is reported, including the zeroes"
    );
});

test("completed is broken down by what the parser read", () => {
    const summary = summarizePackageImportEvents([
        row("assistant_package_import_completed", {
            package_import_source: "agent-skill",
        }),
        row("assistant_package_import_completed", {
            package_import_source: "tomverse-native",
        }),
        row("assistant_package_import_completed", {
            package_import_source: "agent-skill",
        }),
    ]);
    assert.equal(summary.completedTotal, 3);
    assert.deepEqual(summary.completed, [
        { source: "agent-skill", count: 2 },
        { source: "tomverse-native", count: 1 },
    ]);
});

test("a value nothing in the code explains is dropped rather than shown", () => {
    // A row carrying it is a row from a version of the app that no longer
    // exists; inventing a bucket for it would put a label on a dashboard
    // nobody could account for.
    const summary = summarizePackageImportEvents([
        row("assistant_package_import_step_entered", { package_import_step: "gone" }),
        row("assistant_package_import_warning", { package_import_warning: "gone" }),
        row("assistant_package_import_completed", { package_import_source: "gone" }),
        row("assistant_package_import_step_entered", null),
        row("something_else", { package_import_step: "source" }),
    ]);
    assert.equal(
        summary.steps.reduce((sum, step) => sum + step.entered + step.abandoned, 0),
        0
    );
    assert.equal(
        summary.warnings.reduce((sum, warning) => sum + warning.count, 0),
        0
    );
    assert.equal(summary.completedTotal, 0);
});
