import assert from "node:assert/strict";
import test from "node:test";
import { terminalEnv } from "../src/host/terminal-env";

const source: NodeJS.ProcessEnv = {
  PATH: "/usr/bin", HOME: "/home/person", LANG: "en_US.UTF-8", SHELL: "/bin/zsh", TZ: "Australia/Brisbane",
  TOMVERSE_SESSION_TOKEN: "session-token-value", TOMVERSE_DESKTOP_PROJECT_LOCKS: "/locks", TOMVERSE_API_KEY: "tvk_abcdefgh_" + "A".repeat(43),
  OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant", GITHUB_TOKEN: "ghp_test", AWS_SECRET_ACCESS_KEY: "aws-secret",
  DATABASE_PASSWORD: "hunter2", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require /evil.js", NODE_PATH: "/evil",
  NO_COLOR: "1", FORCE_COLOR: "0", RANDOM_APP_SETTING: "kept out",
};

test("a terminal gets the person's basic environment and none of the app's credentials", () => {
  const env = terminalEnv(source);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/person");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.TZ, "Australia/Brisbane");
  const values = Object.values(env).join("\n");
  for (const secret of ["session-token-value", "tvk_abcdefgh_", "sk-test", "sk-ant", "ghp_test", "aws-secret", "hunter2", "/evil", "/locks"]) {
    assert.ok(!values.includes(secret), `The terminal environment carries ${secret}.`);
  }
  for (const name of Object.keys(env)) assert.doesNotMatch(name, /^(?:TOMVERSE_|ELECTRON_|NODE_)|TOKEN|SECRET|PASSWORD|API_?KEY/i, name);
  assert.equal(env.RANDOM_APP_SETTING, undefined);
});

test("a terminal is for a person: colour is on and the terminal type is a real one", () => {
  const env = terminalEnv(source);
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.FORCE_COLOR, undefined);
});

test("the real process environment of this test run is cleaned the same way", () => {
  const previous = process.env.TOMVERSE_LEAK_PROBE;
  process.env.TOMVERSE_LEAK_PROBE = "probe-value";
  try {
    const env = terminalEnv();
    assert.equal(env.TOMVERSE_LEAK_PROBE, undefined);
    assert.ok(!Object.values(env).includes("probe-value"));
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_LEAK_PROBE; else process.env.TOMVERSE_LEAK_PROBE = previous;
  }
});
