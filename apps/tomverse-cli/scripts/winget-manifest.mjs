// Writes the winget manifests for a published Tomverse CLI release
// (identifier Tomverse.CLI), for a pull request to microsoft/winget-pkgs.
// The installers are the two per-user MSIs on the GitHub Release
// `cli-v<version>`; their SHA-256 comes from the .sha256 files next to them,
// so run it on the folder the release files were uploaded from:
//
//   node scripts/winget-manifest.mjs <folder with tomverse-<v>-windows-*.msi.sha256>
//
// Output: release/winget/manifests/t/Tomverse/CLI/<version>/ (three files).
// Nothing is submitted; `winget validate --manifest <that folder>` checks it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
    console.error(`winget-manifest FAILED: ${message}`);
    process.exit(1);
};
const assets = resolve(process.argv[2] ?? join(app, "release"));
const { version, description } = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
const tag = `cli-v${version}`;
const download = `https://github.com/mposition/Tomverse/releases/download/${tag}`;
// The MSI's UpgradeCode (installer/tomverse.wxs): how winget matches what is installed.
const upgradeCode = readFileSync(join(app, "installer", "tomverse.wxs"), "utf8").match(/UpgradeCode="([0-9A-F-]{36})"/)?.[1];
if (!upgradeCode) fail("no UpgradeCode in installer/tomverse.wxs");

const installers = ["x64", "arm64"].map((arch) => {
    const file = `tomverse-${version}-windows-${arch}.msi`;
    const shaFile = join(assets, `${file}.sha256`);
    if (!existsSync(shaFile)) fail(`${shaFile} missing`);
    const [sha256, name] = readFileSync(shaFile, "utf8").trim().split(/\s+/);
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? "") || name !== file) fail(`${shaFile} is not '<sha256>  ${file}'`);
    return { arch, url: `${download}/${file}`, sha256: sha256.toUpperCase() };
});

const id = "Tomverse.CLI";
/** A single-quoted YAML scalar, safe for any text (a colon in a description breaks a plain one). */
const yamlString = (text) => `'${text.replaceAll("'", "''")}'`;
const schema = "1.10.0";
const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${schema}.schema.json\n`;
const out = join(app, "release", "winget", "manifests", "t", "Tomverse", "CLI", version);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

writeFileSync(
    join(out, `${id}.yaml`),
    `${header("version")}
PackageIdentifier: ${id}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${schema}
`
);
writeFileSync(
    join(out, `${id}.installer.yaml`),
    `${header("installer")}
PackageIdentifier: ${id}
PackageVersion: ${version}
InstallerType: msi
Scope: user
InstallModes:
  - silent
  - silentWithProgress
UpgradeBehavior: install
Commands:
  - tomverse
AppsAndFeaturesEntries:
  - DisplayName: Tomverse CLI
    Publisher: Tomverse
    UpgradeCode: '{${upgradeCode}}'
Installers:
${installers
    .map(
        (i) => `  - Architecture: ${i.arch}
    InstallerUrl: ${i.url}
    InstallerSha256: ${i.sha256}`
    )
    .join("\n")}
ManifestType: installer
ManifestVersion: ${schema}
`
);
writeFileSync(
    join(out, `${id}.locale.en-US.yaml`),
    `${header("defaultLocale")}
PackageIdentifier: ${id}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Tomverse
PublisherUrl: https://tomverse.app
PublisherSupportUrl: https://tomverse.app/support
PackageName: Tomverse CLI
PackageUrl: https://tomverse.app
License: Proprietary
LicenseUrl: https://github.com/mposition/Tomverse/blob/main/apps/tomverse-cli/LICENSE
ShortDescription: ${yamlString(description)}
Description: ${yamlString("A coding agent for your own folder, on your Tomverse API key. It proposes changes as diffs you approve and runs the commands you approve. Needs a Tomverse Pro plan or above.")}
Moniker: tomverse
Tags:
  - ai
  - cli
  - coding-agent
  - tomverse
ReleaseNotesUrl: https://github.com/mposition/Tomverse/releases/tag/${tag}
ManifestType: defaultLocale
ManifestVersion: ${schema}
`
);
console.log(JSON.stringify({ identifier: id, version, folder: out, installers, submitted: false }, null, 2));
