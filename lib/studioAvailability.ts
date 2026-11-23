import "server-only";

export function studioAvailable(): boolean {
  return process.env.NODE_ENV === "development" || process.env.STUDIO_ENABLED === "true";
}
