export const dynamic = "force-dynamic";
// The signature covers the raw bytes; verifying it needs node:crypto and a body
// that has not been through a parse and a re-serialise.
export const runtime = "nodejs";

import { NextResponse } from "next/server";

import { CI_ADMISSION_REPOSITORY } from "@/lib/ciAdmissionGithub";
import { ciAdmissionArrival, verifyCiAdmissionWebhookSignature } from "@/lib/ciAdmissionWebhookCore";
import { ciAdmissionMode, requestCiAdmissionRound } from "@/lib/ciAdmissionService";

/**
 * GitHub's webhook for CI admission (lib/ciAdmissionCore.ts): pull_request and
 * workflow_run events from the CI admission GitHub App. Off (the default) it
 * answers 404 and reads nothing. Every delivery must carry a valid
 * X-Hub-Signature-256 for `CI_ADMISSION_WEBHOOK_SECRET`, which is read here and
 * nowhere else. A delivery is answered at once (202) and asks for a round,
 * which runs after the answer, coalesced.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The body as text, or null as soon as it passes `max` bytes: an unsigned body is never buffered whole. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request) {
  if (ciAdmissionMode() === "off") return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Refuse a declared oversize body before reading it; the length check after
  // reading still covers a body sent without a length.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const body = await readCapped(request, MAX_BODY_BYTES);
  if (body === null) return NextResponse.json({ error: "Too large." }, { status: 413 });
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

  // Answer within GitHub's ten seconds: ask for a round and return. The round
  // reads the whole line from GitHub after the answer, so no delivery carries
  // anything that could be lost.
  requestCiAdmissionRound();
  return NextResponse.json({ accepted: true, arrival: decision.arrival }, { status: 202 });
}
