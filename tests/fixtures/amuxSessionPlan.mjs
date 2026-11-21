/** A session-written plan in the session analysis answer format: the page
 * header is derived by the app, so only the decision, scope and units appear. */
const signal = (metrics) => ({ metrics, uncertainty: "low",
  rationale: "The operator asked for it.", evidenceRefIds: ["operator_idea"] });

export function amuxSessionPlanFixture(overrides = {}) {
  return {
    outcome: "propose",
    coverageStatus: "complete",
    coveredScope: "A settings toggle for dark mode.",
    units: [
      { kind: "node", localId: "c0:node-0", level: "initiative", parentRef: null,
        title: "Appearance", description: "Visual preferences.",
        sourceRefIds: ["operator_idea"], portfolioSignal: signal({ value: 2 }) },
      { kind: "node", localId: "c0:node-1", level: "epic", parentRef: "c0:node-0",
        title: "Theme", description: "Theme selection.",
        sourceRefIds: ["operator_idea"], portfolioSignal: signal({ value: 2 }) },
      { kind: "node", localId: "c0:node-2", level: "feature", parentRef: "c0:node-1",
        title: "Dark mode toggle", description: "A toggle in settings.",
        sourceRefIds: ["operator_idea"], displayPrefix: "DARK",
        portfolioSignal: signal({ value: 2 }) },
      { kind: "card", localId: "c0:card-0", cardType: "task", storyKind: null,
        title: "Add the toggle", problem: "No dark mode toggle exists.",
        scopeIn: ["Add a toggle"], scopeOut: ["No new themes"],
        completionCriteria: ["The toggle switches the theme"], featureRef: "c0:node-2",
        parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
        taskRole: "implement", executionGrade: "routine",
        executionBrief: "Read the settings page, then add the toggle.",
        expectedPaths: ["components/settings/AppearanceSettings.tsx"],
        sourceRefIds: ["operator_idea"],
        portfolioSignal: signal({ contribution: 2, urgency: 1, dependencyUnlock: 0,
          workerCoverage: 3, effort: 1, deliveryRisk: 1 }) },
    ],
    ...overrides,
  };
}
