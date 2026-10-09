/**
 * Policy approval is not exact-deployment activation. Neither a browser mode
 * nor an AppSetting can replace the missing adapter/release attestations.
 */
export function promptRefinerChatExecutionRelease(): Readonly<{
  explicitEnabled: boolean;
  autoEnabled: boolean;
}> {
  return { explicitEnabled: false, autoEnabled: false };
}
