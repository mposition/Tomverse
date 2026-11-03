#!/usr/bin/env node
// Zernio webhook registration (docs/ops/marketing-webhook-production-activation.md).
//
//   status                      list the registered webhooks (secret never printed)
//   logs --url <receiver>       recent deliveries to one receiver, no payload
//   create --url <receiver> --account-id <id>... [--name <n>] [--execute]
//
// Run it through Railway so the environment supplies ZERNIO_API_KEY and the
// signing secret of the receiver it registers:
//
//   railway run -e production -s Tomverse -- node scripts/marketing/zernio-webhook-setup.mjs create ...
//
// `create` is a dry run: it prints the request it would send (the secret as
// "<from ZERNIO_WEBHOOK_SECRET>") and every reason it would refuse. Only
// `--execute` together with `--confirm-url <the same url>` sends it. Everything
// else is a GET. The key and the secret are never printed.

import { pathToFileURL } from "node:url";

import {
  planWebhookCreate,
  redactWebhook,
  summariseDeliveries,
} from "./webhook-activation-core.mjs";

const BASE = "https://zernio.com/api/v1";

const call = async (key, method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
};

const normaliseAccount = (account) => ({
  id: account._id ?? account.id,
  platform: account.platform,
  profileId: typeof account.profileId === "object" ? account.profileId?._id : account.profileId,
});

export async function main(argv, env = process.env) {
  const [command = "status", ...rest] = argv;
  const flag = (name) => rest.flatMap((arg, index) => (arg === `--${name}` && rest[index + 1] ? [rest[index + 1]] : []));
  const key = env.ZERNIO_API_KEY?.trim();
  if (!key) {
    console.error("ZERNIO_API_KEY is not set in this environment.");
    return 1;
  }

  if (command === "status") {
    const { status, json } = await call(key, "GET", "/webhooks/settings");
    if (status !== 200) {
      console.error(`GET /webhooks/settings answered ${status}.`);
      return 1;
    }
    for (const webhook of json?.webhooks ?? []) console.log(JSON.stringify(redactWebhook(webhook)));
    return 0;
  }

  if (command === "logs") {
    const [url] = flag("url");
    if (!url) {
      console.error("--url is required.");
      return 64;
    }
    const { status, json } = await call(key, "GET", "/webhooks/logs?limit=100");
    if (status !== 200) {
      console.error(`GET /webhooks/logs answered ${status}.`);
      return 1;
    }
    for (const row of summariseDeliveries(json?.logs ?? [], url)) console.log(JSON.stringify(row));
    return 0;
  }

  if (command === "create") {
    const [url] = flag("url");
    const [name] = flag("name");
    const accountIds = flag("account-id");
    const execute = rest.includes("--execute");
    const [confirmUrl] = flag("confirm-url");
    if (!url) {
      console.error("--url is required.");
      return 64;
    }
    const [settings, accounts] = await Promise.all([
      call(key, "GET", "/webhooks/settings"),
      call(key, "GET", "/accounts"),
    ]);
    if (settings.status !== 200 || accounts.status !== 200) {
      console.error(`Reading Zernio failed (settings ${settings.status}, accounts ${accounts.status}).`);
      return 1;
    }
    const list = Array.isArray(accounts.json) ? accounts.json : (accounts.json?.accounts ?? accounts.json?.data ?? []);
    const plan = planWebhookCreate({
      url,
      name,
      accountIds,
      accounts: list.map(normaliseAccount),
      existing: settings.json?.webhooks ?? [],
      env,
    });
    console.log(
      JSON.stringify({ wouldSend: { ...plan.body, secret: "<from ZERNIO_WEBHOOK_SECRET>" }, problems: plan.problems }, null, 2),
    );
    if (plan.problems.length > 0) {
      console.error("Refused: nothing was sent.");
      return 2;
    }
    if (!execute) {
      console.log("Dry run. Add --execute --confirm-url <the same url> to register it.");
      return 0;
    }
    if (confirmUrl !== plan.body.url) {
      console.error("--confirm-url must equal --url exactly.");
      return 64;
    }
    const created = await call(key, "POST", "/webhooks/settings", { ...plan.body, secret: env.ZERNIO_WEBHOOK_SECRET });
    if (created.status !== 200 || !created.json?.webhook) {
      // Zernio's own reason, e.g. "A profile-scoped API key cannot manage
      // webhooks" (403): without it a refusal reads like a transient failure.
      const reason = created.json?.error ? ` (${created.json.code ?? "error"}: ${created.json.error})` : "";
      console.error(`Zernio answered ${created.status}${reason}; check with the status command before retrying.`);
      return 1;
    }
    console.log(JSON.stringify(redactWebhook(created.json.webhook)));
    return 0;
  }

  console.error(`Unknown command ${command}. Use status, logs or create.`);
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
