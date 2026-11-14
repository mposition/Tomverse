// Contract fixtures, not provider quality measurements. Tool cases require Chat E2E.
const pairs = [
  ["short", ["안녕?", "Hello?"], ["안녕?", "Hello?"]],
  ["extraction", ['이 JSON에서 id만 추출: {"id":17,"name":"x"}', 'Extract only id: {"id":17,"name":"x"}'], ["17", "17"]],
  ["calculation", ["19 × 23을 계산하고 숫자만 답해줘.", "Calculate 19 × 23; return only the number."], ["숫자만", "only the number"]],
  ["format", ["이름과 수량을 CSV로, 헤더 없이 써줘.", "Return name and quantity as CSV without headers."], ["헤더 없이", "without headers"]],
  ["translation", ["'Good morning'을 한국어로만 번역해줘.", "Translate '좋은 아침' into English only."], ["한국어로만", "English only"]],
  ["long-tail", ["보고서의 첫 조건을 유지해줘.\n" + "자료😀 ".repeat(1300) + "이미지는 만들지 말고 Excel로 제공해줘.", "Keep the opening constraint.\n" + "data😀 ".repeat(1300) + "Do not generate images; deliver Excel."], ["Excel", "Excel"]],
  ["follow-up", ["두 번째 옵션만 3줄로 설명해줘.", "Explain only the second option in 3 lines."], ["3줄", "3 lines"]],
  ["correction", ["앞의 12개는 취소하고 최신 수치인 7개를 사용해줘.", "Ignore the earlier 12; use the corrected count of 7."], ["7개", "count of 7"]],
  ["negation", ["A는 빼고 B만, 단 C가 있으면 포함해줘.", "Exclude A, include only B, except include C if present."], ["단 C", "except include C"]],
  ["code", ["Python으로 작성하고 외부 패키지는 쓰지 마.", "Write Python without external packages."], ["외부 패키지는 쓰지 마", "without external packages"]],
  ["freshness", ["오늘 기준 공식 출처로 확인하고 날짜를 적어줘.", "Verify against official sources as of today; include the date."], ["오늘 기준", "as of today"]],
  ["tools", ["첨부 표를 읽어 수식이 있는 Excel 파일로 내려받게 해줘.", "Read the attached table and deliver an Excel file with formulas."], ["수식", "with formulas"]],
];

export const autoQualityCostCases = pairs.flatMap(([kind, prompts, constraints]) =>
  ["ko", "en"].map((language, i) => ({
    id: `${kind}-${language}`, kind, language, prompt: prompts[i], constraint: constraints[i],
    previousAnswer: kind === "follow-up"
      ? (i === 0 ? "첫 번째: A. " : "First: A. ") + "context😀 ".repeat(130) + (i === 0 ? "두 번째: B, 가격 7." : "Second: B, price 7.")
      : null,
    toolContractOnly: ["tools", "freshness", "long-tail"].includes(kind),
  })));
