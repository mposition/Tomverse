import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Keep suites, priorities, fallback mirrors and APT trust configuration intact. */
export function preferOfficialUbuntuArchive(source) {
  return source.replace(
    /^([ \t]*)https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu(?=\/?(?:[ \t\r]|$))/gm,
    "$1https://archive.ubuntu.com/ubuntu",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(preferOfficialUbuntuArchive(readFileSync(0, "utf8")));
}
