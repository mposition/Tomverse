"use client";

/**
 * The three rails that carry the page's one structural idea.
 *
 * Three answers arrive in parallel and one review reads across them. That is
 * the product, so it is the page's skeleton rather than a picture drawn inside
 * one section: three vertical rules descend out of the comparison in the hero,
 * continue past the section boundary, and merge into a single reviewed plane
 * at the point where AI Review speaks. Nothing else on the page repeats this
 * shape, which is what stops the five sections from reading as one template
 * applied five times.
 *
 * It is decoration in the accessibility sense and nothing else: `aria-hidden`,
 * no text, no interaction. The relationship it draws is also stated in words
 * by the copy on both sides of it, so a screen reader loses nothing.
 *
 * Mobile keeps all three rails. Below `sm` the comparison capture shows one
 * answer panel and a tab strip, but three answers still exist -- the product
 * tabs between them rather than dropping two -- so collapsing to a single rail
 * would misstate what is being reviewed.
 */
export function AnswerRails({
  variant,
}: {
  /**
   * `descend` runs the three rails straight down, out of the comparison.
   * `converge` angles them into one point and is used once, immediately
   * above the review plane.
   */
  variant: "descend" | "converge";
}) {
  if (variant === "descend") {
    return (
      <div
        aria-hidden="true"
        className="mx-auto grid h-10 max-w-7xl grid-cols-3 px-[16px] sm:h-14 sm:px-6 lg:px-8"
      >
        {[0, 1, 2].map((index) => (
          <span key={index} className="flex justify-center">
            <span className="h-full w-px bg-zinc-300 dark:bg-zinc-700" />
          </span>
        ))}
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8"
    >
      {/*
        The merge, drawn with a border rather than with three rotated rules:
        a box whose left, right and bottom edges are drawn and whose top is
        open reads as three lines arriving at one, and it survives every
        viewport width without trigonometry. The centre rail continues
        straight through it.
      */}
      <div className="relative h-10 sm:h-14">
        <span className="absolute inset-x-[16.6667%] top-0 bottom-1/2 rounded-b-2xl border-b border-l border-r border-zinc-300 dark:border-zinc-700" />
        <span className="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-zinc-300 dark:bg-zinc-700" />
      </div>
    </div>
  );
}
