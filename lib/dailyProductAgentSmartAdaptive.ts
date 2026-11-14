import "server-only";
import type { Prisma } from "@prisma/client";
import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { DAILY_PRODUCT_AGENT_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";
import { OPTIMIZER_LOCK } from "@/lib/autoRouterOptimizerLock";
import { readChatPresearchLatency } from "@/lib/chatPresearchLatency";
import { prisma } from "@/lib/prisma";

const settingPrefix = "auto.smartAdaptiveDaily.";
const latestKey = settingPrefix + "latest";
const dayMs = 86_400_000;
const targetMs = 10_000;

// Public browser QA performed with all three experimental switches off.
// This is historical evidence, separate from the live aggregate. The first
// daily run hands over the outstanding fixture once, including on a quiet day.
const qaFollowup = {
  key: "2026-11-14-himeji-official-decision",
  text: "히메지성 공식 등재 결정문을 요청한 공개 질문으로 후속 호출의 근거가 중복인지 검증하세요. 확인된 중복만 줄이고, 개별 결정문을 찾기 위한 검색을 유지하세요. 재측정 시 등재 연도·기준과 UNESCO 개별 결정문 링크를 확인하세요.",
  evidence: "공개 QA, 2026-11-14 AEST. 운영 807891839 → 80a95b53e, 동일 질문 8쌍, 세 스위치 OFF. 브라우저 완료 p95 약 90.5 → 66.3초, 10초 이내 0/8 → 0/8. 배포 후 히메지성 답변은 Qwen 5회, 후속 검색 4회, 첫 모델 호출부터 첫 본문까지 46.307초. 두 답변 모두 요청한 UNESCO 개별 결정문 /en/decisions/3337/ 링크를 빠뜨렸습니다.",
};

type DailyProposal = typeof qaFollowup;
type Sample = Awaited<ReturnType<typeof readChatPresearchLatency>>["windows"][number];
type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

function liveFollowup(day: string, window: Sample | undefined): DailyProposal | null {
  if (!window || window.completionP95Ms === null || window.completionP95Ms <= targetMs) return null;
  const evidence = `${day} AEST 마감, 선행검색 24시간. 시도 ${window.serverAttempts}건, 브라우저 연결 ${window.paired}건, 완료 시간 표본 ${window.completed}건, 완료 p95 ${window.completionP95Ms}ms, 10초 이내 ${window.withinTenSeconds}건. QA와 배포·모델별 분리 전 집계이며 답변 품질은 미측정입니다.`;
  const verify = "배포·모델·스위치별로 QA를 분리하고, 같은 공개 질문과 공식 근거로 첫 본문·완료·인용을 검증하세요.";
  // Use the existing latency console's minimum for an observational sample.
  // Rank only comparable medians from the same slow, fully timed attempts.
  if (window.timedSlowCompleted >= 30) {
    const stages = [
      { key: "before-provider", name: "전송부터 답변 모델 호출", ms: window.slowBeforeProviderEstimateP50Ms },
      { key: "provider-to-content", name: "답변 모델 호출부터 첫 본문", ms: window.slowProviderToContentP50Ms },
      { key: "content-to-end", name: "첫 본문부터 완료", ms: window.slowContentToEndP50Ms },
    ];
    if (stages.every(s => s.ms !== null)) {
      const longest = stages.reduce((best, s) => s.ms! > best.ms! ? s : best);
      return { key: longest.key, text: `Smart Adaptive의 ${longest.name} 구간을 우선 점검하세요. ${verify}`,
        evidence: `${evidence} 10초 초과 중 세 구간을 모두 잰 ${window.timedSlowCompleted}건의 ${longest.name} 중앙값 ${longest.ms}ms.` };
    }
  }
  return { key: "presearch-submit-to-completion", text: `Smart Adaptive 선행검색의 10초 초과 응답이 어느 구간에서 지연되는지 점검하세요. ${verify}`, evidence };
}

async function appendToRoutingReport(tx: Prisma.TransactionClient, proposal: DailyProposal, day: string, asOf: string) {
  const marker = settingPrefix + "listed." + proposal.key;
  const previous = await tx.appSetting.findUnique({ where: { key: marker }, select: { value: true } });
  if (previous) return { outcome: "already_listed", recommendation: JSON.parse(previous.value) as { cycleId: string; index: number } };

  // Match the ten routing cycles actually displayed in the console, even when
  // the most recent one is running or ended without an optimizer report.
  const cycles = await tx.autoRouterOptimizerCycle.findMany({
    where: { target: "routing" }, orderBy: { createdAt: "desc" }, take: 10,
    select: { id: true, status: true, summary: true },
  });
  for (const cycle of cycles) {
    const summary = object(cycle.summary);
    const report = object(summary?.report);
    const items = report?.recommendations;
    // 63 is the highest index accepted by the operator action routes.
    if (cycle.status === "running" || !summary || !report || !Array.isArray(items) || items.length > 63) continue;
    const ref = { cycleId: cycle.id, index: items.length };
    const next = {
      ...summary, report: { ...report, recommendations: [...items, { kind: "code", text: proposal.text }] },
      smartAdaptiveDaily: { ...object(summary.smartAdaptiveDaily),
        [ref.index]: { source: "smart_adaptive_daily", day, asOf, evidence: proposal.evidence } },
    };
    await tx.autoRouterOptimizerCycle.update({ where: { id: cycle.id }, data: { summary: next as Prisma.InputJsonObject } });
    // The reference survives a dismissal, a completed PR, and the cycle moving
    // out of the console window. None of those events should reopen the item.
    await tx.appSetting.create({ data: { key: marker, value: JSON.stringify(ref) } });
    return { outcome: "added", recommendation: ref };
  }
  return { outcome: "awaiting_cycle", recommendation: null };
}

// This snapshot is replaceable. A corrupt snapshot must not stop observations;
// the separate listing markers still protect operator decisions.
function readSnapshot(value?: string): JsonRecord | null {
  if (!value) return null;
  try {
    const snapshot = object(JSON.parse(value));
    return snapshot && typeof snapshot.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(snapshot.day)
      ? snapshot : null;
  } catch { return null; }
}

export async function readSmartAdaptiveDaily() {
  const row = await prisma.appSetting.findUnique({ where: { key: latestKey }, select: { value: true } });
  return readSnapshot(row?.value);
}

/** Called only after the existing Ubuntu daily claim authenticated and its switch passed. */
export async function observeSmartAdaptiveDaily(now = new Date()) {
  const day = new Date(now.getTime() + 10 * 60 * 60_000).toISOString().slice(0, 10);
  const recorded = await prisma.appSetting.findUnique({ where: { key: latestKey }, select: { value: true } });
  if (String(readSnapshot(recorded?.value)?.day ?? "") >= day) return;
  const [current, prior] = await Promise.all([
    readChatPresearchLatency(now), readChatPresearchLatency(new Date(now.getTime() - dayMs)),
  ]);
  await prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
    const latest = await tx.appSetting.findUnique({ where: { key: latestKey }, select: { value: true } });
    if (String(readSnapshot(latest?.value)?.day ?? "") >= day) return;
    const seed = await appendToRoutingReport(tx, qaFollowup, day, current.asOf);
    const live = liveFollowup(day, current.windows.find(w => w.hours === 24));
    let item = seed;
    if (seed.outcome === "already_listed") {
      item = live ? await appendToRoutingReport(tx, live, day, current.asOf) : { outcome: "observed", recommendation: null };
    }
    const snapshot = { day, asOf: current.asOf, current, previousDay: prior.windows.find(w => w.hours === 24) ?? null, ...item };
    const value = JSON.stringify(snapshot);
    await tx.appSetting.upsert({ where: { key: latestKey }, create: { key: latestKey, value }, update: { value } });
    await writeSystemAuditLog({ tx, systemActor: DAILY_PRODUCT_AGENT_AUDIT_ACTOR,
      action: "daily_product_agent.smart_adaptive_observed", targetType: "AppSettings", targetId: latestKey,
      summary: "Recorded the daily Smart Adaptive search timing observation.",
      metadata: { day, outcome: item.outcome, recommendation: item.recommendation } });
  });
}
