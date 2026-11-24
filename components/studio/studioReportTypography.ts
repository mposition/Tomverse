const defaultFamily = "system-ui, sans-serif";

export async function loadStudioReportTypography(locale: string, content: string) {
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || defaultFamily;
  const isCjk = /^(?:ko|zh)(?:-|$)/.test(locale);
  const displayFamily = isCjk ? family : "Georgia, " + family;
  await Promise.allSettled([400, 750].map(weight => document.fonts.load(`${weight} 24px ${family}`, content)));

  const words = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(locale, { granularity: "word" }) : null;
  const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(locale, { granularity: "grapheme" }) : null;

  function trimToWidth(ctx: CanvasRenderingContext2D, value: string, width: number) {
    if (ctx.measureText(value).width <= width) return value;
    const parts = graphemes ? Array.from(graphemes.segment(value), part => part.segment) : Array.from(value);
    while (parts.length && ctx.measureText(parts.join("").trimEnd() + "…").width > width) parts.pop();
    return parts.join("").trimEnd() + "…";
  }

  function label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, max: number,
    weight = 700, color = "#202a28", chosenFamily = family) {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px ${chosenFamily}`;
    const measured = ctx.measureText(value).width;
    if (measured > max) {
      const fitted = Math.max(size * .8, size * max / measured);
      ctx.font = `${weight} ${fitted}px ${chosenFamily}`;
    }
    ctx.fillText(trimToWidth(ctx, value, max), x, y);
  }

  function paragraph(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, max: number, size: number,
    maxLines: number, color = "#4d5955") {
    ctx.fillStyle = color;
    ctx.font = `450 ${size}px ${family}`;
    const tokens = words ? Array.from(words.segment(value), part => part.segment) : value.split(/(\s+)/);
    let line = "";
    let lineNumber = 1;
    for (const [index, token] of tokens.entries()) {
      const candidate = line + token;
      if (line && ctx.measureText(candidate.trimEnd()).width > max) {
        if (lineNumber === maxLines) {
          ctx.fillText(trimToWidth(ctx, candidate + tokens.slice(index + 1).join(""), max), x, y);
          return;
        }
        ctx.fillText(trimToWidth(ctx, line.trimEnd(), max), x, y);
        line = token.trimStart();
        y += size * 1.39;
        lineNumber++;
      } else {
        line = candidate.trimStart();
      }
    }
    if (line) ctx.fillText(trimToWidth(ctx, line.trimEnd(), max), x, y);
  }

  return { label, paragraph, displayFamily };
}

export type StudioReportTypography = Awaited<ReturnType<typeof loadStudioReportTypography>>;
