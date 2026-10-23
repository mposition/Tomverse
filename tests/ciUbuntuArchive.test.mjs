import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { preferOfficialUbuntuArchive } from "../scripts/ci/prefer-ubuntu-archive.mjs";

test("the Azure mirror switches to the signed Ubuntu archive while keeping mirror metadata", () => {
  const source = "# Hosted runner mirrors\nhttp://azure.archive.ubuntu.com/ubuntu/ priority:1\nhttps://security.ubuntu.com/ubuntu/\n";
  assert.equal(preferOfficialUbuntuArchive(source), source.replace("http://azure.archive.ubuntu.com", "https://archive.ubuntu.com"));
});

test("only the exact Azure Ubuntu archive entry changes", () => {
  const unchanged = "# http://azure.archive.ubuntu.com/ubuntu\nhttps://archive.ubuntu.com/ubuntu\nhttps://azure.archive.ubuntu.com.evil/ubuntu\nhttps://azure.archive.ubuntu.com/ubuntu-other\nhttps://mirror.example/ubuntu\n";
  assert.equal(preferOfficialUbuntuArchive(unchanged), unchanged);
  assert.equal(preferOfficialUbuntuArchive("  https://azure.archive.ubuntu.com/ubuntu\r\n"), "  https://archive.ubuntu.com/ubuntu\r\n");
});

test("the installer helper transforms stdin without adding log output to the mirror file", () => {
  const result = execFileSync(process.execPath, ["scripts/ci/prefer-ubuntu-archive.mjs"], {
    input: "http://azure.archive.ubuntu.com/ubuntu\nhttp://security.ubuntu.com/ubuntu\n",
    encoding: "utf8",
  });
  assert.equal(result, "https://archive.ubuntu.com/ubuntu\nhttp://security.ubuntu.com/ubuntu\n");
});
