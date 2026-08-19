# 외부 대화 가져오기 — 후속 작업, 2026-08-19

2026-08-19 staging 검증 회차를 닫으면서 남긴 목록입니다. **덮어쓰지 않습니다.**
나중 회차가 여기 적힌 것이 바뀐 걸 발견하면 자기 날짜의 기록을 새로 씁니다.

이 문서는 판정이 아니라 **다음에 손댈 것의 목록**입니다. 판정은 회차 기록에
있습니다.

- 회차 기록: `docs/ops/staging-verification-records/2026-08-19__ae649bed6d6dbd4c1d6d0139b1044ca22b5142fc.md`
- 체크리스트: `docs/ops/external-import-staging-checklist.md`
- 정책: `docs/policy/external-conversation-import-and-memory.md`,
  `docs/policy/external-import-gemini-a2.md`

## 기준점

```
origin/main     ae649bed6d6dbd4c1d6d0139b1044ca22b5142fc
origin/develop  717d534662b6ad7be6c91107cc11d59ed7e46d6e
verifiedAt      2026-08-19T13:43:11Z   (git fetch && git rev-parse)
```

staging·production 모두 같은 SHA를 서빙합니다
(`verifiedAt 2026-08-19T13:43:11Z`, `curl .../api/build-info`).

```
staging     ae649be  deployment 307c9dda-d2d7-41ba-a0da-163f4b6c0e1c  deployedAt 2026-08-19T05:53:07Z
production  ae649be  deployment 00421685-a905-413c-b0cd-1e396f96b7ea  deployedAt 2026-08-19T06:01:21Z
```

**즉 이 회차가 staging에서 확인한 코드는 production에 배포된 그 코드입니다.**
아래 결함은 전부 production에 존재합니다.

`feature.externalConversationImportEnabled`는 2026-08-19T12:06Z 기준 **on**입니다
(중간에 rollback drill로 잠시 off 후 복구).

## 1. 발견 5건

전부 미발행입니다. 데이터 손실을 일으키는 것은 없습니다.

### 발견-D — rollback 상태에서 export 버튼이 사라진다 (제품 결함, 한 줄)

`components/imports/ExternalImportManagement.tsx`

```
:480  {conversationsState.kind !== "hidden" && (      <- 대화 목록 섹션
:491      {conversationsState.kind === "ready" && ... ( <- 그 안에 「전체 내려받기」
:499          window.location.href = "/api/imports/external/export"
```

flag off면 `/api/external-conversations`가 403 → `conversationsState = "hidden"`
→ 섹션 전체가 사라지고 export 버튼도 함께 사라집니다. 그런데 export API에는
flag gate가 없습니다(`app/api/imports/external/export/route.ts` 전체에
`assertExternalImportEnabled` 없음). 같은 파일 상단 주석이 "the history list,
delete and export stay reachable so a rollback never strands imported data
(§15)"라고 적은 것과 어긋납니다.

**고치는 법**: 버튼을 대화 목록 상태가 아니라 이력 존재 여부에 묶습니다.
데이터가 고립되지는 않으므로(계정 전체 내려받기가 남아 있음) 급하지 않지만
비용이 거의 없습니다.

### 발견-E — import 지표를 그리는 화면이 없다 (제품 결함, 중간)

`components/admin/AdminMemoryImportPanel.tsx`

```
:163  fetch("/api/admin/external-imports", { cache: "no-store" })
:191  setImports(importData)
:435  {imports === null && ( "The import report is unavailable in this environment" )}
```

`imports`가 쓰이는 곳은 `null` 검사 한 줄뿐입니다. provider·parserVersion 분해,
`duplicateShare`·`truncationShare`, 세 bucket, `quota_rejected`·`staging_expired`
카운터 중 화면에 그려지는 것이 하나도 없습니다. 타입도
`{ windowDays?: number; [key: string]: unknown }`이라 필드를 모릅니다.

API가 정상이면 화면에 **아무 흔적도 없습니다** — "unavailable" 문구조차 `null`일
때만 나옵니다. 이 회차에서 F 지표를 콘솔로 직접 호출해야 했던 것이 그 증거입니다.

같은 파일 상단 주석이 밝힌 존재 이유가 정확히 그 반대입니다.

> A metric nobody reads is not a metric, so this panel is the other half of both.

memory 쪽 렌더링(`Stat`, `byStatus` 테이블, counters 목록)이 이미 있으므로 같은
컴포넌트를 재사용하면 됩니다. API 응답 shape는
`lib/externalImportMetricsCore.ts`의 `ExternalImportSummary`.

### 발견-B — 감사 로그 action 이름이 바뀐 것을 가리키지 않는다

`app/api/admin/app-settings/route.ts`

```
:107  action: "app_settings.update_started"
:128  action: "app_settings.guest_default_model.updated"
```

platform defaults와 feature flag 전체가 한 PUT을 지나가면서 항상 이 두 줄만
남깁니다. external import flag만 켠 변경도
`app_settings.guest_default_model.updated`로 기록됩니다. 실제 값은 `metadata`
안에만 있고 목록의 ACTION·SUMMARY 열에는 안 보입니다.

`metadata`가 요청 body 전체라 **바뀐 값과 그대로인 값을 구분하지 못합니다.**
연속한 두 항목을 사람이 비교하면 복원은 되지만, 그 사이에 다른 변경이 없었다는
걸 이미 알고 있을 때만 성립합니다.

**고치는 법**: flag별 action을 쓰거나 before/after diff를 metadata에 남깁니다.

### 발견-C — 진입점을 숨긴 뒤에도 그 기능을 설명하는 문구가 남는다

flag off일 때 Data 탭의 「다른 AI 서비스에서 가져오기」 행은 사라지지만, 그룹
설명 「가져온 대화와 계정 기억입니다」와 기억 행 설명 「가져온 대화에서 추출한
기억 후보를…」은 그대로 남습니다. flag를 한 번도 켠 적 없는 계정에서는 도달할
방법이 없는 기능을 설명하는 셈입니다.

`locales/*.ts`의 `settingsNav.dataAndPersonalizationDescription`,
`memoryReview.dataTabDescription`. 문구를 조건부로 할지 그대로 둘지는 설계
결정이므로 단정하지 않았습니다.

### 발견-A — `notImportableBadge`가 쓰이지 않는 문자열이다

`locales/ko.ts:1128` 외 7개 locale에 `notImportableBadge: "가져올 수 없음"`이
번역까지 들어 있는데 코드 어디에서도 쓰지 않습니다.

```
grep -rn "notImportableBadge" --include=*.tsx --include=*.ts . | grep -v locales/
→ 결과 없음
```

체크리스트 C절이 「"가져올 수 없음"으로 표시되고」라고 적고 있어 이 배지의 존재를
전제합니다. 실제 화면은 배너·행 경고·`disabled` 체크박스 세 층으로 같은 사실을
전달하므로 해당 항목은 pass입니다. **문자열을 지우든 배지를 붙이든 한쪽으로
정리하고 체크리스트 문구도 실제 화면과 맞춥니다.**

## 2. 확인하지 않은 체크리스트 항목

준비물별로 묶었습니다. 같은 준비물을 한 번 갖추면 그 묶음이 함께 끝납니다.

### 두 번째 계정이 필요 — 1항목

- D절 「다른 계정으로 importId·conversationId를 직접 조회하면 404가 온다
  (IDOR — 존재 여부가 새지 않는다)」

소유권이 서버에서 판정되는 것은 코드로 확인했습니다(`loadOwnedImport` 및 각
조회 경로의 소유자 조건). 확인되지 않은 것은 **존재 여부가 새지 않는지**이며,
404와 403의 차이는 코드를 읽어서 대체되지 않습니다.

### 서버 로그 열람이 필요 — 1항목

- D절 「구조화 로그에 filename·대화 제목·본문·외부 ID·digest·fingerprint가
  남지 않는다」

인접 사실로 admin 지표 API가 쿼리 계층에서 내용을 배제하는 것은 확인했으나
(`lib/externalImportMetrics.ts:118-132`) 로그 경로에 대한 증거는 아닙니다.

### 50 MB를 채워야 함 — 5항목

- C절 「(선택) 잔여 quota 초과 시 UI 차단 + 서버 409
  `EXTERNAL_IMPORT_QUOTA_EXCEEDED` + admin `quota_rejected` 증가」
- E절 quota 관련 4항목(선택량·남은 공간 병기, 업로드 중 거부, 전송 실패 재시도,
  finalize quota 거부)

대용량 합성 export가 필요합니다. `scripts/make-external-import-fixtures.mjs`에
case를 추가하면 만들 수 있습니다. 실패해도 사용자가 막히거나 불편한 수준이며
데이터를 잃지 않습니다.

### 24시간 경과가 필요 — 1항목

- C2절 「TTL이 지난 작업은 조용히 사라지지 않고 "만료되어 다시 시작해야 함"으로
  표시된다」

staging TTL은 idle 24시간·absolute 기한이라 단일 세션에서 도달할 수 없습니다.
확인하려면 열린 import를 하나 남겨 두고 다음 날 관리 화면을 봅니다. 개인
데이터가 없는 빈 import를 쓰면 정리 부담이 없습니다.

### 기기·locale 준비가 필요 — 2항목

- F절 「모바일 320px 폭 레이아웃, 대형 archive에서 데스크톱 권장 안내」
- F절 「ko/en 두 locale로 대표 화면 렌더링」

이 회차는 전 구간을 한국어로만 수행했습니다. 브라우저 기기 에뮬레이션(Pixel 9,
675x1194)으로 wizard 일부를 조작했으나 320px과 데스크톱 권장 안내는 보지
않았습니다.

### 준비물 없음 — 3항목

- B절 「Data 탭에 진입점과 사용량 요약이 나타나고 `/settings/imports`로
  이동한다」 — 관리 화면과 wizard 이동은 관측했으나 **Data 탭 진입점 자체를
  캡처하지 않음**. 화면 한 장이면 끝납니다.
- F절 「`external_import_step_entered`/`_abandoned`에 `import_step` 외 속성이
  없다」 — 이벤트 발생은 HAR에 잡혀 있으나, `properties`에 함께 실린
  `market_tier`·`paid_marketing_eligible`·`experiment_variant`·`import_provider`가
  **전역 공통 속성인지 이 이벤트 고유 속성인지** 구분하지 않았습니다. 항목이
  금지하는 것은 후자입니다. analytics 전송 코드 한 곳을 읽으면 끝납니다.
- F절 「15분 maintenance 결과에 `externalImportStaging` sweep 수치가 보인다」

### 사전 조건 전체 — 8항목

migration 선후, 검증 계정 준비, 정리 담당자·기한 지정 등을 기록하지 않았습니다.
정식 실행을 할 때 함께 채웁니다.

### Gemini(H2) — 10항목, 성격이 다름

**Gemini는 이 flag와 함께 서비스합니다(운영 결정).** 이 회차가 확인한 것은 안내
카드 한 건이지만, 나머지는 2026-08-18 회차(`79d967f`)가 실제 Takeout ZIP
(24,645,345 B → provider Gemini, 대화 50개 · 약 5.4 MB, 경고 다섯 줄 기준값
일치)으로 확인했고 **그 결과가 이 빌드에 이어집니다.**

```
git diff --name-only 79d967f..ae649be | grep -i "import\|adapter"
→ .github/audits/external-import-gemini-copy-2026-08-16.md
  docs/ops/external-import-staging-checklist.md
```

문서 2건뿐이고 adapter·pipeline·limits·digest·컴포넌트·API 라우트에 코드 변경이
없습니다.

**코드 무변경이 재실행을 대신하지는 않습니다.** 두 회차의 DB 상태·계정·런타임
설정이 같다는 보장이 없고, 어제 회차가 덮지 않은 것(아카이브 미업로드, ko/en 두
계정)은 오늘도 덮이지 않았습니다. 다음 Gemini 관련 코드 변경이 들어오는 순간 이
연계는 끊어지므로, **그때 H2를 다시 실행합니다.**

## 3. 소급 대조가 안 되는 값 두 개

회차 기록의 F-1 행에 적어 두었으나 여기에도 남깁니다. 다시 세려고 시도하지
않기 위해서입니다.

- **chatgpt `duplicatesSkipped` 13** — C-3에서 15개를 재선택했다고 봤으나 지표는
  13입니다. 전부 중복일 때 확인 화면이 개수를 말하지 않으므로(`stagedSummary`가
  그 분기에 없음) 사후 확인이 불가능합니다. 실제 선택이 13이었을 가능성이 가장
  높습니다.
- **claude `finalizedConversations` 8** — 세션에서 추적한 것은 6입니다.

원인은 두 삭제가 지표에 반대로 작용하기 때문입니다.

| 삭제 | 지표 |
|---|---|
| 완료 import 삭제 | 행이 사라져 **기여분도 사라짐** |
| 대화만 삭제 | 행이 남아 **기여분 유지** |

만들고 지우기를 반복한 회차에서는 계정의 현재 대화 수와 지표 누적값이 원리적으로
일치하지 않습니다. **다음 회차는 검증 전용 계정을 쓰거나, 지표를 볼 시점을
먼저 정하고 그때까지 삭제하지 않는 편이 낫습니다.**

## 4. 남은 정리 의무

회차 기록의 정리 표가 `미완료`입니다. 실제 개인 export를 썼으므로 대상이 원본
파일만이 아닙니다.

- staging 계정의 대화 21개(실제 ChatGPT·Claude export에서 온 18개 포함)
- 이력 카드와 취소된 import
- HAR 파일 — **요청 body에 대화 ID가 들어 있습니다**
- 스크린샷에 찍힌 대화 제목·본문, 그리고 이메일 주소 1건
- 로컬 export 원본·압축 해제본·브라우저 다운로드 사본
- 이 회차에 만든 fixture 파일(합성이라 개인 데이터는 없음)

정리 후 회차 기록의 「staging 데이터 삭제 (UTC)」와 「로컬 파일 정리 (UTC) /
확인자」를 채웁니다.

## 5. 다시 쓸 수 있는 도구

이 회차에서 만들어 저장소에 넣은 것들입니다.

- `scripts/make-external-import-fixtures.mjs` — 합성 `conversations.json` 생성기.
  `--case c1`(truncation 경계), `--case c4`(lineage·중복), `--case d1`(XSS payload
  10종). 각 case가 기대 경계를 함께 출력합니다.
- `docs/ops/verification-probes/external-import-c2-seal-probe.js` — seal 상태 전이
  probe. 로그인 세션의 DevTools 콘솔에 붙여넣으면 전용 import를 만들어
  네 가지 전이를 검사하고 스스로 정리합니다.
- `npm run new:staging-verification-record -- --feature <key> --sha <40자리>` —
  회차 기록 생성기. SHA는 **묻지 말고** `curl .../api/build-info`에서 읽습니다.
  공개 엔드포인트입니다(STG-F010 / AUD-R002).

## 6. 다음 회차를 시작할 때

1. `curl https://staging.tomverse.app/api/build-info`로 SHA·deployment ID 확보
2. `npm run new:staging-verification-record`로 기록 생성
3. 이 문서의 「확인하지 않은 항목」에서 **준비물이 갖춰진 묶음부터** 고름
4. 되돌릴 수 없는 것을 먼저 — 저장 계약, fail-closed, 렌더링 안전성. 문구·
   레이아웃·지표는 나중
5. 발견은 회차 기록의 판정 절에 근거와 함께 남기고, 이 문서는 건드리지 않음
