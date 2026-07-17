import "server-only";

import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_SLACK_TEMPLATES,
  renderSlackTemplate,
  slackTemplateDefinition,
  type SlackTemplateKey,
} from "@/lib/slackMessageTemplateCore";

const seedRows = () =>
  DEFAULT_SLACK_TEMPLATES.map((template) => ({
    key: template.key,
    name: template.name,
    description: template.description,
    enabled: template.enabled,
    titleTemplate: template.titleTemplate,
    bodyTemplate: template.bodyTemplate,
  }));

let seedPromise: Promise<void> | null = null;
let didWarnMissingSchema = false;

export async function ensureSlackTemplatesSeeded() {
  if (!seedPromise) {
    seedPromise = prisma.adminSlackTemplate
      .createMany({ data: seedRows(), skipDuplicates: true })
      .then(() => undefined)
      .catch((error) => {
        seedPromise = null;
        throw error;
      });
  }
  await seedPromise;
}

export async function getManagedSlackTemplates() {
  try {
    await ensureSlackTemplatesSeeded();
    const rows = await prisma.adminSlackTemplate.findMany({
      orderBy: { createdAt: "asc" },
    });
    return DEFAULT_SLACK_TEMPLATES.map((definition) => {
      const row = rows.find((candidate) => candidate.key === definition.key);
      return {
        ...definition,
        ...(row
          ? {
              name: row.name,
              description: row.description,
              enabled: row.enabled,
              titleTemplate: row.titleTemplate,
              bodyTemplate: row.bodyTemplate,
              updatedAt: row.updatedAt.toISOString(),
            }
          : {}),
        persisted: Boolean(row),
      };
    });
  } catch (error) {
    if (!isMissingDatabaseSchemaError(error)) throw error;
    if (!didWarnMissingSchema) {
      didWarnMissingSchema = true;
      console.warn(
        "Slack template schema is not migrated yet; using built-in templates."
      );
    }
    return DEFAULT_SLACK_TEMPLATES.map((template) => ({
      ...template,
      persisted: false,
    }));
  }
}

const recordSlackNotification = async (input: {
  title: string;
  detail: string;
  status: "sent" | "failed" | "skipped";
  targetType: string;
  targetId: string;
  error?: string;
}) => {
  await prisma.adminNotificationLog
    .create({
      data: {
        channel: "slack",
        title: input.title.slice(0, 300),
        detail: input.detail.slice(0, 5_000),
        status: input.status,
        targetType: input.targetType,
        targetId: input.targetId,
        error: input.error?.slice(0, 1_000) || null,
      },
    })
    .catch((error) => {
      console.error("Slack notification log write failed:", error);
    });
};

export async function sendManagedSlackMessage(input: {
  key: SlackTemplateKey;
  variables: Record<string, string | number>;
  webhookUrl?: string;
  targetType: string;
  targetId: string;
  test?: boolean;
}) {
  const templates = await getManagedSlackTemplates();
  const template =
    templates.find((candidate) => candidate.key === input.key) ||
    slackTemplateDefinition(input.key);
  const title = `${input.test ? "[TEST] " : ""}${renderSlackTemplate(
    template.titleTemplate,
    input.variables
  )}`.slice(0, 240);
  const detail = renderSlackTemplate(
    template.bodyTemplate,
    input.variables
  ).slice(0, 2_800);

  if (!template.enabled && !input.test) {
    await recordSlackNotification({
      title,
      detail,
      status: "skipped",
      targetType: input.targetType,
      targetId: input.targetId,
      error: "Slack template is disabled.",
    });
    return { delivered: false, status: "skipped" as const, title };
  }

  if (!input.webhookUrl) {
    await recordSlackNotification({
      title,
      detail,
      status: "skipped",
      targetType: input.targetType,
      targetId: input.targetId,
      error: "Slack webhook URL is not configured.",
    });
    return {
      delivered: false,
      status: "skipped" as const,
      title,
      error: "Slack webhook URL is not configured.",
    };
  }

  try {
    const target = new URL(input.webhookUrl);
    if (target.protocol !== "https:") {
      throw new Error("Slack webhook URL must use HTTPS.");
    }
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${title}\n${detail}`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*${title}*\n${detail}` },
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Slack webhook returned ${response.status}.`);
    }
    await recordSlackNotification({
      title,
      detail,
      status: "sent",
      targetType: input.targetType,
      targetId: input.targetId,
    });
    return { delivered: true, status: "sent" as const, title };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Slack delivery failed.";
    await recordSlackNotification({
      title,
      detail,
      status: "failed",
      targetType: input.targetType,
      targetId: input.targetId,
      error: message,
    });
    return {
      delivered: false,
      status: "failed" as const,
      title,
      error: message,
    };
  }
}
