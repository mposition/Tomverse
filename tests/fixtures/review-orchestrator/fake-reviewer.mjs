// A stand-in reviewer CLI: reads the prompt on stdin, or from the file named
// after the mode ("promptfile <path>"), and answers per mode.
import { readFileSync, statSync, writeFileSync } from "node:fs";

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
} else if (mode === "sleep") {
  setTimeout(() => process.stdout.write(block({ verdict: "accept", findings: [] })), 60_000);
}
