import { INPUT_CREDIT_MULTIPLIERS } from "@/lib/models";

export function ModelInputCreditGuide() {
  const format = (value: number) => value.toLocaleString("en-US");
  const bands = [
    { range: `Up to ${format(INPUT_CREDIT_MULTIPLIERS[0].aboveTokens)} tokens`, multiplier: 1 },
    ...INPUT_CREDIT_MULTIPLIERS.map((threshold, index) => ({
      range: `More than ${format(threshold.aboveTokens)}${INPUT_CREDIT_MULTIPLIERS[index + 1] ? `, up to ${format(INPUT_CREDIT_MULTIPLIERS[index + 1].aboveTokens)}` : ""} tokens`,
      multiplier: threshold.multiplier,
    })),
  ];
  return (
    <details id="model-input-credit-guide" tabIndex={-1} className="mt-8 scroll-mt-28 rounded-2xl border border-zinc-200 p-5 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-zinc-800">
      <summary className="min-h-11 cursor-pointer py-2.5 font-bold">Input size and credit multipliers</summary>
      <p>The short-request base credits apply at 1×. The multiplier uses estimated total input tokens, including conversation history, extracted file content and system/tool context; it is not a character count or just your latest message.</p>
      <dl className="my-4 space-y-2">
        {bands.map(band => <div key={band.range} data-testid="model-input-credit-band" className="flex flex-wrap justify-between gap-x-4"><dt>{band.range}</dt><dd className="font-bold">{band.multiplier}× base credits</dd></div>)}
      </dl>
      <p>Base credits × the input multiplier are rounded up to whole credits per model. Review adds the selected models’ costs. Search, Deep Research and other tools may have additional or separate charges. The composer shows a base estimate; request processing and settlement can change final usage. A model’s context maximum does not override app input limits.</p>
    </details>
  );
}
