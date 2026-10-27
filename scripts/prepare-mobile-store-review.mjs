import { randomBytes, randomInt } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hashMobileStoreReviewCode } from "../lib/mobileStoreReviewCore.ts";

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const email = option("--email")?.trim().toLowerCase();
const submissionId = option("--submission");
const buildNumber = Number(option("--build"));
const directory = option("--output");
if (!args.includes("--create-account") || !/^play-review[-+][a-z0-9-]+@tomverse\.app$/.test(email || "") ||
    !/^[a-zA-Z0-9-]{8,120}$/.test(submissionId || "") || !Number.isSafeInteger(buildNumber) || buildNumber < 1 || !directory || !isAbsolute(directory)) {
  throw new Error("Explicit --create-account, a dedicated play-review address, --submission, --build and an absolute private --output directory are required.");
}
const output = resolve(directory);
const repoRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const fromRepo = relative(repoRoot, resolve(await realpath(dirname(output)), basename(output)));
if (!fromRepo.startsWith(`..${sep}`) && !isAbsolute(fromRepo)) throw new Error("Credential output must be outside the repository.");
await mkdir(output, { recursive: false, mode: 0o700 });
let prisma;
try {
  ({ prisma } = await import("../lib/prisma.ts"));
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) throw new Error("Address already exists. Inspect the previous outcome; never reuse a customer account.");
  const user = await prisma.user.create({ data: { email, name: "Google Play Review", plan: "Free", emailVerified: new Date(), emailLoginEnabled: true }, select: { id: true } });
  const code = randomInt(1_000_000).toString().padStart(6, "0");
  const credential = { submissionId, userId: user.id, email, appId: "app.tomverse.shell", buildNumber, plan: "Free", state: "prepared", validUntil: new Date(Date.now() + 14 * 86400000).toISOString(), salt: randomBytes(32).toString("hex"), codeHash: "" };
  credential.codeHash = hashMobileStoreReviewCode(credential, code);
  await writeFile(resolve(output, "server-credential.json"), JSON.stringify(credential, null, 2), { flag: "wx", mode: 0o600 });
  await writeFile(resolve(output, "private-review-instructions.txt"), `Submission: ${submissionId}\nBuild: ${buildNumber}\nAccount: ${email}\nPrivate verification code: ${code}\n\nChoose Use an email code in the app. Enter the account, continue, then enter the supplied code. No mailbox access is needed. The Free account requires no purchase.\n\nAccount data can be exported or deleted in Settings > Data. Internet access is required.\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ accountPrepared: true, enabled: false, privateOutputDirectory: output }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ accountPrepared: false, errorType: error?.code || error?.name || "UnknownError", next: "Inspect the dedicated address and private output before retrying; no credential was activated." }) + "\n");
  process.exitCode = 1;
} finally { await prisma?.$disconnect(); }
