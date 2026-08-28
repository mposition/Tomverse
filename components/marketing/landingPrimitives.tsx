"use client";

import { Info } from "lucide-react";
import { displayHeadingClass } from "@/lib/displayHeading";
import type { Language } from "@/components/LanguageProvider";

/**
 * The two shapes every landing section repeats: its heading block, and the
 * line that states what a feature costs or requires.
 *
 * ## The V2 system, in one place
 *
 * The V1 page was built out of bordered, rounded, drop-shadowed cards on
 * alternating grey bands, with every icon set in a tinted rounded square. That
 * is the house style of every generated marketing page, and it flattened the
 * hierarchy: a legal condition, a headline feature and a link all arrived in
 * the same box.
 *
 * V2 splits surfaces into two kinds and allows nothing in between.
 *
 *   - **Page structure is ruled.** Sections are separated by full-bleed
 *     hairlines and by one inverted band, not by rounded boxes. Groups inside
 *     a section are separated by 1px rules and by whitespace.
 *   - **Product surfaces are rounded.** Exactly two things on the page get a
 *     radius and a fill of their own, because they are depictions of the
 *     product: the hero demonstration, and the AI Review output panel.
 *
 * Two more rules hold it together: icons render inline at text size rather
 * than inside tinted chips, and a monospace layer carries the structural
 * labels (indices, model names, provider names, prices) so the numbers read as
 * measurements rather than as decoration.
 *
 * `ConditionLine` exists as its own component because the audit's most common
 * finding was a true capability claim printed without the condition a visitor
 * would otherwise meet only after signing up. Giving it one component means a
 * new feature cannot quietly ship without somewhere to put that condition, and
 * every condition renders with the same weight.
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
    <div className="landing-reveal max-w-4xl">
      {eyebrow && (
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-blue-600 dark:text-blue-400">
          {eyebrow}
        </p>
      )}
      {/*
        The display step only opens up at `sm:`. The Korean 어절 assertions in
        tests/e2e/korean-typography.spec.ts run at 320px too, and at a 200%
        root font a larger base size makes one intact 어절 wider than the
        viewport -- which is a horizontal overflow, not a typographic choice.
        Above 640px there is room, so that is where the scale lives.
      */}
      <h2
        id={headingId}
        className={`mt-3 break-words text-3xl font-black leading-[1.02] tracking-[-0.02em] sm:text-5xl lg:text-[3.25rem] ${displayHeadingClass(lang)}`}
      >
        {title}
      </h2>
      {description && (
        <p className="mt-5 max-w-2xl break-words text-base leading-7 text-zinc-600 dark:text-zinc-300">
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
