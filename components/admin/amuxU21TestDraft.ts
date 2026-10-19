/** A fresh synthetic backlog-card draft. Preview and registration still require
 * separate owner actions and server-side validation. */
export function createAmuxU21TestDraft(id: string): string {
  return JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 1,
    explicitRegistration: true,
    sourceTaskId: `u21-test-${id}`,
    workItem: null,
    proposal: {
      title: "Disposable U21 public candidate test card",
      scope: "One isolated public candidate author test card",
      completion: "A public candidate receipt is recorded",
      priority: "p3",
    },
  }, null, 2);
}
