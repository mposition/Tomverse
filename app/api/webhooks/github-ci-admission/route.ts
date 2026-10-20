export const dynamic = "force-dynamic";
// The signature covers the raw bytes; verifying it needs node:crypto and a body
// that has not been through a parse and a re-serialise.
export const runtime = "nodejs";

import { NextResponse } from "next/server";

import { CI_ADMISSION_REPOSITORY } from "@/lib/ciAdmissionGithub";
import { ciAdmissionArrival, verifyCiAdmissionWebhookSignature } from "@/lib/ciAdmissionWebhookCore";
import { ciAdmissionMode, runCiAdmissionRound } from "@/lib/ciAdmissionService";

/**
 * GitHub's webhook for CI admission (lib/ciAdmissionCore.ts): pull_request and
 * workflow_run events from the CI admission GitHub App. Off (the default) it
 * answers 404 and reads nothing. Every delivery must carry a valid
 * X-Hub-Signature-256 for `CI_ADMISSION_WEBHOOK_SECRET`, which is read here and
 * nowhere else.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request) {
  if (ciAdmissionMode() === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  if (!verifyCiAdmissionWebhookSignature(body, request.headers.get("x-hub-signature-256"), process.env.CI_ADMISSION_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const event = request.headers.get("x-github-event") ?? "";
  const decision = ciAdmissionArrival(event, payload, CI_ADMISSION_REPOSITORY);
  if (decision.kind === "ignore") return NextResponse.json({ ignored: decision.reason }, { status: 202 });

  try {
    const outcome = await runCiAdmissionRound(decision.arrival);
    return NextResponse.json(outcome);
  } catch (error) {
    console.error("CI admission round failed:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Round failed." }, { status: 500 });
  }
}
