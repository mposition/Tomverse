// A stand-in reviewer CLI: reads the prompt on stdin, or from the file named
// after the mode ("promptfile <path>"), and answers per mode.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const promptPath = mode === "promptfile" ? process.argv[3] : null;
const prompt = promptPath ? readFileSync(promptPath, "utf8") : readFileSync(0, "utf8");
if (promptPath && process.env.FAKE_REVIEWER_STAT_OUT) {
  writeFileSync(process.env.FAKE_REVIEWER_STAT_OUT, String(statSync(promptPath).mode & 0o777));
}
if (process.env.FAKE_REVIEWER_PROMPT_OUT) writeFileSync(process.env.FAKE_REVIEWER_PROMPT_OUT, prompt);

const block = (value) => `Looked at it.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

if (mode === "accept" || mode === "promptfile") {
  process.stdout.write(block({ verdict: "accept", findings: [] }));
} else if (mode === "reject") {
  process.stdout.write(
    block({ verdict: "reject", findings: [{ severity: "major", file: "a.txt", line: 1, summary: "wrong" }] }),
  );
} else if (mode === "garbage") {
  process.stdout.write("I think it is fine.\n");
} else if (mode === "env") {
  process.stdout.write(block({ verdict: "accept", findings: [{ severity: "nit", summary: `leak=${process.env.REVIEW_ORCH_SECRET_PROBE ?? "none"}` }] }));
} else if (mode === "noisy") {
  process.stderr.write("x".repeat(256 * 1024));
  process.stdout.write(block({ verdict: "accept", findings: [] }));
} else if (mode === "readdiff") {
  // A reviewer with a file tool and no shell: it reads the diff file the
  // prompt names, from its working directory, and reports what it saw.
  const file = /is the file (\S+) in this checkout/.exec(prompt)?.[1] ?? "(none)";
  const diff = readFileSync(file, "utf8");
  const lines = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const tracked = existsSync(".review-orchestrator/tracked.txt") ? readFileSync(".review-orchestrator/tracked.txt", "utf8").trim() : "absent";
  process.stdout.write(block({ verdict: "accept", findings: [{ severity: "nit",
    summary: `file=${file} added=${lines} tail=${diff.includes("+diff-tail-marker")} tracked=${tracked}` }] }));
} else if (mode === "cannot") {
  // What the Antigravity and Claude reviewers wrote on 2026-11-22 before the diff file existed.
  process.stdout.write(block({ verdict: "unknown", findings: [{ severity: "major", file: "a.txt", line: 1, summary: "no shell, could not read the diff" }] }));
} else if (mode === "limit") {
  // What the Claude reviewer printed on 2026-11-23 with its weekly plan spent.
  process.stdout.write("You've hit your weekly limit · resets Nov 26, 1am (UTC)\n");
  process.exit(1);
} else if (mode === "fail") {
  process.exit(3);
} else if (mode === "sleep") {
  setTimeout(() => process.stdout.write(block({ verdict: "accept", findings: [] })), 60_000);
}
