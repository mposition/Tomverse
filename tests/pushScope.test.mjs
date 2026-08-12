import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    describeFindings,
    findPushInfrastructure,
    PUSH_PACKAGES,
} from "../scripts/check-push-scope-core.mjs";

/**
 * PUSH-01 is met by an absence, so the only thing that can go wrong with the
 * check is what it counts. Two failure modes, and both are worse than no check:
 *
 *   - too narrow, and push infrastructure lands without a word;
 *   - too broad, and the check fails an unrelated change with a
 *     push-notification error, which is how a gate gets switched off.
 *
 * So the false positives are tested as deliberately as the true ones.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

const find = (overrides) =>
    findPushInfrastructure({
        dependencies: [],
        sources: [],
        prismaSchema: "",
        paths: [],
        environmentNames: [],
        ...overrides,
    });

test("a delivery SDK in dependencies is the component arriving", () => {
    const findings = find({ dependencies: ["next", "web-push", "react"] });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "dependency");
    assert.equal(findings[0].detail, "web-push");
});

test("the Web Push browser surface is caught wherever it is named", () => {
    const findings = find({
        sources: [
            {
                path: "components/Foo.tsx",
                text: "await registration.pushManager.subscribe({ applicationServerKey: key });",
            },
        ],
    });
    assert.deepEqual(
        findings.map((finding) => finding.detail).sort(),
        ["applicationServerKey", "pushManager"]
    );
});

test("a device-registration table is caught by its model name", () => {
    const findings = find({
        prismaSchema: "model PushSubscription {\n  id String @id\n}\n",
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "schema");
    assert.equal(findings[0].detail, "PushSubscription");
});

test("a push endpoint and a service worker are caught by path", () => {
    const findings = find({
        paths: ["app/api/push/subscribe/route.ts", "public/sw.js", "app/api/chat/route.ts"],
    });
    assert.deepEqual(
        findings.map((finding) => finding.kind).sort(),
        ["route", "service-worker"]
    );
});

test("a server credential counts even with no code reading it", () => {
    const findings = find({ environmentNames: ["DATABASE_URL", "VAPID_PRIVATE_KEY"] });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "credential");
});

test("the word push is never on its own a signal", () => {
    // `Array.prototype.push` and `git push` are everywhere in this repository.
    // A check that failed on either would be removed rather than fixed.
    const findings = find({
        sources: [
            {
                path: "lib/thing.ts",
                text:
                    "const found = [];\nfound.push(entry);\nresults.push(...more);\n" +
                    "// run `git push -u origin main` when done\n" +
                    "const pushed = queue.push(item);",
            },
        ],
    });
    assert.deepEqual(findings, []);
});

test("email notification delivery is not push infrastructure", () => {
    // The tree already has both of these. Notifying somebody is not push;
    // delivering to a device registration is. If this ever starts failing, the
    // check has begun blocking the queue the product actually uses.
    const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
    assert.ok(schema.includes("model NotificationDelivery {"));
    assert.ok(schema.includes("model AdminNotificationLog {"));
    assert.deepEqual(find({ prismaSchema: schema }), []);
});

test("a subscription getter in billing code is not a push subscription", () => {
    // `getSubscription` reads as Stripe in a product that sells subscriptions,
    // and `requestPermission` is the shape of several unrelated browser APIs.
    // Neither is a signal on its own; the specific phrase is.
    const billing = {
        path: "lib/stripeSubscriptions.ts",
        text: "export const getSubscription = (id: string) => stripe.subscriptions.retrieve(id);",
    };
    assert.deepEqual(find({ sources: [billing] }), []);

    const permission = {
        path: "components/Foo.tsx",
        text: "await Notification.requestPermission();",
    };
    assert.equal(find({ sources: [permission] }).length, 1);
});

test("the message points at the gate, not at the reviewer", () => {
    const clean = describeFindings([]);
    assert.match(clean, /No push-notification infrastructure/);
    const dirty = describeFindings([
        { kind: "dependency", detail: "web-push", where: "package.json" },
    ]);
    assert.match(dirty, /PUSH-01/);
    assert.match(dirty, /docs\/release-gates\/tomverse-chat-v1\.yaml/);
    // The check reports; approval is a decision recorded on the gate. Saying so
    // is what keeps this from reading as a veto.
    assert.match(dirty, /this check only reports what the tree contains/);
});

test("the package list names the delivery SDKs by their real names", () => {
    for (const name of ["web-push", "firebase-admin", "expo-notifications", "node-apn"]) {
        assert.ok(PUSH_PACKAGES.includes(name), `${name} should be listed`);
    }
});
