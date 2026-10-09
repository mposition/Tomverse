import { routingApplicationIdentity } from "@/lib/routingApplicationIdentity";

/** Read-only report scope. A deployment filter must supply the whole identity. */
export function routingShadowQuery(args: readonly string[], now = new Date()) {
  const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const days = Math.max(1, Number(flag("days")) || 30);
  const limit = Math.max(1, Math.floor(Number(flag("limit")) || 200_000));
  if (!Number.isFinite(days) || !Number.isSafeInteger(limit) || !Number.isSafeInteger(limit + 1)) {
    throw new Error("Invalid report window or limit");
  }
  const until = new Date(flag("until") ?? now);
  const since = new Date(flag("since") ?? (until.getTime() - days * 86_400_000));
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) ||
      since >= until || until > now) throw new Error("Report requires a valid closed observation window");
  const commit = flag("commit"), deployment = flag("deployment"), environment = flag("environment");
  const bound = commit !== undefined || deployment !== undefined || environment !== undefined;
  const identity = routingApplicationIdentity({ RAILWAY_GIT_COMMIT_SHA: commit,
    RAILWAY_DEPLOYMENT_ID: deployment, APP_ENV: environment });
  if (bound && !identity.applicationCommitSha) throw new Error("Supply full --commit, --deployment and --environment together");
  return { days, limit, since, until, identity: bound ? identity : null,
    measurementScope: bound ? "recorded_application_identity" : "historical_window_without_deployment_binding",
    where: { mode: "shadow", createdAt: { gte: since, lte: until }, ...(bound ? identity : {}) } };
}
