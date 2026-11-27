import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { ARCHIVE_LIMITS, ArchiveSink, archiveRoot, extractTarGz, extractZip, safeEntryName } from "../src/plugin-archive.js";
import { checkDownloadUrl, downloadBytes, type DownloadFetch } from "../src/plugin-download.js";
import { PluginError } from "../src/plugin-fs.js";
import { fetchGitSnapshot, GitAuthRequired, maskUrl } from "../src/plugin-git.js";
import { commitStaged, describeStaged, stagePlugin, type SourceOptions } from "../src/plugin-manager.js";
import { addMarketplace, classifyMarketplaceInput, readCatalog } from "../src/plugin-marketplace.js";
import { checkNpmSource, matchesIntegrity, strongestIntegrity } from "../src/plugin-npm.js";
import { readPluginState } from "../src/plugin-store.js";
import { tarOf, zipOf, type TarItem } from "./archiveBuilders.js";
import { tempDir } from "./helpers.js";

/* ------------------------------------------------------------------ builders: a zip and a tarball, written by hand */

const json = (value: unknown) => JSON.stringify(value);
const hookCommand = (label: string) => `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "\${CLAUDE_PLUGIN_ROOT}/mark.mjs" ${label}`;
const pluginItems = (prefix: string, version: string, label = "one"): Array<{ name: string; data: string }> => [
    { name: `${prefix}.claude-plugin/plugin.json`, data: json({ name: "demo", version }) },
    { name: `${prefix}skills/greet/SKILL.md`, data: `---\ndescription: Greet ${label}\n---\nHello ${label}\n` },
    { name: `${prefix}hooks/hooks.json`, data: json({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand(label) }] }] } }) },
    { name: `${prefix}mark.mjs`, data: `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.MARKER ?? "marker-should-not-exist.txt", "ran");\n` },
];

const unpack = (kind: "zip" | "tar", bytes: Buffer) => {
    const dir = join(tempDir("src-unpack"), "out");
    const sink = new ArchiveSink(dir);
    if (kind === "zip") extractZip(bytes, sink); else extractTarGz(bytes, sink);
    return { dir, sink };
};
const refused = (kind: "zip" | "tar", bytes: Buffer, pattern: RegExp) => assert.throws(() => unpack(kind, bytes), (error) => error instanceof PluginError && pattern.test(error.message), String(pattern));

/** A stand-in for the network: the answer for the first prefix that matches the address. */
const network = (routes: Array<[string, () => Response]>, seen: string[] = []): DownloadFetch => async (url) => {
    seen.push(url);
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    if (!route) return new Response("not found", { status: 404 });
    return route[1]();
};
const bytesResponse = (bytes: Buffer, headers: Record<string, string> = {}) => new Response(bytes, { status: 200, headers });

/* ------------------------------------------------------------------ entry names and unpacking */

test("entry names: an absolute path, `..`, a backslash, a drive letter, a stream suffix and a device name are refused; `.git` and `./` are skipped", () => {
    for (const bad of ["/etc/passwd", "../evil", "a/../../evil", "a\\b", "C:evil", "C:/evil", "file.txt:stream", "aux", "nul.txt", "trailing.", "trailing ", "a//b", "x\u0000y", ""]) {
        assert.throws(() => safeEntryName(bad), PluginError, JSON.stringify(bad));
    }
    assert.deepEqual(safeEntryName("./a/b.txt"), { path: "a/b.txt", directory: false });
    assert.deepEqual(safeEntryName("pkg/skills/"), { path: "pkg/skills", directory: true });
    assert.equal(safeEntryName("./"), null);
    assert.equal(safeEntryName("repo/.git/config"), null);
    assert.throws(() => safeEntryName(`${"d/".repeat(40)}f`), /nested too deeply/);
});

test("a zip unpacks files and folders; the wrapper folder of a repository download is stepped into; a script keeps its executable bit", () => {
    const { dir, sink } = unpack("zip", zipOf([{ name: "repo-main/", data: "" }, ...pluginItems("repo-main/", "1.0.0"), { name: "repo-main/run.sh", data: "#!/bin/sh\n", mode: 0o100755 }]));
    assert.equal(sink.files, 5);
    assert.equal(archiveRoot(dir), join(dir, "repo-main"));
    assert.equal(existsSync(join(dir, "repo-main", ".claude-plugin", "plugin.json")), true);
    // A single folder that is one of the plugin's own is not a wrapper.
    const own = unpack("zip", zipOf([{ name: "skills/a/SKILL.md", data: "---\ndescription: x\n---\nx" }]));
    assert.equal(archiveRoot(own.dir), own.dir);
});

test("zip slip, links, special files, encryption, lies about sizes and checksums are all refused before a file is kept", () => {
    refused("zip", zipOf([{ name: "../evil.txt", data: "x" }]), /climbs out/);
    refused("zip", zipOf([{ name: "/abs.txt", data: "x" }]), /absolute/);
    refused("zip", zipOf([{ name: "a\\..\\evil.txt", data: "x" }]), /backslash/);
    refused("zip", zipOf([{ name: "ok.txt", data: "x" }, { name: "link", data: "ok.txt", mode: 0o120777 }]), /link or a special file/);
    refused("zip", zipOf([{ name: "dev", data: "", mode: 0o020666 }]), /link or a special file/);
    refused("zip", zipOf([{ name: "secret.txt", data: "x", flags: 1 }]), /encrypted/);
    refused("zip", zipOf([{ name: "a.txt", data: "x" }, { name: "A.TXT", data: "y" }]), /twice/);
    refused("zip", zipOf([{ name: "a.txt", data: "hello", claimedCrc: 1 }]), /damaged/);
    refused("zip", zipOf([{ name: "a.txt", data: "x".repeat(10_000), claimedSize: 5 }]), /damaged|more than it says/);
    refused("zip", zipOf([{ name: "big.bin", data: "x", claimedSize: 11 * 1024 * 1024 }]), /larger than 10 MB/);
    refused("zip", Buffer.from("this is not a zip file at all, just text"), /not a zip/);
    // Nothing is written for a zip refused on its table of contents.
    const dir = join(tempDir("src-zip-slip"), "out");
    assert.throws(() => extractZip(zipOf([{ name: "ok.txt", data: "x" }, { name: "../evil.txt", data: "x" }]), new ArchiveSink(dir)), PluginError);
    assert.equal(existsSync(join(dir, "..", "evil.txt")), false);
});

test("a zip with too many entries, or whose files add up past the plugin size, is refused", () => {
    const many = Array.from({ length: 5001 }, (_, index) => ({ name: `f${index}.txt`, data: "x", method: 0 as const }));
    refused("zip", zipOf(many), /more than 5000 files/);
    const heavy = Array.from({ length: 6 }, (_, index) => ({ name: `h${index}.bin`, data: Buffer.alloc(9 * 1024 * 1024) }));
    refused("zip", zipOf(heavy), /larger than 50 MB/);
    assert.ok(ARCHIVE_LIMITS.entries >= 5000);
});

test("a tarball unpacks like npm packs it; links, devices and a deflate bomb are refused", () => {
    const { dir } = unpack("tar", tarOf([{ name: "package/", type: "5" }, ...pluginItems("package/", "1.0.0").map((item) => ({ name: item.name, data: item.data }))]));
    assert.equal(archiveRoot(dir), join(dir, "package"));
    assert.equal(existsSync(join(dir, "package", "skills", "greet", "SKILL.md")), true);
    refused("tar", tarOf([{ name: "package/link", type: "2" }]), /link or a special file/);
    refused("tar", tarOf([{ name: "package/hard", type: "1" }]), /link or a special file/);
    refused("tar", tarOf([{ name: "package/../../evil", data: "x" }]), /climbs out/);
    refused("tar", tarOf([{ name: "/abs", data: "x" }]), /absolute/);
    refused("tar", gzipSync(Buffer.alloc(80 * 1024 * 1024)), /unpacks to more than|damaged/);
    refused("tar", Buffer.from("not gzip"), /gzip/);
});

/* ------------------------------------------------------------------ downloads */

test("a download must be https, public, without a password, and every redirect is held to the same rule; a body past the limit stops", async () => {
    for (const bad of ["http://example.com/x.zip", "ftp://example.com/x.zip", "https://user:pw@example.com/x.zip", "https://localhost/x.zip", "https://127.0.0.1/x.zip",
        "https://192.168.1.5/x.zip", "https://169.254.169.254/latest", "https://[::1]/x.zip", "https://intranet/x.zip", "https://host.internal/x.zip", "not a url", "https://a b.com/"]) {
        assert.throws(() => checkDownloadUrl(bad), PluginError, bad);
    }
    assert.equal(checkDownloadUrl("https://example.com/a.zip?sig=1").hostname, "example.com");
    const seen: string[] = [];
    const redirectToHttp = network([["https://example.com/a", () => new Response(null, { status: 302, headers: { location: "http://example.com/b" } })]], seen);
    await assert.rejects(() => downloadBytes("https://example.com/a", { maxBytes: 1000, fetchImpl: redirectToHttp }), /redirected somewhere not allowed/);
    const redirectInside = network([["https://example.com/a", () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/b" } })]]);
    await assert.rejects(() => downloadBytes("https://example.com/a", { maxBytes: 1000, fetchImpl: redirectInside }), /redirected somewhere not allowed/);
    const loop = network([["https://example.com/", () => new Response(null, { status: 302, headers: { location: "https://example.com/again" } })]]);
    await assert.rejects(() => downloadBytes("https://example.com/a", { maxBytes: 1000, fetchImpl: loop }), /too many times/);
    const big = network([["https://example.com/", () => bytesResponse(Buffer.alloc(5000))]]);
    await assert.rejects(() => downloadBytes("https://example.com/a", { maxBytes: 1000, fetchImpl: big }), /larger than/);
    const noLength = network([["https://example.com/", () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(900)); controller.enqueue(new Uint8Array(900)); controller.close(); } }), { status: 200 })]]);
    await assert.rejects(() => downloadBytes("https://example.com/a", { maxBytes: 1000, fetchImpl: noLength }), /larger than/);
    const missing = network([]);
    await assert.rejects(() => downloadBytes("https://example.com/a", { maxBytes: 1000, fetchImpl: missing }), /answered 404/);
    assert.equal((await downloadBytes("https://example.com/a", { maxBytes: 1000, fetchImpl: network([["https://example.com/", () => bytesResponse(Buffer.from("ok"))]]) })).toString(), "ok");
});

/* ------------------------------------------------------------------ a zip as a plugin source */

const sources = (fetchImpl?: DownloadFetch, extra: Partial<SourceOptions> = {}): { sources: SourceOptions } => ({ sources: { ...(fetchImpl ? { fetchImpl } : {}), ...extra } });

test("a local zip is staged, shown with its SHA-256, and installed only after the confirmation; nothing of it runs; without `sources` it is not available", async () => {
    const home = tempDir("zip-home");
    const archive = join(tempDir("zip-file"), "demo.zip");
    const bytes = zipOf([...pluginItems("demo-main/", "1.0.0")]);
    writeFileSync(archive, bytes);
    const marker = join(tempDir("zip-marker"), "marker.txt");
    process.env.MARKER = marker;
    try {
        await assert.rejects(() => stagePlugin(home, { kind: "zip", path: archive }), /not available here/);
        const result = await stagePlugin(home, { kind: "zip", path: archive }, sources());
        assert.ok("staged" in result);
        const { staged } = result;
        assert.deepEqual(staged.origin, { kind: "zip", sha256: createHash("sha256").update(bytes).digest("hex") });
        assert.match(describeStaged(staged).join("\n"), /From: zip file, SHA-256 [0-9a-f]{64}/);
        assert.match(describeStaged(staged).join("\n"), /hook SessionStart.*mark\.mjs.* one/);
        assert.equal(readPluginState(home).plugins.demo, undefined, "nothing is installed before the confirmation");
        const record = commitStaged(home, staged);
        assert.equal(record.source.kind, "folder", "an older copy of this program can still read the record");
        assert.equal(record.origin?.kind, "zip");
        assert.equal(existsSync(join(home, "plugins", "installed", "demo", "mark.mjs")), true);
        assert.equal(existsSync(marker), false, "installing ran nothing");
        assert.deepEqual(readdirSync(join(home, "plugins", "staging")), []);
        await assert.rejects(() => stagePlugin(home, { kind: "zip", path: join(archive, "..", "missing.zip") }, sources()), /not a readable file/);
        await assert.rejects(() => stagePlugin(home, { kind: "zip", path: "relative.zip" }, sources()), /full path/);
    } finally {
        delete process.env.MARKER;
    }
});

test("a zip that tries to leave its folder installs nothing and leaves nothing behind", async () => {
    const home = tempDir("zip-slip-home");
    const archive = join(tempDir("zip-slip-file"), "bad.zip");
    writeFileSync(archive, zipOf([...pluginItems("", "1.0.0"), { name: "../../escape.txt", data: "x" }]));
    await assert.rejects(() => stagePlugin(home, { kind: "zip", path: archive }, sources()), /climbs out/);
    assert.deepEqual(readdirSync(join(home, "plugins", "staging")), []);
    assert.deepEqual(readPluginState(home).plugins, {});
});

test("a zip from an address: https only, pinned SHA-256 enforced, the address is recorded without its query, and an update downloads the same place again", async () => {
    const home = tempDir("zipurl-home");
    let version = "1.0.0";
    const seen: string[] = [];
    const fetchImpl = network([["https://files.example.com/demo.zip", () => bytesResponse(zipOf(pluginItems("", version, version)))]], seen);
    const first = await stagePlugin(home, { kind: "zip-url", url: "https://files.example.com/demo.zip?token=SECRET" }, sources(fetchImpl));
    assert.ok("staged" in first);
    assert.equal(seen[0], "https://files.example.com/demo.zip?token=SECRET");
    assert.equal(first.staged.origin?.kind === "zip-url" && first.staged.origin.url, "https://files.example.com/demo.zip");
    commitStaged(home, first.staged);
    assert.doesNotMatch(readFileSync(join(home, "plugins", "state.json"), "utf8"), /SECRET/, "the query (which can be a signature) is not kept");
    version = "2.0.0";
    const update = await stagePlugin(home, { kind: "update", name: "demo" }, sources(fetchImpl));
    assert.ok("staged" in update && update.staged.mode === "update");
    assert.equal(update.staged.inspection.version, "2.0.0");
    assert.equal(update.staged.diff?.needsApproval, true);
    commitStaged(home, update.staged);
    assert.equal(readPluginState(home).plugins.demo?.version, "2.0.0");
    const pinned = await stagePlugin(tempDir("zipurl-home2"), { kind: "zip-url", url: "https://files.example.com/demo.zip", sha256: "0".repeat(64) }, sources(fetchImpl)).catch((error: Error) => error);
    assert.match(String(pinned), /does not match the SHA-256/);
    await assert.rejects(() => stagePlugin(home, { kind: "zip-url", url: "http://files.example.com/demo.zip" }, sources(fetchImpl)), /https/);
    await assert.rejects(() => stagePlugin(home, { kind: "zip-url", url: "https://files.example.com/demo.zip" }), /not available here/);
});

/* ------------------------------------------------------------------ npm */

test("npm sources: an exact version or none; a range, a tag, a bad name or a private registry address is refused", () => {
    assert.deepEqual(checkNpmSource({ package: "@acme/tools", version: "1.2.3" }), { package: "@acme/tools", version: "1.2.3" });
    checkNpmSource({ package: "tools" });
    checkNpmSource({ package: "tools", version: "1.0.0-beta.1+build.5" });
    for (const range of ["^1.2.3", "~1.2.3", ">=1.0.0", "latest", "1.x", "1.2", "*"]) assert.throws(() => checkNpmSource({ package: "tools", version: range }), /exact version/, range);
    for (const name of ["Tools", "../evil", "a b", "", "@scope", "@scope/", "x".repeat(215), "-flag"]) assert.throws(() => checkNpmSource({ package: name }), /package name/, name);
    assert.throws(() => checkNpmSource({ package: "tools", registry: "http://registry.example.com" }), /https/);
    assert.throws(() => checkNpmSource({ package: "tools", registry: "https://localhost:4873" }), /private network|this computer/);
    assert.equal(strongestIntegrity("sha1-aaaa sha512-QUJD"), "sha512-QUJD");
    assert.equal(strongestIntegrity("sha1-aaaa"), null);
    assert.equal(matchesIntegrity(Buffer.from("hello"), `sha512-${createHash("sha512").update("hello").digest("base64")}`), true);
    assert.equal(matchesIntegrity(Buffer.from("hello"), "sha1-aaaa"), false);
});

/** A registry that serves one package at one or two versions, with the integrity it really has (or one it lies about). */
const registry = (versions: Record<string, Buffer>, options: { lieAbout?: string; tarballHost?: string; name?: string } = {}) => {
    const seen: string[] = [];
    const answer = (version: string, latest: string) => {
        const bytes = versions[version]!;
        const integrity = `sha512-${createHash("sha512").update(options.lieAbout === version ? Buffer.from("something else") : bytes).digest("base64")}`;
        return new Response(JSON.stringify({ name: options.name ?? "@acme/demo-plugin", version, dist: { integrity, shasum: "x", tarball: `https://${options.tarballHost ?? "registry.npmjs.org"}/@acme/demo-plugin/-/demo-plugin-${version}.tgz` } }), { status: 200, headers: { "content-type": "application/json" } });
        void latest;
    };
    const latest = Object.keys(versions).at(-1)!;
    const fetchImpl = network([
        ...Object.keys(versions).flatMap((version): Array<[string, () => Response]> => [
            [`https://registry.npmjs.org/@acme%2Fdemo-plugin/${version}`, () => answer(version, latest)],
            [`https://registry.npmjs.org/@acme/demo-plugin/-/demo-plugin-${version}.tgz`, () => bytesResponse(versions[version]!)],
        ]),
        ["https://registry.npmjs.org/@acme%2Fdemo-plugin/latest", () => answer(latest, latest)],
    ], seen);
    return { fetchImpl, seen };
};
const packageTarball = (version: string, extra: TarItem[] = []) => tarOf([...pluginItems("package/", version).map((item) => ({ name: item.name, data: item.data })), ...extra]);

test("an npm package is looked up for one version, its tarball checked against the registry's integrity and unpacked as files; install scripts stay text", async () => {
    const home = tempDir("npm-home");
    const { fetchImpl, seen } = registry({ "1.0.0": packageTarball("1.0.0", [{ name: "package/package.json", data: json({ name: "@acme/demo-plugin", version: "1.0.0", scripts: { postinstall: "node evil.js", test: "x" } }) }]) });
    const marker = join(tempDir("npm-marker"), "marker.txt");
    process.env.MARKER = marker;
    try {
        await assert.rejects(() => stagePlugin(home, { kind: "npm", package: "@acme/demo-plugin", version: "1.0.0" }), /not available here/);
        const result = await stagePlugin(home, { kind: "npm", package: "@acme/demo-plugin", version: "1.0.0" }, sources(fetchImpl));
        assert.ok("staged" in result);
        assert.deepEqual(seen, ["https://registry.npmjs.org/@acme%2Fdemo-plugin/1.0.0", "https://registry.npmjs.org/@acme/demo-plugin/-/demo-plugin-1.0.0.tgz"]);
        const { staged } = result;
        assert.equal(staged.origin?.kind, "npm");
        assert.match(staged.origin?.kind === "npm" ? staged.origin.integrity : "", /^sha512-/);
        const text = describeStaged(staged).join("\n");
        assert.match(text, /From: npm package @acme\/demo-plugin@1\.0\.0, integrity sha512-/);
        assert.match(text, /declares postinstall scripts\. They are never run/);
        assert.doesNotMatch(text, /declares .*test/);
        const record = commitStaged(home, staged);
        assert.deepEqual(record.source, { kind: "folder", path: "npm:@acme/demo-plugin@1.0.0" });
        assert.equal(existsSync(marker), false);
        assert.equal(existsSync(join(home, "plugins", "installed", "demo", "node_modules")), false, "no dependency is installed");
    } finally {
        delete process.env.MARKER;
    }
});

test("an npm package that does not match its integrity, answers as another package, sits on another host or has no integrity is refused", async () => {
    const stage = (versions: Record<string, Buffer>, options: Parameters<typeof registry>[1] = {}, request: { version?: string; integrity?: string } = {}) =>
        stagePlugin(tempDir("npm-bad-home"), { kind: "npm", package: "@acme/demo-plugin", version: request.version ?? "1.0.0", ...(request.integrity ? { integrity: request.integrity } : {}) }, sources(registry(versions, options).fetchImpl));
    const good = { "1.0.0": packageTarball("1.0.0") };
    assert.ok("staged" in (await stage(good)));
    await assert.rejects(() => stage(good, { lieAbout: "1.0.0" }), /does not match its integrity/);
    await assert.rejects(() => stage(good, { name: "@acme/other" }), /different package/);
    await assert.rejects(() => stage(good, { tarballHost: "evil.example.com" }), /not on the registry's own host/);
    await assert.rejects(() => stage(good, {}, { integrity: `sha512-${createHash("sha512").update("pinned elsewhere").digest("base64")}` }), /differs from the one the catalog pins/);
    await assert.rejects(() => stage({ "1.0.0": tarOf([{ name: "package/link", type: "2" }]) }), /link or a special file/);
    await assert.rejects(() => stagePlugin(tempDir("npm-range"), { kind: "npm", package: "@acme/demo-plugin", version: "^1.0.0" }, sources(registry(good).fetchImpl)), /exact version/);
    const noIntegrity = network([["https://registry.npmjs.org/tools/", () => new Response(json({ name: "tools", version: "1.0.0", dist: { shasum: "abc", tarball: "https://registry.npmjs.org/tools/-/tools-1.0.0.tgz" } }), { status: 200 })]]);
    await assert.rejects(() => stagePlugin(tempDir("npm-noint"), { kind: "npm", package: "tools", version: "1.0.0" }, sources(noIntegrity)), /no sha512 integrity/);
});

test("an npm plugin is updated from the registry's newest version; the new integrity is what is shown and approved", async () => {
    const home = tempDir("npm-update-home");
    const { fetchImpl } = registry({ "1.0.0": packageTarball("1.0.0"), "2.0.0": packageTarball("2.0.0") });
    const first = await stagePlugin(home, { kind: "npm", package: "@acme/demo-plugin", version: "1.0.0" }, sources(fetchImpl));
    assert.ok("staged" in first);
    commitStaged(home, first.staged);
    const update = await stagePlugin(home, { kind: "update", name: "demo" }, sources(fetchImpl));
    assert.ok("staged" in update);
    assert.equal(update.staged.origin?.kind === "npm" && update.staged.origin.version, "2.0.0");
    assert.notEqual(update.staged.approval, first.staged.approval);
    commitStaged(home, update.staged);
    assert.equal(readPluginState(home).plugins.demo?.origin?.kind === "npm" && readPluginState(home).plugins.demo?.origin?.version, "2.0.0");
    const again = await stagePlugin(home, { kind: "update", name: "demo" }, sources(fetchImpl));
    assert.ok("upToDate" in again);
});

test("a staged plugin whose files or origin changed after it was shown is not installed", async () => {
    const home = tempDir("tamper-home");
    const archive = join(tempDir("tamper-file"), "demo.zip");
    writeFileSync(archive, zipOf(pluginItems("", "1.0.0")));
    const result = await stagePlugin(home, { kind: "zip", path: archive }, sources());
    assert.ok("staged" in result);
    writeFileSync(join(result.staged.tree, "mark.mjs"), "changed after the preview");
    assert.throws(() => commitStaged(home, result.staged), /changed after you looked/);
    const second = await stagePlugin(home, { kind: "zip", path: archive }, sources());
    assert.ok("staged" in second);
    assert.throws(() => commitStaged(home, { ...second.staged, origin: { kind: "zip", sha256: "f".repeat(64) } }), /changed after you looked/);
});

/* ------------------------------------------------------------------ catalog entries */

test("a catalog lists npm and zip entries; they install only where sources are on, and the catalog's pinned integrity is enforced", async () => {
    const home = tempDir("cat-home");
    const dir = tempDir("cat-dir");
    const tarball = packageTarball("1.0.0");
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), json({ name: "acme", plugins: [
        { name: "from-npm", source: { source: "npm", package: "@acme/demo-plugin", version: "1.0.0", integrity } },
        { name: "pinned-wrong", source: { source: "npm", package: "@acme/demo-plugin", version: "1.0.0", integrity: `sha512-${createHash("sha512").update("no").digest("base64")}` } },
        { name: "from-zip", source: { source: "zip", url: "https://files.example.com/demo.zip" } },
        { name: "bad-zip", source: { source: "zip", url: "http://files.example.com/demo.zip" } },
        { name: "bad-npm", source: { source: "npm", package: "x", version: "^1" } },
    ] }));
    const catalog = readCatalog(dir);
    const byName = Object.fromEntries(catalog.entries.map((entry) => [entry.name, entry.source]));
    assert.deepEqual(byName["from-npm"], { kind: "npm", package: "@acme/demo-plugin", version: "1.0.0", integrity });
    assert.deepEqual(byName["from-zip"], { kind: "zip", url: "https://files.example.com/demo.zip" });
    assert.equal(byName["bad-zip"]?.kind, "unsupported");
    assert.equal(byName["bad-npm"]?.kind, "unsupported");
    await addMarketplace(home, classifyMarketplaceInput(dir));
    await assert.rejects(() => stagePlugin(home, { kind: "marketplace", marketplace: "acme", plugin: "from-npm" }), /does not support \(npm\)/);
    await assert.rejects(() => stagePlugin(home, { kind: "marketplace", marketplace: "acme", plugin: "from-zip" }), /does not support \(zip\)/);
    const { fetchImpl } = registry({ "1.0.0": tarball });
    await assert.rejects(() => stagePlugin(home, { kind: "marketplace", marketplace: "acme", plugin: "pinned-wrong" }, sources(fetchImpl)), /differs from the one the catalog pins/);
    const staged = await stagePlugin(home, { kind: "marketplace", marketplace: "acme", plugin: "from-npm" }, sources(fetchImpl));
    assert.ok("staged" in staged);
    commitStaged(home, staged.staged);
    assert.deepEqual(readPluginState(home).plugins.demo?.source, { kind: "marketplace", marketplace: "acme", plugin: "from-npm" });
    assert.equal(readPluginState(home).plugins.demo?.origin?.kind, "npm");
});

/* ------------------------------------------------------------------ a private repository */

test("a GitHub sign-in is used for github.com only, is never part of an address, and a token-shaped text is hidden in anything shown", async () => {
    const destination = join(tempDir("auth-dest"), "out");
    const auth = { credentialHelper: "!'gh' auth git-credential", env: {} };
    await assert.rejects(() => fetchGitSnapshot({ url: "https://git.example.com/acme/x.git" }, destination, { auth }), /only for https:\/\/github\.com/);
    await assert.rejects(() => fetchGitSnapshot({ url: "git@github.com:acme/x.git" }, destination, { auth }), /only for https:\/\/github\.com/);
    assert.throws(() => classifyMarketplaceInput("https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/x.git"), PluginError);
    assert.equal(maskUrl("fatal: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11AAAAAAA0abcdefghijklmnop_qrstuvwxyz failed"), "fatal: token *** and *** failed");
    assert.equal(maskUrl("https://user:pw@github.com/x"), "https://***@github.com/x");
    assert.ok(new GitAuthRequired("x") instanceof PluginError);
    assert.deepEqual(readdirSync(dirname(destination)), [], "a refused download leaves no folder");
});
