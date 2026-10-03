/**
 * The secrets and keys whose rotation time the QA-release operator control
 * record carries (docs/policy/qa-release-agent.md section 6): every secret and
 * key of the agent, by name -- never a value. Pure, so the Admin form and the
 * server-only writer share one list.
 */
export const QA_RELEASE_SECRET_ROTATION_FIELDS = [
  "digestSecretRotatedAt",
  "monitorSecretRotatedAt",
  "mergeLaneSecretRotatedAt",
  "githubAppKeyRotatedAt",
  "railwayTokenRotatedAt",
  "githubReadTokenRotatedAt",
] as const;

export type QaReleaseSecretRotationField = (typeof QA_RELEASE_SECRET_ROTATION_FIELDS)[number];
