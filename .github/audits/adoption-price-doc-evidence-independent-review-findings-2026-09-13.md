# 독립 검토 결과 — 공급자 공식 문서 기반 가격·능력 증거 (2단계)

검토자: codex (독립 실행) · 6라운드 · 최종 **승인** (P1 없음, P2 잔여 1)
요청서: `adoption-price-doc-evidence-independent-review-prompt-2026-09-13.md`,
`adoption-price-doc-evidence-round2-prompt-2026-09-13.md` ~ `round5-prompt-2026-09-13.md`
(6차 요청은 4·5차 대응 확인만 담아 대화 안에서 전달)

## 배경

1단계(#1392/#1393)는 공급자 모델 API가 이미 준 값만 채웠습니다. Claude Fable 5.1·
GPT-6 Astra의 가격·장문 tier·cache write 요율은 모델 API에 없고 공식 문서에만 있으므로,
2단계는 **서버가 허용된 공식 문서만 읽어 출처·digest와 함께 증거로 저장**하고, 채택
초안이 그 증거로 빈 칸을 채우거나(단일 가격) `lib/modelPricing.ts` profile 제안을
만들도록(tier 가격) 했습니다. 가격의 유일한 출처는 여전히 `lib/modelPricing.ts`이며,
문서에서 채운 숫자는 **관리자 override**로 저장된다는 사실과 별도 pricing 검증 의무를
초안이 명시합니다.

## 라운드 요약

| 라운드 | P1 | 핵심 |
|---|---|---|
| 1차 | 8 | 증거 신선도 없음, 문서 간 교차 검증 부족, 저장 행 형태 검증 없음, profile 귀속을 id만으로 판정 등 |
| 2차 | 6 | 가격 식별자에 provider/apiModel pair 포함, 저장 행 exact-shape 파싱, stale 증거 거절 순서 |
| 3차 | 3 | OpenAI 모델 페이지 ↔ 표준 가격표 전체 교차 검증(짧은/긴 컨텍스트, threshold), Anthropic batch 표 ×2 대조 |
| 4차 | 4 | ① pair 변경 시 debounce 중 이전 값 잔존 ② profile이 id로만 pair를 "cover" ③ 프로모션 탐지가 키워드 3개에 의존(fail-open) ④ 열 수가 다른 중복 행이 조용히 무시됨 |
| 5차 | 1 | 문서 가격이 늦게 채워질 때 확인 게이트가 다시 걸리지 않음 (+P2: 공백 입력이 pair 초기화 유발) |
| 6차 | 0 | 승인. 4차 P1-③은 P2 잔여 위험으로 하향 타당 |

### 4차 대응

- ① Provider select·API model 입력의 onChange에서 **즉시** `startNewPair()` — followed
  필드, touched, reasoning·가격 확정을 그 자리에서 초기화.
- ② draft·save 양쪽이 profile을 **정확한 pair(`provider`, `apiModelId`)가 맞을 때만**
  상속으로 봄. id의 profile이 다른 pair면 draft는 unknown, save preflight는 409
  (`profileForOtherPair`).
- ③ 키워드 탐지를 통제에서 조기 경고로 내리고, **통제를 운영자 확인으로 옮김.** 문서에서
  가격을 채우면 "출처와 대조했습니다" 확인 전까지 저장 버튼 비활성. 키워드는 넓힘
  (`temporar`, `special/launch rate|price`, `(through|until|ends|expires) <날짜>`).
  `discount`는 제외 — Anthropic 페이지의 batch·볼륨 문장 15개가 걸려 prefill이 사실상
  불가능해짐. 인정 목록은 문장 전문 exact-match이며, 인정되지 않은 프로모션 문장이
  하나라도 있으면 페이지 전체를 막음.
- ④ 행 폭이 다르면 OpenAI 가격표·Anthropic 표준 표는 **표 전체 거부**, Anthropic batch
  표는 페이지 problem으로 모든 행 차단.

### 5차 대응

- 응답이 손대지 않은 가격 칸 중 하나라도 문서값으로 채우면(`priceFilledFromDocs`)
  확인을 다시 요구.
- pair 변경 판정을 lookup key와 같은 trim 비교로 — 공백만 바뀐 입력은 초기화하지 않음.

## 잔여 위험 (P2, 수용)

**임시 가격 표현을 키워드로 완전히 잡을 수 없습니다.** codex 6차 판정: 운영자 확인,
서버가 강제하는 최초 `coming-soon`·비공개 상태, lifecycle의 별도 `pricing` 검증이
겹치므로 P2로 하향이 타당하나, 탐지 자체가 완전해진 것은 아니므로 P2는 남습니다.

## 승인 이후 변경 — 검토 대상 아님을 밝힘

6차 승인 뒤 develop에 Admin Console 한국어화(#1390)가 병합되어
`AdminModelRegistryPanel.tsx`가 충돌했습니다. 해결은 **로직 변경 없이** develop의 catalog
라벨(`m.*`)을 받아들이고, 1·2단계가 패널에 직접 쓴 문구를
`lib/adminMessages/modelRegistry.ts`의 `adopt` 네임스페이스(en/ko)로 옮긴 것입니다
(docs/ui-contracts/admin-console-ia.md "Language" 2·8항). 핸들러·저장 버튼 조건은 승인된
형태 그대로 옮겼고, `tests/adminLocale.test.mjs`(key·arity 대조), typecheck, lint,
관련 단위 테스트 137건으로 확인했습니다. 기계적 이동이라 codex 재검토는 요청하지
않았습니다.

## 검토 범위 밖 발견 — 운영자 결정 필요

1. **크레딧 상한이 낡았습니다.** 40,000 microUSD/credit 상한(2026-08-01, Opus 4.8
   $5/$25·cap 8,192 기준)으로는 Fable 5.1·Astra·Opus 5의 최악 turn이 어느 등급에도
   들지 않아(`above_every_class`) 채택 저장이 거절됩니다. 크레딧 정책 결정이므로 이
   변경에서 건드리지 않았습니다.
2. **GPT-5.6 Sol 프로모션.** 문서는 2026-11-21까지 $4/$20 프로모션을 게시하고, 코드
   profile은 정가 $5/$30을 유지합니다. 인정 목록에 `appliesTo ["gpt-5.6-sol"]`로
   등록했으며, 프로모션 가격은 prefill되지 않습니다.

## 검증

- 미확인: DB schema compare(`COMPARE_SOURCE_DATABASE_URL` 없음), staging 실제 fetch.
