export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { sendDailyInfrastructureSlackReport } from "@/lib/infrastructureSlackReport";
import {
  ensureSlackTemplatesSeeded,
  getManagedSlackTemplates,
  sendManagedSlackMessage,
} from "@/lib/managedSlack";
import { prisma } from "@/lib/prisma";
import { getProviderHealthDashboard } from "@/lib/providerMonitoring";
import { sendDailyProviderUsageSlackReport } from "@/lib/providerDailyUsageReport";
import {
  invalidTemplatePlaceholders,
  SLACK_TEMPLATE_KEYS,
} from "@/lib/slackMessageTemplateCore";

const templateKeySchema = z.enum(SLACK_TEMPLATE_KEYS);
const updateSchema = z
  .object({
    key: templateKeySchema,
    enabled: z.boolean(),
    titleTemplate: z.string().trim().min(1).max(240),
    bodyTemplate: z.string().trim().min(1).max(2_800),
  })
  .strict();
const testSchema = z.object({ key: templateKeySchema }).strict();

const adminSession = async () => {
  const session = await getServerSession(authOptions);
  return session?.user?.id && isAdminSession(session) ? session : null;
};

export async function GET(req: Request) {
  try {
    const session = await adminSession();
    if (!session) return NextResponse.json({ error: "Not found." }, { status: 404 });
    await consumeApiRateLimit(req, session.user.id!, "admin-slack-template-read", {
      minute: 30,
      day: 500,
    });
    return NextResponse.json({
      templates: await getManagedSlackTemplates(),
      webhookConfiguredByTemplate: {
        infrastructure_daily: Boolean(
          process.env.INFRASTRUCTURE_SLACK_WEBHOOK_URL ||
            process.env.SLACK_WEBHOOK_URL
        ),
        provider_usage_daily: Boolean(
          process.env.PROVIDER_USAGE_SLACK_WEBHOOK_URL ||
            process.env.SLACK_WEBHOOK_URL
        ),
        provider_model_catalog_daily: Boolean(
          process.env.PROVIDER_MODEL_CATALOG_SLACK_WEBHOOK_URL ||
            process.env.OPS_ALERT_SLACK_WEBHOOK_URL ||
            process.env.SLACK_WEBHOOK_URL
        ),
        provider_alert: Boolean(process.env.SLACK_WEBHOOK_URL),
      },
      schedule: {
        cron: "0 0 * * * / 30 0 * * *",
        localTime: "10:00 / 10:30 Australia/Brisbane",
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load Slack templates:", error);
    return NextResponse.json(
      { error: "Failed to load Slack templates." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await adminSession();
    if (!session) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id!, "admin-slack-template-write", {
      minute: 12,
      day: 120,
    });
    const body = await readLimitedJson(req, 8 * 1024, updateSchema);
    const invalid = invalidTemplatePlaceholders(
      body.key,
      body.titleTemplate,
      body.bodyTemplate
    );
    if (invalid.length) {
      return NextResponse.json(
        { error: `Unsupported placeholders: ${invalid.join(", ")}` },
        { status: 400 }
      );
    }
    await ensureSlackTemplatesSeeded();
    const template = await prisma.adminSlackTemplate.update({
      where: { key: body.key },
      data: {
        enabled: body.enabled,
        titleTemplate: body.titleTemplate,
        bodyTemplate: body.bodyTemplate,
        updatedById: session.user.id,
        updatedByEmail: session.user.email || null,
      },
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "slack_template.updated",
      targetType: "AdminSlackTemplate",
      targetId: template.key,
      summary: `Updated Slack template ${template.name}.`,
      metadata: { enabled: template.enabled },
    });
    return NextResponse.json({ template });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update Slack template:", error);
    return NextResponse.json(
      { error: "Failed to update Slack template. Run database migrations first." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await adminSession();
    if (!session) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id!, "admin-slack-template-test", {
      minute: 6,
      day: 50,
    });
    const body = await readLimitedJson(req, 2 * 1024, testSchema);
    const result =
      body.key === "infrastructure_daily"
        ? await sendDailyInfrastructureSlackReport({ test: true })
        : body.key === "provider_usage_daily"
          ? await sendDailyProviderUsageSlackReport({
              date: new Date().toISOString().slice(0, 10),
              results: [],
              dashboard: await getProviderHealthDashboard(),
              test: true,
            })
          : body.key === "provider_model_catalog_daily"
            ? await sendManagedSlackMessage({
                key: "provider_model_catalog_daily",
                variables: {
                  localDate: new Intl.DateTimeFormat("en-AU", {
                    dateStyle: "medium",
                    timeZone: "Australia/Brisbane",
                  }).format(new Date()),
                  summary:
                    "*Summary* · checked 11/11 · lifecycle warnings 1 · catalog missing 1 · new candidates 2",
                  lifecycleRows:
                    "*Lifecycle warning*\n• Google Gemini `gemini-example`: legacy",
                  missingRows:
                    "*Missing from successful provider catalogs*\n• Google Gemini `gemini-example-old`: successful catalog scans missing ×2",
                  candidateRows:
                    "*New model candidates found today*\n• OpenAI `gpt-example-new`\n• Anthropic `claude-example-new`",
                  providerFailures: "*Provider checks not completed*\nNone",
                  generatedAt: new Date().toISOString(),
                },
                webhookUrl:
                  process.env.PROVIDER_MODEL_CATALOG_SLACK_WEBHOOK_URL ||
                  process.env.OPS_ALERT_SLACK_WEBHOOK_URL ||
                  process.env.SLACK_WEBHOOK_URL,
                targetType: "SlackTemplateTest",
                targetId: body.key,
                test: true,
              })
          : await sendManagedSlackMessage({
              key: "provider_alert",
              variables: {
                title: "Provider alert delivery test",
                provider: "Test provider",
                detail:
                  "This message verifies the managed provider incident Slack template and webhook.",
              },
              webhookUrl: process.env.SLACK_WEBHOOK_URL,
              targetType: "SlackTemplateTest",
              targetId: body.key,
              test: true,
            });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "slack_template.tested",
      targetType: "AdminSlackTemplate",
      targetId: body.key,
      summary: `Tested Slack template ${body.key} with status ${result.status}.`,
      metadata: { status: result.status },
    });
    const status = result.status === "sent" ? 200 : 503;
    return NextResponse.json({ result }, { status });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Slack template test failed:", error);
    return NextResponse.json({ error: "Slack template test failed." }, { status: 500 });
  }
}
