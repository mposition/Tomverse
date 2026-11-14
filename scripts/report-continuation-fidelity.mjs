import { CONTINUATION_FIDELITY_CASES, FIDELITY_ARMS } from "../lib/continuationFidelityCases.ts";
import { continuationFidelityProbe, CONTINUATION_FIDELITY_VERSION } from "../lib/continuationFidelityProbe.ts";

const results = CONTINUATION_FIDELITY_CASES.flatMap(fixture => FIDELITY_ARMS.map(arm => {
    const probe = continuationFidelityProbe(fixture, arm);
    return { id: probe.id, locale: probe.locale, domain: probe.domain, arm, promptDigest: probe.promptDigest,
        bodyTokens: probe.plan.estimatedTokens, coverage: probe.coverage, expectedCoverage: probe.expectedCoverage,
        expectedVisible: probe.expectedVisible, gold: probe.gold, inputMatchesDeclaration: probe.inputMatchesDeclaration };
}));
console.log(JSON.stringify({ version: CONTINUATION_FIDELITY_VERSION, cases: CONTINUATION_FIDELITY_CASES.length,
    modelCalls: 0, answerQuality: "not_evaluated", results }, null, 2));
if (results.some(result => !result.inputMatchesDeclaration)) process.exitCode = 1;
