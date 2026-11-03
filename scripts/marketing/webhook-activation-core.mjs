// Pure decisions for the Zernio webhook activation tools (docs/ops/marketing-webhook-production-activation.md).
//
// No network, no database, no environment read: the CLIs supply every live
// value, and the tests drive these functions directly. The rules here exist so
// a registration cannot send one environment's signing secret to the other
// environment's receiver, and so a webhook is never created without an account
// filter (Zernio treats an empty filter as "every profile's events").

/** Written out, not imported: the test holds this equal to MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES. */
export const ZERNIO_WEBHOOK_EVENTS = [
  "post.published",
  "post.failed",
  "post.partial",
  "post.cancelled",
  "post.platform.published",
  "post.platform.failed",
  "post.platform.deleted",
];

export const RECEIVER_PATH = "/api/webhooks/zernio";

/** The only receivers a registration may name, and the environment whose secret each one verifies with. */
export const RECEIVER_HOSTS = {
  "tomverse.app": "production",
  "staging.tomverse.app": "staging",
};

const ACCOUNT_ID = /^[0-9a-f]{24}$/;
const CHANNEL_ID = /^[a-z0-9]{20,32}$/;

/** `{ ok: true, environment }` for an https receiver URL on an allowed host, else the reason. */
export const checkReceiverUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "url_invalid" };
  }
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "" || url.username !== "") {
    return { ok: false, reason: "url_not_plain_https" };
  }
  if (url.pathname !== RECEIVER_PATH) return { ok: false, reason: "url_path_not_receiver" };
  const environment = RECEIVER_HOSTS[url.hostname];
  if (!environment || url.port !== "") return { ok: false, reason: "url_host_not_allowed" };
  return { ok: true, environment, url: url.toString() };
};

/** The environment a process says it runs in, the way the receiver reads the explicit label. */
export const declaredEnvironment = (env) => {
  const label = (env.APP_ENV ?? env.RAILWAY_ENVIRONMENT_NAME ?? "").trim().toLowerCase();
  return label === "production" || label === "staging" ? label : "unlabelled";
};

/** A webhook as it may be printed: the secret and header values never leave this function. */
export const redactWebhook = (webhook) => ({
  id: webhook._id ?? webhook.id ?? null,
  name: webhook.name ?? null,
  url: webhook.url ?? null,
  isActive: webhook.isActive ?? null,
  events: [...(webhook.events ?? [])].sort(),
  profileIds: [...(webhook.profileIds ?? [])],
  accountIds: [...(webhook.accountIds ?? [])].sort(),
  failureCount: webhook.failureCount ?? null,
  lastFiredAt: webhook.lastFiredAt ?? null,
  hasSecret: Boolean(webhook.secret),
});

/**
 * What a create would do, and every reason it must not. Nothing here is sent.
 *
 * `accounts` is Zernio's own account list (id, profile). An account id it does
 * not list, or an empty list, refuses: an unfiltered webhook would also receive
 * the other environment's accounts.
 */
export const planWebhookCreate = ({ url, name, accountIds, accounts, existing, env }) => {
  const problems = [];
  const checked = checkReceiverUrl(url);
  if (!checked.ok) problems.push(checked.reason);

  const declared = declaredEnvironment(env);
  if (checked.ok && declared !== checked.environment) {
    problems.push(`environment_mismatch:url_is_${checked.environment}_process_is_${declared}`);
  }
  const secret = env.ZERNIO_WEBHOOK_SECRET;
  if (typeof secret !== "string" || secret.trim().length < 32) problems.push("webhook_secret_missing_or_short");

  const ids = [...new Set(accountIds)];
  if (ids.length === 0) problems.push("account_ids_required");
  for (const id of ids) {
    if (!ACCOUNT_ID.test(id)) problems.push(`account_id_malformed:${id}`);
  }
  const known = new Map(accounts.map((account) => [account.id, account]));
  for (const id of ids) {
    if (ACCOUNT_ID.test(id) && !known.has(id)) problems.push(`account_unknown_to_zernio:${id}`);
  }
  // A scoped webhook per profile; mixed profiles would need two reviews of the same filter.
  const profileIds = [...new Set(ids.flatMap((id) => (known.get(id)?.profileId ? [known.get(id).profileId] : [])))];

  if (checked.ok && existing.some((webhook) => webhook.url === checked.url)) {
    problems.push("webhook_for_this_url_already_exists");
  }

  const body = {
    name: String(name ?? "").trim() || `tomverse-${checked.ok ? checked.environment : "unknown"}`,
    url: checked.ok ? checked.url : url,
    events: [...ZERNIO_WEBHOOK_EVENTS],
    isActive: true,
    profileIds,
    accountIds: ids,
  };
  if (body.name.length > 50) problems.push("name_too_long");
  return { problems, body };
};

/** One line per recent delivery to `url`, from Zernio's log rows. No payload, no header. */
export const summariseDeliveries = (logs, url) =>
  logs
    .filter((log) => log.url === url)
    .map((log) => {
      let answer = null;
      try {
        answer = JSON.parse(log.responseBody ?? "");
      } catch {
        answer = null;
      }
      return {
        at: log.createdAt ?? null,
        event: log.event ?? null,
        eventId: log.eventId ?? null,
        http: log.statusCode ?? null,
        answer: typeof answer?.status === "string" ? answer.status : typeof answer?.code === "string" ? answer.code : null,
        pipeline: typeof answer?.pipeline === "string" ? answer.pipeline.slice(0, 8) : null,
      };
    });

// ---------------------------------------------------------------------------
// Test DB channel mirror
// ---------------------------------------------------------------------------

const SLUG = /^[a-z]+-[0-9]{1,3}$/;
const MIRRORABLE = new Set(["instagram", "facebook", "youtube", "linkedin", "threads", "tiktok", "x", "rednote"]);

/**
 * A staging channel row that carries a production channel's id and Zernio
 * account, so staging observes events about that channel under the id a
 * production apply scope has to name (a verification record's pairs are
 * channel ids, and ids differ between databases).
 */
export const planChannelMirror = ({ channelId, channel, accountRef, slug, existingChannels, stagingLabelled }) => {
  const problems = [];
  if (!stagingLabelled) problems.push("not_staging");
  if (!CHANNEL_ID.test(channelId ?? "")) problems.push("channel_id_malformed");
  if (!MIRRORABLE.has(channel)) problems.push("channel_unknown");
  if (!ACCOUNT_ID.test(accountRef ?? "")) problems.push("account_ref_malformed");
  if (!SLUG.test(slug ?? "") || !String(slug).startsWith(`${channel}-`)) problems.push("slug_malformed");
  if (existingChannels.some((row) => row.id === channelId)) problems.push("channel_id_already_present");
  if (existingChannels.some((row) => row.accountSlug === slug)) problems.push("slug_already_present");
  if (existingChannels.some((row) => row.provider === "zernio" && row.externalAccountRef === accountRef)) {
    problems.push("account_already_bound_in_staging");
  }
  return {
    problems,
    row: {
      id: channelId,
      channel,
      provider: "zernio",
      externalAccountRef: accountRef,
      accountSlug: slug,
      defaultLocale: "en",
      allowedLocales: ["en"],
      policyVersion: 1,
    },
  };
};
