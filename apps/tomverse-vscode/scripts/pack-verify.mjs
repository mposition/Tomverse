import { open } from "yauzl";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const artifact = join(root, "artifacts", `tomverse-vscode-${manifest.version}.vsix`);
const files = [];
const allowed =
    /^(?:\[Content_Types\]\.xml|extension\.vsixmanifest|extension\/(?:package(?:\.nls(?:\.[\w-]+)?)?\.json|readme\.md|changelog\.md|LICENSE\.txt|THIRD-PARTY-NOTICES\.txt|dist\/extension\.cjs|media\/(?:tomverse\.svg|sidebar\.js|sidebar\.css)))$/;
await new Promise((resolve, reject) =>
    open(artifact, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        zip.on("error", reject);
        zip.on("end", resolve);
        zip.on("entry", (entry) => {
            if (!allowed.test(entry.fileName)) return reject(new Error(`Unexpected archive path: ${entry.fileName}`));
            files.push(entry.fileName);
            zip.openReadStream(entry, (error, stream) => {
                if (error) return reject(error);
                const chunks = [];
                stream.on("error", reject);
                stream.on("data", (chunk) => chunks.push(chunk));
                stream.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if (/(?:tvk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text))
                        return reject(new Error(`Credential-shaped content: ${entry.fileName}`));
                    if (/[/\\](?:handoffs|tomverse-private-docs)[/\\]/i.test(text)) return reject(new Error(`Private path: ${entry.fileName}`));
                    zip.readEntry();
                });
            });
        });
        zip.readEntry();
    }),
);
for (const name of [
    "extension/dist/extension.cjs",
    "extension/readme.md",
    "extension/LICENSE.txt",
    "extension/THIRD-PARTY-NOTICES.txt",
    "extension/media/sidebar.js",
])
    if (!files.includes(name)) throw new Error(`Missing ${name}`);
const result = {
    artifact,
    sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
    files,
    checks: { allowlist: true, credentialScan: true, privatePathScan: true },
};
writeFileSync(join(root, "artifacts/pack-verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
