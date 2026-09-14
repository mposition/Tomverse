"use client";

import Link from "next/link";
import { Check, Circle, FileText, MessageSquare, UserRoundPlus } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import {
  ASSISTANT_KNOWLEDGE_GUIDE_STEPS,
  type AssistantKnowledgeGuideStep,
} from "@/lib/assistantKnowledgeGuide";

type SetupStage = AssistantKnowledgeGuideStep;

const copy = {
  ko: {
    eyebrow: "3단계 설정 가이드",
    title: "나의 AI 어시스턴트 + Knowledge",
    resume: "저장된 결과를 기준으로 다음 단계부터 이어집니다.",
    steps: {
      create_assistant: {
        title: "어시스턴트 만들기",
        body: "이름과 원하는 답변 방식을 적고 어시스턴트를 만드세요.",
      },
      add_knowledge: {
        title: "Knowledge 추가하고 저장하기",
        body: "아래에서 파일을 추가·선택하고 지시문과 모델을 저장하세요.",
      },
      start_chat: {
        title: "대화에서 사용하기",
        body: "대화로 이동하면 방금 만든 어시스턴트를 자동으로 선택합니다.",
      },
    },
    unavailable:
      "이 계정에서는 Knowledge가 아직 활성화되지 않았습니다. 파일 단계는 기능이 활성화된 뒤 이어갈 수 있습니다.",
    goToKnowledge: "Knowledge 입력으로 이동",
    startChat: "이 어시스턴트로 대화하기",
    current: "현재 단계",
    complete: "완료",
    upcoming: "다음",
  },
  en: {
    eyebrow: "Three-step setup guide",
    title: "My AI Assistant + Knowledge",
    resume: "The guide resumes from what has actually been saved.",
    steps: {
      create_assistant: {
        title: "Create your assistant",
        body: "Enter a name and how you want answers written, then create the assistant.",
      },
      add_knowledge: {
        title: "Add Knowledge and save",
        body: "Add and select a file below, then save instructions and models.",
      },
      start_chat: {
        title: "Use it in a conversation",
        body: "Continue to chat and the assistant you just made will be selected automatically.",
      },
    },
    unavailable:
      "Knowledge is not enabled for this account yet. You can resume the file step after it becomes available.",
    goToKnowledge: "Go to Knowledge input",
    startChat: "Chat with this assistant",
    current: "Current step",
    complete: "Complete",
    upcoming: "Next",
  },
} as const;

const steps = ASSISTANT_KNOWLEDGE_GUIDE_STEPS;
const icons = [UserRoundPlus, FileText, MessageSquare] as const;

export function AssistantKnowledgeSetupGuide({
  stage,
  knowledgeEnabled,
  onStartChat,
}: {
  stage: SetupStage;
  knowledgeEnabled: boolean;
  onStartChat?: () => void;
}) {
  const { lang } = useLanguage();
  const labels = copy[lang === "ko" ? "ko" : "en"];
  const currentIndex = steps.indexOf(stage);

  return (
    <section
      className="mt-5 rounded-3xl border border-teal-200 bg-teal-50/80 p-5 dark:border-teal-900 dark:bg-teal-950/25"
      aria-labelledby="assistant-knowledge-setup-title"
      data-testid="assistant-knowledge-setup-guide"
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-300">
        {labels.eyebrow}
      </p>
      <h2 id="assistant-knowledge-setup-title" className="mt-2 text-lg font-black">
        {labels.title}
      </h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
        {labels.resume}
      </p>

      <ol className="mt-5 grid gap-3 sm:grid-cols-3">
        {steps.map((step, index) => {
          const Icon = icons[index];
          const complete = index < currentIndex;
          const current = index === currentIndex;
          return (
            <li
              key={step}
              className={`rounded-2xl border p-4 ${
                current
                  ? "border-teal-500 bg-white dark:bg-zinc-950"
                  : "border-teal-100 bg-white/70 dark:border-teal-950 dark:bg-zinc-950/50"
              }`}
              aria-current={current ? "step" : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <Icon className="h-5 w-5 text-teal-700 dark:text-teal-300" aria-hidden="true" />
                <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                  {complete ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Circle className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {complete
                    ? labels.complete
                    : current
                      ? labels.current
                      : labels.upcoming}
                </span>
              </div>
              <h3 className="mt-3 text-sm font-bold">
                {labels.steps[step].title}
              </h3>
              <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                {labels.steps[step].body}
              </p>
            </li>
          );
        })}
      </ol>

      {stage === "add_knowledge" && !knowledgeEnabled ? (
        <p className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          {labels.unavailable}
        </p>
      ) : null}

      {stage === "add_knowledge" && knowledgeEnabled ? (
        <a
          href="#assistant-knowledge-panel"
          className="mt-4 inline-flex min-h-10 items-center rounded-xl border border-teal-300 bg-white px-4 text-sm font-bold text-teal-900 transition hover:border-teal-500 dark:border-teal-800 dark:bg-zinc-950 dark:text-teal-100"
        >
          {labels.goToKnowledge}
        </a>
      ) : null}

      {stage === "start_chat" && onStartChat ? (
        <Link
          href="/chat"
          onClick={onStartChat}
          className="mt-4 inline-flex min-h-10 items-center rounded-xl bg-teal-700 px-4 text-sm font-bold text-white transition hover:bg-teal-600"
          data-testid="assistant-knowledge-start-chat"
        >
          {labels.startChat}
        </Link>
      ) : null}
    </section>
  );
}
