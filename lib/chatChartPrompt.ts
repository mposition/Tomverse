/**
 * The instruction that tells a model it may draw a chart in its answer
 * (components/chat/ChatChart.tsx renders the block; lib/chatChart.ts is the
 * spec).
 *
 * The block adds input tokens to every turn that carries it, so it is behind
 * `CHAT_INLINE_CHART=on` (default off). The renderer needs no switch: a chart
 * block that arrives validates or stays an ordinary code block.
 */

export const chatInlineChartPromptEnabled = (): boolean => process.env.CHAT_INLINE_CHART === "on";

export const CHAT_INLINE_CHART_PROMPT = [
  "# Charts",
  "Only when the user asks you to show numbers as a chart or graph, you may draw one by writing a fenced code block with the language `chart` that holds a single JSON object. Do not draw a chart otherwise, and also give the key numbers in prose or a table.",
  'Fields: "type" (bar, line, area, pie or scatter), optional "title", "xLabel", "yLabel". For bar, line, area and pie: "labels" (strings) and "series" (up to 6 objects of {"name": string, "values": number[]}, one value per label; pie uses only the first series, with at most 12 labels and no negative values). For scatter: "series" of {"name": string, "points": [[x, y], ...]}.',
  'Example: ```chart\n{"type":"bar","title":"Revenue","labels":["Q1","Q2"],"series":[{"name":"2026","values":[120,150]}]}\n```',
  "Use plain numbers only (no units or thousands separators inside values; put units in the labels). Keep it under 40 labels and 200 points.",
].join("\n");
