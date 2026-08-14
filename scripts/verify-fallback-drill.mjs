// Reads what a staging fallback drill left behind, and judges it.
//
//   node scripts/verify-fallback-drill.mjs --trace <traceId> \
//       --scenario fallback_succeeds --subject <subjectKey> [--log <file>]
//
// The judgement lives in verify-fallback-drill-core.mjs and is unit-tested;
// this file only fetches rows and prints. Run it against the staging database
// (DATABASE_URL), not production -- it reads nothing it should not, but a
// drill's rows are only in the environment the drill ran in.

import { readFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { DRILL_SCENARIOS, auditFallbackDrill } from "./verify-fallback-drill-core.mjs";

const argument = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
};

const traceId = argument("trace");
const scenario = argument("scenario") ?? "fallback_succeeds";
const subjectKey = argument("subject");
const logFile = argument("log");

if (!traceId) {
    console.error(
        "Usage: node scripts/verify-fallback-drill.mjs --trace <traceId> " +
            `--scenario <${Object.keys(DRILL_SCENARIOS).join("|")}> ` +
            "--subject <subjectKey> [--log <file>]\n\n" +
            "The traceId is the X-Request-ID header the drill request came back with."
    );
    process.exit(2);
}

const prisma = new PrismaClient();

try {
    const runs = await prisma.routingRun.findMany({
        where: { traceId },
        include: {
            routingAttempts: {
                include: { manifest: true },
                orderBy: { attemptIndex: "asc" },
            },
        },
    });
    const reservations = await prisma.chatCreditReservation.findMany({
        where: { traceId },
        include: { attemptUsage: true },
    });

    // A released lease is deleted, and the row carries no traceId -- so this
    // asks whether any lease survives for the drill's subject. It is only
    // meaningful if the drill was the only request for that subject, which is
    // why the runbook asks for a dedicated account.
    const leases = subjectKey
        ? await prisma.chatRequestLease.findMany({ where: { subjectKey } })
        : [];
    if (!subjectKey) {
        console.warn(
            "No --subject given, so the lease-release check cannot run. " +
                "Pass the drill account's subjectKey to include it."
        );
    }

    const logs = logFile
        ? readFileSync(logFile, "utf8").split("\n").filter(Boolean)
        : [];
    if (!logFile) {
        console.warn(
            "No --log given, so the log checks cannot run. Pipe the request's " +
                "server logs to a file and pass it to include them."
        );
    }

    const observed = {
        runs,
        reservations,
        attempts: runs.flatMap((run) => run.routingAttempts),
        manifests: runs.flatMap((run) =>
            run.routingAttempts.map((attempt) => attempt.manifest).filter(Boolean)
        ),
        attemptUsage: reservations.flatMap((row) => row.attemptUsage),
        leases,
        logs,
    };

    const { passed, checks } = auditFallbackDrill(observed, scenario);

    console.log(`\nFallback drill — trace ${traceId}, scenario ${scenario}\n`);
    for (const check of checks) {
        console.log(`  ${check.ok ? "ok  " : "FAIL"}  ${check.message}`);
    }
    console.log(
        `\n${passed ? "PASSED" : "FAILED"}: ${checks.filter((c) => c.ok).length}/${checks.length} checks\n`
    );

    if (passed) {
        // The numbers an operator writes into the drill report, so the record
        // is the run's own figures rather than a transcription.
        const usage = observed.attemptUsage
            .map(
                (row) =>
                    `    attempt ${row.attemptIndex}: ${row.modelId} (${row.provider}), ` +
                    `${row.costMicroUsd} µUSD${row.userBilled ? ", billed to the user" : ""}`
            )
            .join("\n");
        if (usage) console.log(`  Attempt costs:\n${usage}\n`);
    }

    process.exit(passed ? 0 : 1);
} finally {
    await prisma.$disconnect();
}
