/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { estimateTokens } from "../src/agent.js";
import { IMAGE_MAX_BYTES, imageTypeOf, viewImageTool } from "../src/tools.js";
import { requestTransmission } from "../src/transmission.js";
import { PathError, Workspace, withWorkspaceReferences } from "../src/workspace.js";
import { DEFAULT_MODELS, FakeGateway } from "./fakeGateway.js";
import { makeRepo, makeRunner } from "./helpers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(40, 4)]);

const visionModels = DEFAULT_MODELS.map((m: any) => m.id === "fake-coder"
    ? { ...m, id: "fake-vision", tomverse: { ...m.tomverse, capabilities: { ...m.tomverse.capabilities, vision: true } } } : m);

test("an image is recognised by its first bytes, among the types the API accepts", () => {
    assert.equal(imageTypeOf(PNG), "image/png");
    assert.equal(imageTypeOf(JPEG), "image/jpeg");
    assert.equal(imageTypeOf(GIF), "image/gif");
    assert.equal(imageTypeOf(WEBP), "image/webp");
    assert.equal(imageTypeOf(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
    assert.equal(imageTypeOf(Buffer.from("just text named .png")), null);
    assert.equal(imageTypeOf(Buffer.alloc(0)), null);
});

test("view_image reads workspace images under the same path rules as read_file", () => {
    const root = makeRepo();
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "shot.png"), PNG);
    writeFileSync(join(root, "assets", "fake.png"), "not an image");
    writeFileSync(join(root, "assets", "huge.png"), Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)]));
    writeFileSync(join(root, "secret.png"), PNG);
    writeFileSync(join(root, ".env.png"), PNG);
    const ctx = { workspace: new Workspace(root) };
    const ok = viewImageTool(ctx, { path: "assets/shot.png" });
    assert.equal(ok.result.status, "ok");
    assert.deepEqual([ok.attachment?.mediaType, ok.attachment?.bytes, ok.attachment?.base64], ["image/png", PNG.length, PNG.toString("base64")]);
    for (const [path, pattern] of [["assets/fake.png", /not a PNG, JPEG, WebP or GIF/], ["assets/huge.png", /images up to/], ["assets/missing.png", /does not exist/], ["assets", /is not a file/]] as const) {
        const refused = viewImageTool(ctx, { path });
        assert.equal(refused.result.status, "error", path);
        assert.match(String((refused.result as any).error), pattern, path);
        assert.equal(refused.attachment, undefined, path);
    }
    // Credential-looking names and anything outside the folder are refused before a byte is read.
    for (const path of ["secret.png", ".env.png", "../outside.png", "/etc/passwd.png"]) assert.throws(() => viewImageTool(ctx, { path }), PathError, path);
});

test("an image counts a flat size, not its base64 text", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "Image from view_image: a.png" }, { type: "image", image: "A".repeat(3_000_000), mediaType: "image/png" }] }];
    const tokens = estimateTokens(messages);
    assert.ok(tokens > 1000 && tokens < 3000, `estimated ${tokens}`);
});

test("a reference to an image file mentions view_image; other references do not", () => {
    assert.match(withWorkspaceReferences("Fix this.", [{ path: "ui/mock.PNG", kind: "file" }]), /view_image/);
    assert.doesNotMatch(withWorkspaceReferences("Fix this.", [{ path: "src/a.ts", kind: "file" }, { path: "shots.png", kind: "folder" }]), /view_image/);
});

test("the transmission record counts the images a request carries", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] });
    assert.equal(requestTransmission(body, (t) => t)?.imageCount, 1);
    assert.equal(requestTransmission(JSON.stringify({ messages: [{ role: "user", content: "plain" }] }), (t) => t)?.imageCount, undefined);
});

const viewScript = (paths: string[]) => (body: any) => {
    // The image itself arrives as a user message, so count every tool result of the history, not those since the last user message.
    const done = body.messages.filter((m: any) => m.role === "tool").length;
    if (done < paths.length) return { toolCalls: [{ name: "view_image", args: { path: paths[done] } }] };
    return { text: "It is a screenshot." };
};

test("a model that takes images gets view_image, and the image reaches the next request as image data", async () => {
    const root = makeRepo();
    writeFileSync(join(root, "shot.png"), PNG);
    const gateway = await new FakeGateway({ models: visionModels, script: viewScript(["shot.png"]) }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, root, { model: "fake-vision", readOnly: true, runner: { images: true } });
        assert.equal(await runner.runTask("What is in shot.png?"), "success");
        assert.equal(gateway.completions.length, 2);
        assert.ok(gateway.completions[0]!.body.tools.some((t: any) => t.function.name === "view_image"), "offered to a vision model, even read-only");
        const second = gateway.completions[1]!.body.messages;
        const last = second.at(-1);
        assert.equal(last.role, "user");
        assert.deepEqual(last.content[0], { type: "text", text: "Image from view_image: shot.png" });
        assert.equal(last.content[1].type, "image_url");
        assert.equal(last.content[1].image_url.url, `data:image/png;base64,${PNG.toString("base64")}`);
        // The tool result comes before the user message that carries the image, as the API requires.
        assert.equal(second.at(-2).role, "tool");
        assert.match(gateway.completions[0]!.body.messages[0].content, /view_image shows you/);
        assert.ok(journal.state.messages.some((m) => m.role === "user" && Array.isArray(m.content)));
    } finally {
        await gateway.stop();
    }
});

test("a model that does not take images is not offered view_image", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ models: visionModels, script: () => ({ text: "ok" }) }).start();
    try {
        const { runner } = await makeRunner(gateway, root, { model: "fake-small", runner: { images: true } });
        assert.equal(await runner.runTask("Look."), "success");
        assert.ok(!gateway.completions[0]!.body.tools.some((t: any) => t.function.name === "view_image"));
        assert.doesNotMatch(gateway.completions[0]!.body.messages[0].content, /view_image/);
    } finally {
        await gateway.stop();
    }
});

test("only the newest three images stay attached; older ones become a note, and a refused path attaches nothing", async () => {
    const root = makeRepo();
    const names = ["a.png", "b.jpg", "c.gif", "d.webp", "e.png"];
    for (const [i, name] of names.entries()) writeFileSync(join(root, name), [PNG, JPEG, GIF, WEBP, PNG][i]!);
    const gateway = await new FakeGateway({ models: visionModels, script: viewScript([...names, "secret.png"]) }).start();
    try {
        const { runner } = await makeRunner(gateway, root, { model: "fake-vision", runner: { images: true } });
        assert.equal(await runner.runTask("Look at all of them."), "success");
        const images = (body: any) => body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image_url") : []);
        assert.deepEqual(gateway.completions.map((c) => images(c.body).length), [0, 1, 2, 3, 3, 3, 3]);
        const text = JSON.stringify(gateway.completions.at(-1)!.body.messages);
        assert.match(text, /no longer attached/);
        assert.match(text, /can hold credentials/);
        assert.equal(images(gateway.completions.at(-1)!.body).length, 3);
    } finally {
        await gateway.stop();
    }
});

test("a host that did not opt in never offers view_image, even to a vision model", async () => {
    const gateway = await new FakeGateway({ models: visionModels, script: () => ({ text: "ok" }) }).start();
    try {
        const { runner } = await makeRunner(gateway, makeRepo(), { model: "fake-vision" });
        assert.equal(await runner.runTask("Look."), "success");
        assert.ok(!gateway.completions[0]!.body.tools.some((t: any) => t.function.name === "view_image"));
    } finally {
        await gateway.stop();
    }
});
