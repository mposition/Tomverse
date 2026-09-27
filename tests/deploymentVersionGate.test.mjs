import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    VERSION_PIN_STRENGTHS,
    versionMayDrift,
} from "../lib/deploymentIdentity.ts";

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923390000_deployment_version_gate_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

test("a strong pin does not drift, including when the flag is set", () => {
    assert.equal(
        versionMayDrift({ versionPinStrength: "strong", allowVersionDrift: true }),
        false
    );
    assert.equal(
        versionMayDrift({ versionPinStrength: "strong", allowVersionDrift: false }),
        false
    );
});

test("weak and alias_only drift only when the flag is set", () => {
    for (const versionPinStrength of ["weak", "alias_only"]) {
        assert.equal(
            versionMayDrift({ versionPinStrength, allowVersionDrift: true }),
            true,
            versionPinStrength
        );
        assert.equal(
            versionMayDrift({ versionPinStrength, allowVersionDrift: false }),
            false,
            versionPinStrength
        );
    }
});

test("an unknown strength does not drift", () => {
    assert.equal(
        versionMayDrift({ versionPinStrength: "loose", allowVersionDrift: true }),
        false
    );
    assert.equal(
        versionMayDrift({ versionPinStrength: null, allowVersionDrift: true }),
        false
    );
});

test("a published entry does not receive a pin by default", () => {
    const dropped = readFileSync(
        new URL(
            "../prisma/migrations/20260923420000_manifest_entry_pin_no_default/migration.sql",
            import.meta.url
        ),
        "utf8"
    );
    assert.match(dropped, /"RoutingIdentityManifestEntry" ALTER COLUMN "versionPinStrength" DROP DEFAULT/);
    assert.match(dropped, /"RoutingIdentityManifestEntry" ALTER COLUMN "allowVersionDrift" DROP DEFAULT/);
    const alters = dropped.split("\n").filter((line) => line.startsWith("ALTER TABLE"));
    assert.deepEqual(
        alters.map((line) => line.includes('"RoutingIdentityManifestEntry"')),
        [true, true]
    );
});

test("the pin vocabulary is the three strengths, strong first", () => {
    assert.deepEqual(VERSION_PIN_STRENGTHS, ["strong", "weak", "alias_only"]);
    const sql = migration();
    for (const strength of VERSION_PIN_STRENGTHS) {
        assert.ok(sql.includes(`'${strength}'`), strength);
    }
});
