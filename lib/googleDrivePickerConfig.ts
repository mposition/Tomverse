import "server-only";

export function readGooglePickerConfig() {
  const clientId = process.env.GOOGLE_ID;
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
  const appId = process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER;
  return clientId && apiKey && appId ? { clientId, apiKey, appId } : null;
}
