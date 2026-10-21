import { readFile } from "node:fs/promises";
import { BASELINE } from "./runner";
import { digest, proposalSchema, snapshot, type ModelAdapter, type ModelRequest } from "./schema";

export async function loadFixtures() {
  const read = async (name: string) =>
    JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
  return { development: await read("development"), validation: await read("validation") };
}
type ScriptedCase = {
  baseline: { extract: unknown; select: unknown };
  improved: { extract: unknown; select: unknown };
  judgements: Record<string, {
    supported: boolean; safety: string; reason: string;
    relations: { goldId: string; relation: string }[];
  }>;
};
/** Scripted model test double. No semantic rules, gold lookup, SDK or network. */
export async function createScriptedAdapters(): Promise<{ model: ModelAdapter; judge: ModelAdapter; mode: "mock" }> {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/mock-responses.json", import.meta.url), "utf8"));
  const proposal = proposalSchema.parse(fixture.proposal);
  const scripts: Record<string, ScriptedCase> = fixture.cases;
  const model: ModelAdapter = async (request) => {
    if (request.task === "propose") return snapshot(proposal);
    const input = request.input as { caseId: string };
    const script = scripts[input.caseId];
    if (!script) throw new Error("mock_case_missing");
    const baseline = request.task === "extract" ? request.system.endsWith(BASELINE.extraction)
      : request.system.startsWith(BASELINE.retrieval);
    const known = request.task === "extract" ? request.system.endsWith(proposal.candidate.extraction)
      : request.system.startsWith(proposal.candidate.retrieval);
    if (!baseline && !known) throw new Error("mock_candidate_missing");
    if (request.task !== "extract" && request.task !== "select") throw new Error("mock_task_missing");
    return snapshot(script[baseline ? "baseline" : "improved"][request.task]);
  };
  const judge: ModelAdapter = async (request) => {
    if (request.task !== "judge") throw new Error("mock_judge_task");
    const input = request.input as { caseId: string; candidates: { statement: string }[] };
    const script = scripts[input.caseId];
    if (!script) throw new Error("mock_case_missing");
    return { candidates: input.candidates.map((candidate, index) => {
      const annotation = script.judgements[candidate.statement];
      if (!annotation) throw new Error("mock_judgement_missing");
      return { index, ...snapshot(annotation) };
    }) };
  };
  return { model, judge, mode: "mock" };
}

export type ReplayEntry = { requestDigest: string; output: unknown };
/** An approved host can supply archived structured outputs without a new paid run. */
export function createReplayAdapter(entries: ReplayEntry[]): ModelAdapter {
  const map = new Map(entries.map((entry) => [entry.requestDigest, entry.output]));
  if (map.size !== entries.length || entries.some((entry) => !/^[a-f0-9]{64}$/.test(entry.requestDigest))) {
    throw new Error("invalid_replay");
  }
  return async (request: ModelRequest) => {
    const key = digest(request);
    if (!map.has(key)) throw new Error("replay_request_missing");
    return snapshot(map.get(key));
  };
}
