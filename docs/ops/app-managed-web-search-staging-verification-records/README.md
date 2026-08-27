# Google 웹 검색 staging 검증 실행 기록

`../app-managed-web-search-staging-checklist.md`는 항목만 가진 template입니다.
실행 결과는 여기에 **실행 1회 = 파일 1개**로 남습니다.

규칙은 외부 import·이미지 생성·AI 생성 파일·assistant profile 기록과
같습니다.

## 파일 이름

```
YYYY-MM-DD__<40자리 deploy SHA>.md
```

전체 SHA를 씁니다. 축약 SHA는 시간이 지나면 충돌할 수 있고, 어느 커밋인지
확인하려면 저장소를 뒤져야 합니다.

## 규칙

1. **기록은 덮어쓰지 않습니다.** 재검증은 새 파일입니다.
2. **비어 있던 항목을 나중에 통과로 채우지 않습니다.** 실행하지 않은 항목은
   `미기록`이며, 그것이 사실입니다.
3. **한 기록은 자기가 실행된 template revision을 적습니다.**
4. **동결된 기록은 digest로 보호합니다.** `frozen: true`인 기록은
   `npm run check:staging-verification-records`가 본문 digest를 대조합니다.
5. **실행·판정·서명은 사람이 합니다.** 통과·조건부·실패의 **판정**과
   **서명**은 사람만 씁니다.

   **관측을 옮겨 적는 것은 에이전트가 합니다.** 실행자가 보고한 것 — 어떤
   badge가 떴고, `backendRequestCount`가 몇이었고, bucket이 얼마 늘었고,
   trace ID가 무엇이었는지 — 을 항목·증거·크레딧 칸에 채워 초안을 만듭니다.
   지어낸 관측을 적는 것은 어느 쪽에서도 허용되지 않으며, 초안은 그것이
   초안임을 문서 안에서 밝히고 실행자가 각 줄을 확인한 뒤 commit 합니다.

## 이 기능에만 있는 규칙

6. **§A와 §B는 에이전트가 채울 수 있습니다.** `/api/ready`의 응답과
   `ChatUsageBucket` 행 값이 전부이고, 판단이 들어가지 않습니다. §D의 "답이
   맞았다"는 자동화가 대신 말할 수 있는 문장이 아닙니다.
7. **검색 결과 본문을 기록에 붙여 넣지 않습니다.** 관측만 적습니다 —
   "citation 3건, 전부 200으로 열림"처럼. 검색 결과는 제3자가 쓴 글이고,
   기록은 그것을 보관하는 자리가 아닙니다.
8. **API key와 원시 내부 USD를 적지 않습니다.** bucket 증가분은 µUSD로
   적어도 됩니다(운영 기록이므로) — 사용자 응답에 그것이 없었다는 것이 §F의
   확인 항목입니다.
9. **trace ID는 적습니다.** turn마다 하나씩. 나중에
   `GET /api/admin/limit-decisions?traceId=`로 다시 볼 수 있는 유일한 열쇠이고,
   그 자체로는 아무 내용도 담고 있지 않습니다.

## 정답지 — §D 네 turn의 판정 기준

체크리스트의 prompt는 고정 문장입니다. 답 자체는 실행 시점의 웹 상태에 따라
달라지므로, **무엇이 맞는 답인지가 아니라 무엇이 확인 가능한지**를 적습니다.

### D-1 (Gemini 3.7 Flash)

| 확인할 것 | 통과 기준 |
|---|---|
| 가격 | 답이 US$5.00 / 1,000 requests를 말한다. 다른 값이면 **Brave가 가격을 바꿨다는 뜻**이므로 `lib/webSearchBackendPricing.ts`를 갱신하는 후속 티켓을 연다 — turn 실패가 아니다. |
| citation | 최소 1건, `brave.com` 또는 그 가격을 싣는 3자 페이지. URL이 200으로 열린다. |
| 실행 기록 | `executionKind: "app_managed"`, `searchBackend: "brave"`, `queryCount ≥ 1` |
| badge | "웹 검색함 · +8" |

### D-2 (Gemini 3.6 Flash)

| 확인할 것 | 통과 기준 |
|---|---|
| 범위 | 세 회사가 모두 나온다. 모델명이 오늘의 최신인지는 **판정 대상이 아니다** — 검색이 돌았는지가 대상이다. |
| query 수 | `backendRequestCount`가 2 이상 5 이하. 1이면 이 turn은 복수 query 사례가 아니므로 `n/a`로 적고 다시 시도한다. 6 이상은 **차단 실패**다. |
| citation | 회사마다 최소 1건. |

### D-3 (Gemini 3.1 Pro)

| 확인할 것 | 통과 기준 |
|---|---|
| 파일 | 확장자가 `.xlsx`이고 Excel 또는 LibreOffice가 **경고 없이** 연다. csv·md 대체는 실패. |
| 내용 | 4개 열이 있고, URL 열의 값이 D-2에서 본 citation과 같은 도메인이다. |
| 공존 | 같은 답변에 citation 목록과 다운로드 카드가 **둘 다** 있다. |
| tool 가용성 | 답변에 "파일을 만들 수 없다"는 문장이 없다. |

### D-4 (Gemini 3.5 Flash-Lite)

| 확인할 것 | 통과 기준 |
|---|---|
| 검색 | `executed: false`, `backendRequestCount: 0`, citation 목록 없음 |
| badge | "검색하지 않음 · 8크레딧 환불" |
| 크레딧 | 이 turn의 최종 차감 = 모델 기본 크레딧. 8이 더 붙어 있으면 **차단 실패**. |
| 답 | 존댓말 변환이 실제로 됐다. |

## 새 실행을 시작할 때

기록은 손으로 복사하지 말고 생성합니다.

```bash
node scripts/new-staging-verification-record.mjs --feature app-managed-web-search --sha <40자리 SHA>
```
