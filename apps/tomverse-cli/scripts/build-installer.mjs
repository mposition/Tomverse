// Builds the native installer for the platform this runs on, from the
// standalone executable that scripts/build-binary.mjs left in
// release/tomverse-<version>-<os>-<arch>/:
//   Windows  .msi      per user, %LOCALAPPDATA%\Programs\Tomverse CLI, on PATH (WiX v5)
//   macOS    .pkg      /usr/local/bin/tomverse (pkgbuild)
//   Linux    .deb      /usr/bin/tomverse (dpkg-deb), and .rpm when rpmbuild is present
// Each with a .sha256. Nothing is uploaded and nothing is signed here.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
    console.error(`build-installer FAILED: ${message}`);
    process.exit(1);
};
const run = (cmd, args, options = {}) => {
    const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
    if (result.status !== 0) fail(`${cmd} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`);
    return result.stdout;
};
const has = (cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0;

const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
const version = pkg.version;
const os = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
if (!os) fail(`no installer for ${process.platform}`);
const target = `${os}-${process.arch}`;
const out = join(app, "release");
const stage = join(out, `tomverse-${version}-${target}`);
const exe = join(stage, process.platform === "win32" ? "tomverse.exe" : "tomverse");
if (!existsSync(exe)) fail(`${exe} missing; run scripts/build-binary.mjs first.`);
const work = join(out, `installer-${target}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const built = [];
const checksum = (file) => {
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
    built.push({ file, sha256 });
};
const docs = ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.txt"];

if (process.platform === "win32") {
    // WiX v5 (MS-RL). v6 adds the Open Source Maintenance Fee terms.
    const wix = process.env.WIX ?? "wix";
    if (spawnSync(wix, ["--version"], { encoding: "utf8" }).status !== 0) fail("WiX Toolset v5 not found: dotnet tool install --global wix --version 5.0.2 (or set WIX)");
    const msi = join(out, `tomverse-${version}-${target}.msi`);
    rmSync(msi, { force: true });
    run(wix, ["build", join(app, "installer", "tomverse.wxs"), "-arch", process.arch, "-d", `Version=${version}`, "-d", `StageDir=${stage}`, "-o", msi]);
    rmSync(msi.replace(/\.msi$/, ".wixpdb"), { force: true });
    checksum(msi);
} else if (process.platform === "darwin") {
    const root = join(work, "root");
    mkdirSync(join(root, "usr", "local", "bin"), { recursive: true });
    mkdirSync(join(root, "usr", "local", "share", "doc", "tomverse-cli"), { recursive: true });
    copyFileSync(exe, join(root, "usr", "local", "bin", "tomverse"));
    chmodSync(join(root, "usr", "local", "bin", "tomverse"), 0o755);
    for (const doc of docs) copyFileSync(join(stage, doc), join(root, "usr", "local", "share", "doc", "tomverse-cli", doc));
    const pkgFile = join(out, `tomverse-${version}-${target}.pkg`);
    rmSync(pkgFile, { force: true });
    run("pkgbuild", ["--root", root, "--identifier", "app.tomverse.cli", "--version", version, "--install-location", "/", pkgFile]);
    // Every user of the Mac must be able to run what is installed.
    run("pkgutil", ["--expand-full", pkgFile, join(work, "expanded")]);
    const mode = run("stat", ["-f", "%Lp", join(work, "expanded", "Payload", "usr", "local", "bin", "tomverse")]).trim();
    if (mode !== "755") fail(`the packaged tomverse has mode ${mode}, not 755`);
    checksum(pkgFile);
} else {
    const debArch = { x64: "amd64", arm64: "arm64" }[process.arch];
    const rpmArch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
    if (!debArch) fail(`no Linux package for ${process.arch}`);
    const description = "Tomverse coding CLI: work on your own folder with a Tomverse API key.";

    const deb = join(work, "deb");
    mkdirSync(join(deb, "DEBIAN"), { recursive: true });
    mkdirSync(join(deb, "usr", "bin"), { recursive: true });
    mkdirSync(join(deb, "usr", "share", "doc", "tomverse-cli"), { recursive: true });
    copyFileSync(exe, join(deb, "usr", "bin", "tomverse"));
    chmodSync(join(deb, "usr", "bin", "tomverse"), 0o755);
    copyFileSync(join(stage, "LICENSE"), join(deb, "usr", "share", "doc", "tomverse-cli", "copyright"));
    for (const doc of docs.slice(1)) copyFileSync(join(stage, doc), join(deb, "usr", "share", "doc", "tomverse-cli", doc));
    writeFileSync(
        join(deb, "DEBIAN", "control"),
        [
            "Package: tomverse-cli",
            `Version: ${version}`,
            `Architecture: ${debArch}`,
            "Maintainer: Tomverse <support@tomverse.app>",
            "Homepage: https://tomverse.app",
            "Section: devel",
            "Priority: optional",
            `Description: ${description}`,
            "",
        ].join("\n")
    );
    const debFile = join(out, `tomverse-${version}-${target}.deb`);
    rmSync(debFile, { force: true });
    run("dpkg-deb", ["--root-owner-group", "--build", deb, debFile]);
    checksum(debFile);

    if (has("rpmbuild")) {
        const top = join(work, "rpm");
        for (const d of ["BUILD", "RPMS", "SOURCES", "SPECS", "SRPMS"]) mkdirSync(join(top, d), { recursive: true });
        for (const f of ["tomverse", ...docs]) copyFileSync(join(stage, f), join(top, "SOURCES", f));
        // The executable carries the application in an ELF note that strip or
        // debuginfo extraction would remove, so rpm's post-install steps are off.
        const spec = `%global __os_install_post %{nil}
%global debug_package %{nil}
%global _build_id_links none
Name: tomverse-cli
Version: ${version}
Release: 1
Summary: ${description}
License: Proprietary
URL: https://tomverse.app
AutoReqProv: no

%description
${description}

%install
install -D -m 0755 %{_sourcedir}/tomverse %{buildroot}/usr/bin/tomverse
install -D -m 0644 %{_sourcedir}/LICENSE %{buildroot}/usr/share/doc/tomverse-cli/LICENSE
install -D -m 0644 %{_sourcedir}/README.md %{buildroot}/usr/share/doc/tomverse-cli/README.md
install -D -m 0644 %{_sourcedir}/THIRD_PARTY_NOTICES.txt %{buildroot}/usr/share/doc/tomverse-cli/THIRD_PARTY_NOTICES.txt

%files
/usr/bin/tomverse
/usr/share/doc/tomverse-cli
`;
        writeFileSync(join(top, "SPECS", "tomverse-cli.spec"), spec);
        run("rpmbuild", ["-bb", "--define", `_topdir ${top}`, "--target", rpmArch, join(top, "SPECS", "tomverse-cli.spec")]);
        const rpmFile = join(out, `tomverse-${version}-${target}.rpm`);
        rmSync(rpmFile, { force: true });
        copyFileSync(join(top, "RPMS", rpmArch, `tomverse-cli-${version}-1.${rpmArch}.rpm`), rpmFile);
        checksum(rpmFile);
    } else {
        console.warn("rpmbuild not found: no .rpm built");
    }
}

rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ target, installers: built, published: false }, null, 2));
console.log("build-installer OK");
