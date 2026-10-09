/** A diagnostic, never an authorization to enable a stage. The full live
 * contract also needs owner approval, independent review and runtime proof. */
export type AmuxActivationGate = { id: string; codeLatch: boolean | null;
  environmentEnabled: boolean | null };
export type AmuxActivationStage = { id: string; gates: AmuxActivationGate[] };

export function inspectAmuxActivationStages(stages: AmuxActivationStage[]) {
  return stages.map((stage) => {
    const blocked = stage.gates.some((gate) =>
      gate.codeLatch === false || gate.environmentEnabled === false);
    const unknown = stage.gates.some((gate) =>
      gate.codeLatch === null || gate.environmentEnabled === null);
    return { ...stage, status: blocked ? "closed" as const :
      unknown ? "unverified" as const : "owner_evidence_required" as const,
      activationAuthorized: false as const };
  });
}
