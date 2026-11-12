import { SUPPORTED_LANGUAGES } from "./language.ts";
/** No browser, user transcripts or model credentials on the walker. An unknown POST is never replayed. */
export async function walkMemoryProbes(day, post) {
  const offset =
    Math.floor(Date.parse(day + "T00:00:00Z") / 86400000) %
    SUPPORTED_LANGUAGES.length;
  const locales = [
    ...SUPPORTED_LANGUAGES.slice(offset),
    ...SUPPORTED_LANGUAGES.slice(0, offset),
  ];
  const results = [];
  const ask = async (target) => {
    try {
      const answer = await post(target);
      results.push(answer);
      return answer;
    } catch {
      const answer = { judged: false, reason: "outcome_unknown" };
      results.push(answer);
      return answer;
    }
  };
  const stop = (r) =>
    r.disabled ||
    ["daily_cap_reached", "model_off", "day_changed"].includes(r.reason);
  // A disabled app costs one read, never eight. Limit subsequent in-flight reservations to two.
  if (stop(await ask(locales[0]))) return results;
  for (let i = 1; i < locales.length; i += 2) {
    if ((await Promise.all(locales.slice(i, i + 2).map(ask))).some(stop))
      return results;
  }
  await ask("ideas");
  return results;
}
