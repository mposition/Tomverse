"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Code2,
  FileText,
  PlayCircle,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";

type ProofMetrics = {
  periodDays: number;
  generatedAt: string;
  comparisons: number | null;
  fileWorkflows: number | null;
  minimumPublicCount: number;
};

type ProofCopy = {
  eyebrow: string;
  title: string;
  description: string;
  videoEyebrow: string;
  videoTitle: string;
  videoBody: string;
  videoDisclosure: string;
  comparisonMetric: string;
  fileMetric: string;
  metricSuffix: string;
  metricPeriod: string;
  metricDisclosure: string;
  casesTitle: string;
  casesDescription: string;
  cases: Array<{
    eyebrow: string;
    title: string;
    inputLabel: string;
    input: string;
    findings: string[];
    result: string;
  }>;
  differencesTitle: string;
  differences: Array<{ model: string; contribution: string }>;
  reproduceLabel: string;
  evidencePolicy: string;
};

const englishCopy: ProofCopy = {
  eyebrow: "Product evidence",
  title: "Real workflows are stronger proof than a vanity user count.",
  description:
    "These reproducible examples show the prompt, the input context, and what changed after comparing models. Demo responses are shortened and contain no customer data.",
  videoEyebrow: "Recorded product walkthrough",
  videoTitle: "One launch question, three model panels",
  videoBody:
    "The recording uses the real Tomverse chat interface with controlled sample responses, so the navigation and comparison behavior are authentic without presenting generated demo text as customer work.",
  videoDisclosure: "Product UI recording · controlled demo data · no provider endorsement",
  comparisonMetric: "Multi-model comparisons",
  fileMetric: "File attachments",
  metricSuffix: "+",
  metricPeriod: "Last 30 days",
  metricDisclosure:
    "Privacy-safe product analytics only. A count appears after at least 20 consented events and is rounded down to the nearest 10.",
  casesTitle: "Three reproducible work cases",
  casesDescription:
    "Each case starts with a concrete work artifact and a measurable output—not an anonymous testimonial that cannot be verified.",
  cases: [
    {
      eyebrow: "Case 01 · Decision memo",
      title: "Find different launch risks from the same brief",
      inputLabel: "Input",
      input: "A launch brief containing payment, support, rollout, and provider-dependency risks.",
      findings: [
        "GPT emphasized payment retries and measurable launch gates.",
        "Claude emphasized ownership, escalation paths, and customer communication.",
        "Gemini emphasized staged rollout, monitoring, and rollback criteria.",
      ],
      result: "Result: one consolidated risk register with owners, launch gates, and rollback triggers.",
    },
    {
      eyebrow: "Case 02 · PDF analysis",
      title: "Turn an 18-page readiness brief into an audit list",
      inputLabel: "Before",
      input: "launch-readiness-brief.pdf · narrative sections, dates, dependencies, and unresolved actions.",
      findings: [
        "Five decisions extracted with their source section headings.",
        "Dates and owners normalized into a reviewable checklist.",
        "Unresolved items separated from confirmed decisions.",
      ],
      result: "After: a structured audit list that can be checked against the original PDF.",
    },
    {
      eyebrow: "Case 03 · Code review",
      title: "Compare a minimal fix, trade-offs, and missing tests",
      inputLabel: "Input",
      input: "A request handler with timeout, retry, and duplicate stream-close failure modes.",
      findings: [
        "Implementation-focused model proposed the smallest safe patch.",
        "Review-focused model explained lifecycle and concurrency trade-offs.",
        "A third model added failure-path and regression-test scenarios.",
      ],
      result: "Result: a patch plan backed by tests instead of three unverified opinions.",
    },
  ],
  differencesTitle: "What changed between models on the same question",
  differences: [
    { model: "GPT", contribution: "Concrete gates, compact structure, and implementation-ready next steps." },
    { model: "Claude", contribution: "Context, ownership, communication risks, and decision trade-offs." },
    { model: "Gemini", contribution: "Operational monitoring, staged rollout, and rollback framing." },
  ],
  reproduceLabel: "Reproduce a model comparison",
  evidencePolicy:
    "Testimonials and customer logos are published only after explicit permission. Until then, Tomverse uses reproducible work cases and thresholded aggregate usage—not invented social proof.",
};

const koreanCopy: ProofCopy = {
  eyebrow: "제품 사용 증거",
  title: "과장된 사용자 수보다 실제 업무 흐름을 보여드립니다.",
  description: "프롬프트, 입력 맥락과 모델 비교 후 달라진 결과를 재현 가능한 예시로 제공합니다. 데모 응답은 축약했으며 고객 데이터는 포함하지 않습니다.",
  videoEyebrow: "실제 제품 화면 녹화",
  videoTitle: "하나의 출시 질문을 3개 모델 패널에서 비교",
  videoBody: "실제 Tomverse 채팅 인터페이스와 통제된 예시 응답으로 녹화하여 탐색과 비교 동작은 실제 제품과 같고 데모 문구를 고객 작업처럼 표현하지 않습니다.",
  videoDisclosure: "제품 UI 녹화 · 통제된 데모 데이터 · 공급자 보증 아님",
  comparisonMetric: "멀티모델 비교",
  fileMetric: "파일 첨부",
  metricSuffix: "+",
  metricPeriod: "최근 30일",
  metricDisclosure: "동의 기반 개인정보 보호 분석만 집계합니다. 최소 20건 이상일 때 10단위로 내림한 수치만 표시합니다.",
  casesTitle: "재현 가능한 실제 업무 사례 3개",
  casesDescription: "검증할 수 없는 익명 후기 대신 구체적인 업무 자료와 측정 가능한 출력에서 시작합니다.",
  cases: [
    {
      eyebrow: "사례 01 · 의사결정 메모",
      title: "같은 출시 브리프에서 서로 다른 위험 찾기",
      inputLabel: "입력",
      input: "결제, 지원, 단계적 출시와 공급자 의존 위험이 포함된 출시 브리프.",
      findings: ["GPT는 결제 재시도와 측정 가능한 출시 기준을 강조했습니다.", "Claude는 담당자, 에스컬레이션과 고객 커뮤니케이션을 강조했습니다.", "Gemini는 단계적 출시, 모니터링과 롤백 기준을 강조했습니다."],
      result: "결과: 담당자, 출시 기준과 롤백 조건이 포함된 하나의 통합 위험 목록.",
    },
    {
      eyebrow: "사례 02 · PDF 분석",
      title: "18페이지 준비 문서를 감사 체크리스트로 변환",
      inputLabel: "분석 전",
      input: "launch-readiness-brief.pdf · 서술형 섹션, 날짜, 의존성과 미해결 조치.",
      findings: ["근거 섹션 제목과 함께 결정 5개를 추출했습니다.", "날짜와 담당자를 검토 가능한 체크리스트로 정규화했습니다.", "미해결 항목과 확정된 결정을 분리했습니다."],
      result: "분석 후: 원본 PDF와 대조할 수 있는 구조화된 감사 목록.",
    },
    {
      eyebrow: "사례 03 · 코드 검토",
      title: "최소 수정안, 장단점과 누락된 테스트 비교",
      inputLabel: "입력",
      input: "타임아웃, 재시도와 스트림 중복 종료 실패 가능성이 있는 요청 처리기.",
      findings: ["구현 중심 모델은 가장 작은 안전 패치를 제안했습니다.", "검토 중심 모델은 수명 주기와 동시성 장단점을 설명했습니다.", "세 번째 모델은 실패 경로와 회귀 테스트 시나리오를 추가했습니다."],
      result: "결과: 검증되지 않은 세 의견이 아니라 테스트로 뒷받침된 패치 계획.",
    },
  ],
  differencesTitle: "같은 질문에서 모델별로 달랐던 점",
  differences: [
    { model: "GPT", contribution: "구체적인 기준, 간결한 구조와 구현 가능한 다음 단계." },
    { model: "Claude", contribution: "맥락, 담당자, 커뮤니케이션 위험과 의사결정 장단점." },
    { model: "Gemini", contribution: "운영 모니터링, 단계적 출시와 롤백 관점." },
  ],
  reproduceLabel: "모델 비교 직접 재현하기",
  evidencePolicy: "사용자 후기와 고객 로고는 명시적인 공개 허가를 받은 경우에만 게시합니다. 그전에는 허위 사회적 증명 대신 재현 가능한 업무 사례와 최소 기준을 넘은 집계 사용량만 제공합니다.",
};

const proofCopy: Partial<Record<Language, ProofCopy>> = { en: englishCopy, ko: koreanCopy };

export function ProductProofSection() {
  const { lang } = useLanguage();
  const copy = proofCopy[lang] ?? englishCopy;
  const [metrics, setMetrics] = useState<ProofMetrics | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/public/proof-metrics", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: ProofMetrics | null) => {
        if (data) setMetrics(data);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const visibleMetrics = [
    metrics?.comparisons !== null && metrics?.comparisons !== undefined
      ? { label: copy.comparisonMetric, value: metrics.comparisons }
      : null,
    metrics?.fileWorkflows !== null && metrics?.fileWorkflows !== undefined
      ? { label: copy.fileMetric, value: metrics.fileWorkflows }
      : null,
  ].filter((item): item is { label: string; value: number } => Boolean(item));

  return (
    <section className="border-y border-zinc-200 bg-white py-20 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.22em] text-blue-600 dark:text-blue-400">{copy.eyebrow}</p>
          <h2 className="mt-3 text-3xl font-black sm:text-4xl">{copy.title}</h2>
          <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{copy.description}</p>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <article className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-blue-950/20">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3 text-white sm:px-5">
              <span className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-blue-300"><PlayCircle className="h-4 w-4" />{copy.videoEyebrow}</span>
              <span className="hidden text-[10px] font-bold text-zinc-400 sm:block">Tomverse AI</span>
            </div>
            <video
              src="/marketing-proof/three-model-comparison.webm"
              className="aspect-video w-full bg-black object-cover"
              autoPlay
              muted
              loop
              playsInline
              controls
              preload="metadata"
              aria-label={copy.videoTitle}
            />
            <div className="p-5 text-white">
              <h3 className="text-xl font-black">{copy.videoTitle}</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-300">{copy.videoBody}</p>
              <p className="mt-3 text-[11px] font-bold uppercase tracking-wider text-zinc-500">{copy.videoDisclosure}</p>
            </div>
          </article>

          <div className="space-y-4">
            {visibleMetrics.length > 0 && (
              <article className="rounded-3xl border border-emerald-500/30 bg-emerald-500/5 p-5">
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400"><BarChart3 className="h-5 w-5" /><span className="text-xs font-black uppercase tracking-wider">{copy.metricPeriod}</span></div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  {visibleMetrics.map((metric) => (
                    <div key={metric.label}><p className="text-3xl font-black text-zinc-950 dark:text-white">{metric.value.toLocaleString()}{copy.metricSuffix}</p><p className="mt-1 text-xs font-bold text-zinc-500">{metric.label}</p></div>
                  ))}
                </div>
                <p className="mt-5 text-[11px] leading-5 text-zinc-500">{copy.metricDisclosure}</p>
              </article>
            )}
            <article className="rounded-3xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
              <Scale className="h-6 w-6 text-blue-600 dark:text-blue-400" />
              <h3 className="mt-4 text-xl font-black">{copy.differencesTitle}</h3>
              <div className="mt-5 space-y-4">
                {copy.differences.map((item) => (
                  <div key={item.model} className="flex gap-3"><span className="flex h-8 min-w-16 items-center justify-center rounded-lg bg-zinc-950 px-2 text-xs font-black text-white dark:bg-white dark:text-zinc-950">{item.model}</span><p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">{item.contribution}</p></div>
                ))}
              </div>
              <Link href="/compare-ai-models" className="mt-6 inline-flex items-center gap-2 text-sm font-black text-blue-600 hover:text-blue-500 dark:text-blue-400">{copy.reproduceLabel}<ArrowRight className="h-4 w-4" /></Link>
            </article>
          </div>
        </div>

        <div className="mt-16 max-w-3xl">
          <h2 className="text-3xl font-black sm:text-4xl">{copy.casesTitle}</h2>
          <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{copy.casesDescription}</p>
        </div>
        <div className="mt-8 grid gap-5 lg:grid-cols-3">
          {copy.cases.map((item, index) => {
            const Icon = index === 0 ? Scale : index === 1 ? FileText : Code2;
            return (
              <article key={item.title} className="flex flex-col rounded-3xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="flex items-center justify-between gap-3"><Icon className="h-6 w-6 text-blue-600 dark:text-blue-400" /><span className="text-[10px] font-black uppercase tracking-wider text-zinc-400">{item.eyebrow}</span></div>
                <h3 className="mt-5 text-xl font-black">{item.title}</h3>
                <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"><p className="text-[10px] font-black uppercase tracking-wider text-zinc-400">{item.inputLabel}</p><p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-300">{item.input}</p></div>
                <ul className="mt-5 space-y-3">
                  {item.findings.map((finding) => <li key={finding} className="flex gap-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-500" />{finding}</li>)}
                </ul>
                <p className="mt-5 border-t border-zinc-200 pt-4 text-sm font-black leading-6 dark:border-zinc-800">{item.result}</p>
              </article>
            );
          })}
        </div>

        <div className="mt-8 flex gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-xs leading-5 text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{copy.evidencePolicy}</p>
        </div>
      </div>
    </section>
  );
}
