"use client";

import { Info } from "lucide-react";
import { displayHeadingClass } from "@/lib/displayHeading";
import type { Language } from "@/components/LanguageProvider";

/**
 * The two shapes every landing section below the hero repeats: its heading
 * block, and the line that states what a feature costs or requires.
 *
 * The condition line exists as its own component because the audit's most
 * common finding was a true capability claim printed without the condition a
 * visitor would otherwise meet only after signing up. Giving it one component
 * means a new feature card cannot quietly ship without somewhere to put that
 * condition, and every condition renders with the same weight.
 */

export function SectionHeading({
  eyebrow,
  title,
  description,
  lang,
  headingId,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  lang: Language;
  headingId: string;
}) {
  return (
    <div className="max-w-3xl">
      {eyebrow && (
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-blue-600 dark:text-blue-400">
          {eyebrow}
        </p>
      )}
      <h2
        id={headingId}
        className={`mt-3 break-words text-3xl font-black sm:text-4xl ${displayHeadingClass(lang)}`}
      >
        {title}
      </h2>
      {description && (
        <p className="mt-4 break-words text-base leading-7 text-zinc-600 dark:text-zinc-300">
          {description}
        </p>
      )}
    </div>
  );
}

export function ConditionLine({
  children,
  testId,
}: {
  children: string;
  testId?: string;
}) {
  return (
    <p
      data-testid={testId}
      data-landing-condition="true"
      className="mt-4 flex gap-2 break-words text-xs font-semibold leading-5 text-zinc-600 dark:text-zinc-400"
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
