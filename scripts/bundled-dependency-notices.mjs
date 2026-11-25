import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function bundledDependencyNotices(inputs) {
  const packages = new Map();
  for (const input of inputs) {
    const parts = input.split(/[\\/]/);
    const at = parts.lastIndexOf("node_modules");
    if (at < 0) continue;
    const length = parts[at + 1].startsWith("@") ? 2 : 1;
    const nameParts = parts.slice(at + 1, at + 1 + length);
    packages.set(resolve(parts.slice(0, at + 1).join("/"), ...nameParts), nameParts.join("/"));
  }

  const described = [...packages]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([dir]) => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return {
        dir,
        id: `${pkg.name}@${pkg.version}`,
        license: typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license),
        files: readdirSync(dir).filter((file) => /^(licen[cs]e|notice|copying)(\.|$)/i.test(file)).sort(),
      };
    });
  return described.map((pkg) => {
    const title = `${"=".repeat(78)}\n${pkg.id} (${pkg.license})\n${"=".repeat(78)}\n`;
    if (pkg.files.length) {
      return title + pkg.files.map((file) => readFileSync(join(pkg.dir, file), "utf8").trim()).join("\n\n") + "\n";
    }
    const same = described.find((candidate) => candidate.license === pkg.license && candidate.files.length);
    if (!same || pkg.license !== "Apache-2.0") throw new Error(`${pkg.id} (${pkg.license}) has no license file to reproduce`);
    return `${title}This package ships no license file. It is licensed under ${pkg.license}; the full license text is reproduced above or below under ${same.id}.\n`;
  });
}
