"use client";

import { Check, CornerDownRight, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LandingCopy } from "./landingContent";

const FINAL_STAGE = 3;
const STAGE_TIMINGS = [850, 1850, 3050] as const;

type LandingHeroAiReviewDemoProps = {
  preview: LandingCopy["preview"];
  stages: LandingCopy["proof"]["stages"];
};

/**
 * A code-native product demonstration for the landing hero.
 *
 * It plays once when it enters the viewport and then rests on the complete
 * comparison. Every state occupies the same layout box, so hydration and the
 * timed reveal do not move the CTA or the sections below the hero. Reduced
 * motion, no JavaScript, and server rendering all receive the complete state.
 */
export function LandingHeroAiReviewDemo({
  preview,
  stages,
}: LandingHeroAiReviewDemoProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeStage, setActiveStage] = useState(FINAL_STAGE);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timers: number[] = [];
    let observer: IntersectionObserver | null = null;
    let hasPlayed = false;

    const clearTimers = () => {
      for (const timer of timers.splice(0)) window.clearTimeout(timer);
    };

    const showCompleteState = () => {
      clearTimers();
      setActiveStage(FINAL_STAGE);
    };

    const play = () => {
      if (hasPlayed || reducedMotion.matches) {
        showCompleteState();
        return;
      }

      hasPlayed = true;
      setActiveStage(0);
      STAGE_TIMINGS.forEach((delay, index) => {
        timers.push(
          window.setTimeout(() => setActiveStage(index + 1), delay)
        );
      });
    };

    const handleMotionPreference = () => {
      if (reducedMotion.matches) showCompleteState();
      else if (!hasPlayed) play();
    };

    if (reducedMotion.matches || !("IntersectionObserver" in window)) {
      handleMotionPreference();
    } else {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          play();
          observer?.disconnect();
          observer = null;
        },
        { threshold: 0.28 }
      );
      observer.observe(root);
    }

    reducedMotion.addEventListener("change", handleMotionPreference);

    return () => {
      clearTimers();
      observer?.disconnect();
      reducedMotion.removeEventListener("change", handleMotionPreference);
    };
  }, []);

  const answersVisible = activeStage >= 1;
  const reviewVisible = activeStage >= 2;
  const nextActionVisible = activeStage >= FINAL_STAGE;

  return (
    <div
      ref={rootRef}
      role="img"
      aria-label={preview.srDescription}
      data-testid="landing-hero-product-demo"
      data-active-stage={activeStage}
      className="relative min-w-0 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 p-[8px] shadow-2xl shadow-zinc-300/60 dark:shadow-black/50 md:p-[12px]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[12%] bottom-[7%] h-40 rounded-full bg-linear-to-r from-accent-ai-review-start-600 via-accent-ai-review-mid-600 to-accent-ai-review-end-600 opacity-20 blur-3xl"
      />

      <div aria-hidden="true" className="relative rounded-[1.25rem] border border-zinc-800 bg-zinc-950 text-white">
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-zinc-800 px-[16px] py-[12px]">
          <span className="flex min-w-0 items-center gap-2 break-words text-xs font-bold text-zinc-300">
            <span className="h-2 w-2 shrink-0 rounded-full bg-status-success-500" />
            {preview.title}
          </span>
            <span className="shrink-0 text-[11px] font-semibold text-zinc-500">
            {stages[activeStage]?.title}
          </span>
        </div>

        <div className="p-[12px]">
          <div
            data-testid="landing-hero-demo-prompt"
            className={`flex min-w-0 items-center gap-3 rounded-xl border px-[12px] py-[10px] transition-[border-color,background-color,opacity] duration-500 motion-reduce:transition-none ${
              activeStage === 0
                ? "border-blue-500 bg-blue-500/15 opacity-100"
                : "border-zinc-800 bg-zinc-900/70 opacity-70"
            }`}
          >
            <CornerDownRight className="h-4 w-4 shrink-0 text-blue-400" />
            <span className="min-w-0 break-words text-xs font-semibold leading-5 text-zinc-200">
              {stages[0]?.caption}
            </span>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {["GPT", "Claude", "Gemini"].map((model, index) => {
              const fanOutClass =
                index === 0
                  ? "sm:-rotate-[1.25deg]"
                  : index === 2
                    ? "sm:rotate-[1.25deg]"
                    : "rotate-0";
              const settledClass = reviewVisible
                ? "rotate-0 scale-[0.985]"
                : fanOutClass;

              return (
                <article
                  key={model}
                  data-testid={`landing-hero-demo-model-${model.toLowerCase()}`}
                  className={`min-w-0 rounded-2xl border bg-zinc-900/90 p-[12px] transition-[transform,opacity,border-color] duration-700 ease-out motion-reduce:transition-none ${
                    answersVisible
                      ? `translate-y-0 border-zinc-700 opacity-100 ${settledClass}`
                      : "translate-y-3 border-zinc-800 opacity-35"
                  }`}
                  style={{ transitionDelay: answersVisible ? `${index * 90}ms` : "0ms" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold">{model}</span>
                    <span className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                      <span
                        className={`h-1.5 w-1.5 rounded-full transition-colors duration-500 motion-reduce:transition-none ${
                          answersVisible ? "bg-status-success-500" : "bg-zinc-600"
                        }`}
                      />
                      {stages[1]?.title}
                    </span>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="h-1.5 w-4/5 rounded-full bg-zinc-700" />
                    <div className="h-1.5 w-full rounded-full bg-zinc-800" />
                  </div>
                  <p className="mt-3 break-words rounded-xl border border-zinc-700 bg-zinc-800 p-[10px] text-xs font-bold leading-5 text-zinc-200">
                    {preview.answers[index]}
                  </p>
                </article>
              );
            })}
          </div>

          <div
            data-testid="landing-hero-demo-review"
            className={`relative mt-3 overflow-hidden rounded-2xl border border-tomverse-review-border bg-tomverse-review-surface text-zinc-950 transition-[transform,opacity] duration-700 ease-out motion-reduce:transition-none dark:text-white ${
              reviewVisible
                ? "translate-y-0 opacity-100"
                : "translate-y-3 opacity-35"
            }`}
          >
            <div className="h-1 bg-linear-to-r from-accent-ai-review-start-600 via-accent-ai-review-mid-600 to-accent-ai-review-end-600" />
            <div className="p-[12px]">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 break-words text-xs font-bold text-tomverse-review-selected-text dark:text-blue-200">
                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                  {preview.reviewTitle}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  {stages[2]?.title}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {preview.reviewItems.map((item) => (
                  <span
                    key={item}
                    className="flex min-w-0 items-center gap-1.5 break-words rounded-lg border border-tomverse-review-selected-border/30 bg-white/55 px-[8px] py-[8px] text-[11px] font-bold text-tomverse-review-selected-text dark:bg-black/20 dark:text-zinc-200"
                  >
                    <Check className="h-3 w-3 shrink-0 text-status-success-600 dark:text-status-success-300" />
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div
            data-testid="landing-hero-demo-next-action"
            className={`mt-3 flex min-w-0 items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/80 px-[12px] py-[10px] transition-[transform,opacity] duration-500 motion-reduce:transition-none ${
              nextActionVisible
                ? "translate-y-0 opacity-100"
                : "translate-y-2 opacity-35"
            }`}
          >
            <span className="min-w-0 break-words text-xs font-semibold text-zinc-300">
              {stages[3]?.caption}
            </span>
            <span className="shrink-0 rounded-full border border-zinc-700 px-[8px] py-[4px] text-[11px] font-semibold text-zinc-400">
              {preview.count}
            </span>
          </div>
        </div>

        <ol className="grid grid-cols-4 border-t border-zinc-800 px-[12px] py-[10px]">
          {stages.map((stage, index) => (
            <li
              key={stage.title}
              className={`min-w-0 border-l px-[8px] first:border-l-0 first:pl-0 last:pr-0 transition-colors duration-300 motion-reduce:transition-none ${
                index <= activeStage
                  ? "border-blue-500 text-blue-300"
                  : "border-zinc-800 text-zinc-600"
              }`}
            >
              <span className="block text-[11px] font-semibold">
                0{index + 1}
              </span>
              <span className="mt-1 block truncate text-[11px] font-semibold">
                {stage.title}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
