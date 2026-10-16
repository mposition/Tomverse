import type { AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";
import { isAmuxV20RegistrationRefusalGrade,
  type AmuxV20RegistrationRefusalIdentity,
  type AmuxV20TaskRegistrationRefusal } from
  "./ideaRegistrationRefusalCore.ts";
import { inspectAmuxV20TaskRegistration } from
  "./ideaUnitRegistrationCore.ts";
import type { AmuxExecutionGrade } from "./executionGradeCore.ts";

/** Carries only the identifiers and closed grades needed after a failed
 * registration transaction rolls back. The proposal and paths never cross
 * this boundary. */
export class AmuxV20RegistrationRefusalDetected extends Error {
  readonly proposedExecutionGrade: AmuxExecutionGrade | null;
  readonly finalExecutionGrade: AmuxExecutionGrade | null;

  constructor(readonly code: AmuxV20TaskRegistrationRefusal,
    readonly identity: AmuxV20RegistrationRefusalIdentity,
    proposal: AmuxAnalysisCard) {
    super(code);
    this.name = "AmuxV20RegistrationRefusalDetected";
    const grades = amuxV20RegistrationRefusalGrades(proposal);
    this.proposedExecutionGrade = grades.proposedExecutionGrade;
    this.finalExecutionGrade = grades.finalExecutionGrade;
  }
}

/** Only closed grade values may leave a rejected proposal. Paths, titles and
 * any malformed model value are deliberately discarded. */
export function amuxV20RegistrationRefusalGrades(proposal: AmuxAnalysisCard): {
  proposedExecutionGrade: AmuxExecutionGrade | null;
  finalExecutionGrade: AmuxExecutionGrade | null;
} {
  const proposedExecutionGrade = isAmuxV20RegistrationRefusalGrade(
    proposal.executionGrade) ? proposal.executionGrade : null;
  const inspected = inspectAmuxV20TaskRegistration(proposal);
  return { proposedExecutionGrade,
    finalExecutionGrade: inspected.ok ? inspected.executionGrade : null };
}
