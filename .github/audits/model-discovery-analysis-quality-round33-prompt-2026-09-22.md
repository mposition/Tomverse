# 33차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

32차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P1 1건과 P2 1건을
고친 뒤의 워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해
주세요. 이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

슬래시로 나뉜 제목의 짧은 접미사(`Flash`, `FlashX`)를 전체 모델 이름에
묶습니다. 별칭은 단어 경계로만 맞고 길이는 4자 이상입니다.
`# GLM-5.3-Flash/FlashX` 아래
`FlashX supports a 1M-token context window, unlike GLM-5.3-Flash.`
는 한 주어가 아니므로 어느 SKU도 1M을 받지 않습니다.
`FlashX promotional pricing ends October 1, 2026.`은 FlashX에만 적용됩니다.

이름과 수치는 마크다운을 벗긴 문장에서 읽습니다. 링크는 라벨만 남고,
`*_`와 목록·인용 기호는 빠집니다.
`**GLM-5.3-Flash and GLM-5.3-FlashX** support a 1M-token context window.`
와 목록·백틱으로 감싼 같은 문장은 양쪽이 1,000,000을 받습니다.

파서 버전은 `2026-09-22.8`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
