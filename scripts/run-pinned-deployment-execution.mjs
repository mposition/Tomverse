// Stores the one approved production placement and its experiment ceiling.
//
// Dry run is the default. It reads the supplied account and reports whether
// a matching placement and experiment already exist. It prints the account's
// plan and the stored ids. It does not print the account id or DATABASE_URL.
//
// A write needs the whole line:
//   --apply --approved-pinned-execution --limit-micro-usd=1000000 --target=production
// and PINNED_DEPLOYMENT_ACCOUNT_ID in the environment. Any other limit or
// target is refused. There is no default amount.
//
// This command does not apply a migration, set service variables, or call a
// provider. It refuses CI, Railway's deploy id, and npm build/start/deploy/
// migrate lifecycle events.

import {
    approvedLiveClaim,
    parsePinnedExecutionLimit,
    pinnedExecutionProblems,
} from "../lib/pinnedDeploymentOperator.ts";

const argValue = (name) => {
    const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return match ? match.slice(name.length + 3).trim() || null : null;
};

const invocation = {
    apply: process.argv.includes("--apply"),
    approved: process.argv.includes("--approved-pinned-execution"),
    limitMicroUsd: parsePinnedExecutionLimit(argValue("limit-micro-usd")),
    target: argValue("target"),
    accountId: process.env.PINNED_DEPLOYMENT_ACCOUNT_ID ?? null,
    ci: process.env.CI === "1" || process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true",
    lifecycleEvent: process.env.npm_lifecycle_event ?? null,
    railwayDeployment: Boolean(process.env.RAILWAY_DEPLOYMENT_ID?.trim()),
};

const problems = pinnedExecutionProblems(invocation);
if (problems.length > 0) {
    console.error(problems.map((problem) => `${problem.code}: ${problem.message}`).join("\n"));
    process.exit(1);
}

if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
}

const claim = approvedLiveClaim();
if (!claim) {
    console.error("The live catalogue claim does not match.");
    process.exit(1);
}

const databaseCode = (error) =>
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "unknown";

const { prisma } = await import("../lib/prisma.ts");
const { findLivePlacement, createLivePlacement } = await import("../lib/pinnedDeploymentPlacement.ts");
const { listPinnedExperiments, createPinnedExperiment } = await import("../lib/pinnedDeploymentBudget.ts");

let account;
try {
    account = await prisma.user.findUnique({
        where: { id: invocation.accountId },
        select: { plan: true },
    });
} catch (error) {
    console.error(`Database read failed (${databaseCode(error)}).`);
    process.exit(1);
}
if (!account) {
    console.error("The supplied account was not found.");
    process.exit(1);
}

let placement;
let experiments;
try {
    placement = await findLivePlacement(prisma, claim);
    experiments = await listPinnedExperiments(prisma);
} catch (error) {
    console.error(`Database read failed (${databaseCode(error)}).`);
    process.exit(1);
}
if (!placement?.ok || !experiments) {
    console.error("The placement or the experiment ledger could not be read.");
    process.exit(1);
}

const matchingExperiment = experiments.filter(
    (experiment) => experiment.limitMicroUsd === invocation.limitMicroUsd
);
if (experiments.length > 1 || (experiments.length === 1 && matchingExperiment.length !== 1)) {
    console.error("The experiment ledger already has a row this command will not replace.");
    process.exit(1);
}

let deploymentId = placement.deploymentId;
let experimentId = matchingExperiment[0]?.id ?? null;
let wrote = false;

if (invocation.apply) {
    if (!deploymentId) {
        const created = await createLivePlacement(prisma, claim);
        if (!created.ok) {
            console.error("The placement was not stored.");
            process.exit(1);
        }
        deploymentId = created.deploymentId;
        wrote = true;
    }
    if (!experimentId) {
        const created = await createPinnedExperiment(prisma, invocation.limitMicroUsd);
        if (!created.ok) {
            console.error("The experiment ceiling was not stored.");
            process.exit(1);
        }
        experimentId = created.experimentId;
        wrote = true;
    }
}

console.log(`account: found, plan=${account.plan}`);
console.log(`target=${invocation.target}`);
console.log(`logicalModelId=${claim.logicalModelId}`);
console.log(`provider=${claim.gatewayProvider}`);
console.log(`endpointUrl=${claim.endpointUrl}`);
console.log(`upstreamDeploymentName=${claim.upstreamDeploymentName}`);
console.log(`limitMicroUsd=${invocation.limitMicroUsd}`);
console.log(`deploymentId=${deploymentId ?? "missing"}`);
console.log(`experimentId=${experimentId ?? "missing"}`);
console.log(`wrote=${wrote}`);
await prisma.$disconnect();
