// The footer model button's "1 개 모델" / "3 AIs" label. Every space is a
// no-break space so a narrow composer never splits the count from its unit:
// at 320px the Korean label used to wrap to a lone "1" over "개 모델".
export function composerModelCountLabel(
  count: number,
  unitOne: string,
  unitOther: string
): string {
  const unit = count === 1 ? unitOne : unitOther;
  return `${count} ${unit}`.replace(/ /g, " ");
}
