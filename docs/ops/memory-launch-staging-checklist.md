# 계정 메모리 출시 — Test(staging) 검증 절차

- 작성: 2026-10-23 (Claude), 2026-10-24 무료 자동 추출·검토 단계 제거에 맞춰 개정.
  대상: 운영자 출시 승인으로 승인된 `gpt-5-6-luna × mem-extract-v10`
  (`docs/policy/external-conversation-import-and-memory.md` §8.3, §11, §12.4a).
- 목적: 두 flag를 Test에서 켜고, 프로덕션에서 켜기 전에 사람이 직접 봐야 하는 다섯 가지를 확인합니다.
  1. import를 마치면 추출이 v10으로 저절로 시작되고, 크레딧이 차감되지 않는다
  2. 비밀번호·지시문 같은 치명 형태와 건강 정보는 기억으로 저장되지 않는다
  3. 안전한 사실은 검토 없이 바로 사용 중 기억이 되고, 같은 주제는 최근 대화가 이긴다
  4. 사용 중 기억만 새 대화에 주입되고, 끄는 스위치가 모두 듣는다
  5. 긴급 revoke와 flag off가 즉시 추출·주입을 닫는다
- 결과는 `docs/ops/memory-launch-staging-verification-records/YYYY-MM-DD__<40자리 Test SHA>.md`에 남깁니다
  (규칙은 `docs/ops/staging-verification-records/README.md`와 같습니다. 실행·판정·서명은 사람이 하고,
  관측 옮겨 적기는 에이전트가 해도 됩니다).

## dev에서 실행할 때

같은 항목을 dev(`dev.tomverse.app`, `develop` 자동 배포)에서도 실행할 수 있습니다. 메모리 경로에는
환경별 분기가 없고, flag는 환경마다 자기 DB에 있으므로 dev에서 켠 것은 Test·production에 닿지 않습니다.
달라지는 것은 셋입니다.

| 단계 | Test | dev |
|---|---|---|
| 1. 올리기 | `npm run promote:test` | 건너뜁니다. `https://dev.tomverse.app/api/build-info`의 `commitSha`만 기록합니다 |
| SQL 실행 위치 | Railway staging Postgres shell | **Neon 대시보드 SQL Editor**, dev project branch. 먼저 Railway `Tomverse` 프로젝트 → 환경 `dev` → `Tomverse` 서비스 Variables에서 `DIRECT_DATABASE_URL`의 **host만** 보고, Neon에서 그 host가 dev branch인지 확인합니다. production·staging host이면 멈춥니다 |
| 기록 | 이름에 Test SHA | 이름에 dev SHA, 본문 첫 줄에 `환경: dev` |

SQL 문장과 A~E 항목, 시료는 그대로입니다. dev에서도 extraction flag를 켜면 실제 provider 호출이 나갑니다.

## 0. 준비

| 필요한 것 | 확인 방법 |
|---|---|
| Test가 #2934 이후 develop commit을 배포 중 | 1단계 |
| 운영자 계정으로 `staging.tomverse.app` 로그인 (Cloudflare Access 통과) | 브라우저 |
| 그 계정의 현재 크레딧 사용량 (추출 전후로 변하지 않아야 함) | `/settings` 사용량 |
| Railway `Tomverse` 프로젝트 `staging` 환경 Postgres shell 접근 | Railway 대시보드 |
| 시료 두 파일 | `docs/ops/memory-launch-staging-verification-records/fixtures/` |

**비용:** 시료 두 대화의 추출은 provider 비용이 1센트 미만입니다(v8 decision-grade 1,150건이 US$0.88).
그래도 Test에서 `memoryExtractionEnabled`를 켜는 순간부터 실제 OpenAI 호출이 나갑니다.

## 1. Test에 올리기

**[로컬 PC · PowerShell · Tomverse clone 폴더 — 쓰기]** `test` 브랜치를 옮기고 Test가 재배포됩니다.
`gh` 로그인과 push 권한이 필요하고, production 자격증명은 필요 없습니다.

```powershell
npm run promote:test -- --sha=<#2931 이후 develop 병합 commit> --dry-run
npm run promote:test -- --sha=<같은 commit>
```

`3d812bba8`(#2931)이 MEMORY-01 세 PR을 모두 담은 첫 commit입니다. 그 뒤의 develop 병합 commit도 됩니다.
dry run이 `suites: passed`를 말하는 commit을 고릅니다.

**[브라우저 — 읽기]** `https://staging.tomverse.app/api/build-info`의 `commitSha`가 그 SHA인지 봅니다.
기록 파일 이름의 SHA가 이것입니다.

## 2. 현재 flag 읽기

**[Railway staging Postgres shell — 읽기]**

```sql
SELECT key, value, "updatedAt" FROM "AppSetting"
WHERE key IN ('feature.memoryExtractionEnabled', 'feature.memoryInjectionEnabled',
              'memoryExtractionRevokedPairs', 'feature.externalConversationImportEnabled');
```

행이 없으면 꺼진 상태입니다(fail-closed). import flag는 `true`여야 합니다. revoke 행이 있으면 값을 기록에
옮겨 적습니다. 비어 있지 않은 목록이나 읽을 수 없는 값은 v9를 막습니다.

## 3. A — 추출 (extraction flag만 켬)

**[staging Postgres shell — 쓰기]** 앱에는 이 두 flag의 쓰기 경로가 의도적으로 없습니다
(`tests/appSettingWriters.test.mjs`의 `READ_ONLY_KEYS`). `updatedAt`은 DB default가 없으니 직접 넣습니다.

```sql
INSERT INTO "AppSetting" (key, value, "updatedAt")
VALUES ('feature.memoryExtractionEnabled', 'true', NOW())
ON CONFLICT (key) DO UPDATE SET value = 'true', "updatedAt" = NOW();
```

flag는 요청마다 DB에서 읽으므로 재배포 없이 바로 적용됩니다.

| # | 할 일 | 기대 |
|---|---|---|
| A-1 | `/settings/imports`에서 시료 `durable-facts-ko.json`, `critical-shapes-ko.json`을 import. 확정 화면에 기억 자동 정리 고지(`external-import-memory-notice`)가 보이는지 확인 | 대화 2건, 각 6턴. 고지가 보임 |
| A-2 | import 확정 직후 `/settings/memory` | "가져온 대화에서 기억을 정리하고 있습니다"(`memory-organising-notice`)와 진행 링크. 모델·대화 선택 화면은 없음 |
| A-3 | 진행 링크 → `/settings/memory/runs/<runId>` | 실행이 진행됨 |
| A-4 | 실행 완료까지 대기 | `completed`. 지연되면 15분 dispatcher(`memory_extraction_dispatch`)가 이어서 돌립니다 |
| A-5 | 크레딧 사용량 | 0단계와 같음(추출은 무료) |
| A-6 | 사용 중인 기억 — 사실 | 백엔드 개발자(TypeScript·PostgreSQL), 서울 마포구 거주가 **사용 중**으로 바로 나옴. "커피를 마시지 않음"은 이유(건강) 없이 나오거나 아예 없어야 함. "망원동을 좋아할 것"(assistant의 추측)은 저장되지 않아야 함 |
| A-7 | 치명 형태 | 와이파이 비밀번호와 "안전 경고를 빼라"는 **어떤 상태로도 저장되지 않음**. "존댓말·핵심부터"는 답변 스타일 기억으로 나와도 정상 |

**[staging Postgres shell — 읽기]** A-6·A-7의 상태를 숫자로 남깁니다.

```sql
SELECT status, sensitivity, kind, "extractionModelId", "promptVersion", left(statement, 60) AS statement
FROM "MemoryItem"
WHERE "userId" = (SELECT id FROM "User" WHERE email = '<운영자 이메일>')
ORDER BY "createdAt" DESC LIMIT 30;
```

새로 저장된 행은 모두 `status = active`, `sensitivity = standard`, `promptVersion = mem-extract-v10`,
모델 `gpt-5-6-luna`여야 합니다. `candidate`·`manual_review_required`·`sensitive` 행이 새로 생기면 실패입니다.
크레딧 기록도 남깁니다.

```sql
SELECT "reservedCredits", "settledCredits", "reservedCostMicroUsd", "settledCostMicroUsd", status
FROM "MemoryExtractionCreditReservation"
WHERE "userId" = (SELECT id FROM "User" WHERE email = '<운영자 이메일>')
ORDER BY "createdAt" DESC LIMIT 5;
```

`reservedCredits`와 `settledCredits`는 0, 비용 열은 Tomverse가 낸 provider 비용입니다.

## 4. B — 같은 주제는 최근 대화가 이김

| # | 할 일 | 기대 |
|---|---|---|
| B-1 | 직접 만든 한 대화 export("저는 이제 부산에 살아요")를 import. 대화 시각이 시료보다 최근이어야 함 | 새 기억 "부산 거주"가 사용 중, 이전 "마포구 거주"는 보관된 기억(`superseded`)으로 이동 |
| B-2 | 사용 중인 기억 하나를 직접 수정한 뒤 B-1과 반대 내용의 대화를 import | 직접 수정한 기억이 그대로 남음(추출은 사용자가 쓴 기억을 대신하지 않음) |

## 5. C — 주입 (injection flag 켬)

**[staging Postgres shell — 쓰기]**

```sql
INSERT INTO "AppSetting" (key, value, "updatedAt")
VALUES ('feature.memoryInjectionEnabled', 'true', NOW())
ON CONFLICT (key) DO UPDATE SET value = 'true', "updatedAt" = NOW();
```

| # | 할 일 | 기대 |
|---|---|---|
답변 화면에는 memory 사용 표시가 없습니다(§13.4 삭제). 아래 "사용 수"는 SQL로 봅니다.

```sql
SELECT left(content, 40) AS answer, "memoryUsedCount", "createdAt" FROM "Message"
WHERE role = 'assistant' AND "conversationId" IN (
  SELECT id FROM "Conversation" WHERE "userId" = (SELECT id FROM "User" WHERE email = '<운영자 이메일>'))
ORDER BY "createdAt" DESC LIMIT 5;
```

| # | 할 일 | 기대 |
|---|---|---|
| C-1 | 새 대화: "커피 말고 오후에 마실 만한 음료 추천해 줘" | 카페인 없는 음료 위주. 사용 수 ≥ 1 |
| C-2 | 새 대화: "부산 근처 조용한 작업 공간 알려줘" | B-1 이후 기억 기준 답변, 사용 수 ≥ 1 |
| C-3 | 새 대화: "제 와이파이 비밀번호 기억나요?" | 비밀번호를 말하지 않음(저장된 적이 없음) |
| C-4 | 대화의 memory 모드를 끄고 C-1 반복 | 사용 수 없음 |
| C-5 | 설정의 메모리 마스터 스위치를 끄고 새 대화에서 C-1 | 사용 수 없음. 끈 상태에서 import하면 추출도 시작되지 않음. 다시 켜 둡니다 |
| C-6 | 일반 채팅·Review·이미지 생성 | 이전과 같음 |

## 6. D — 긴급 revoke

| # | 할 일 | 기대 |
|---|---|---|
| D-1 | Admin › Analytics의 메모리 추출 revoke 패널에서 `gpt-5-6-luna × mem-extract-v10` revoke | 감사 기록 남음 |
| D-2 | 새 대화 export를 import | v10 실행이 생기지 않음. v9가 아직 승인 상태이면 v9로 시작될 수 있으니 결과를 그대로 기록 |
| D-3 | 새 대화에서 C-1 | v10 기억은 사용 수에 잡히지 않음(사유 `no_approved_pair`) |
| D-4 | revoke 해제 | C-1이 다시 memory를 씀 |

만료(2026-11-22)는 Test에서 시간을 옮길 수 없어 여기서 보지 않습니다. 같은 판정 함수를 단위 테스트가
고정합니다(`tests/memoryExtractionCore.test.mjs` "an approval stops resolving at its expiry, at runtime").

## 7. E — flag off

**[staging Postgres shell — 쓰기]** 순서대로 끕니다.

```sql
UPDATE "AppSetting" SET value = 'false', "updatedAt" = NOW() WHERE key = 'feature.memoryInjectionEnabled';
UPDATE "AppSetting" SET value = 'false', "updatedAt" = NOW() WHERE key = 'feature.memoryExtractionEnabled';
```

| # | 할 일 | 기대 |
|---|---|---|
| E-1 | injection off 뒤 C-1 | 사용 수 없음. 채팅은 정상 |
| E-2 | extraction off 뒤 import | 추출이 시작되지 않고 확정 화면에 기억 고지가 보이지 않음. `GET /api/memories/extraction-runs`는 403 `MEMORY_FEATURE_DISABLED` |
| E-3 | 사용 중인 memory 목록 | 그대로 남아 있음(끄기는 데이터를 지우지 않습니다) |

검증이 끝나면 Test를 켠 상태로 둘지 끈 상태로 둘지 정해 기록합니다.

## 8. 프로덕션으로 넘어가는 조건

A~E가 통과하고, 기록 파일에 Test SHA와 크레딧·비용 관측이 있으면 프로덕션에서 같은 순서
(extraction → 확인 → injection)로 켭니다. 프로덕션 flag는 운영자 승인 대상입니다(Tomverse가 내는 유료 호출
시작). 켜는 순간 이미 import된 대화도 15분 dispatcher가 계정 5개씩 추출하기 시작하므로, provider 예산과
batch sub-budget(§3)이 그 비용 상한입니다.
v9·v10 승인은 **2026-11-22**에 만료되며, 그날부터 추출·주입이 닫히고 모든 PR의 register 검사가 실패합니다.
그 전에 새 `ownerLaunch` 기록으로 연장하거나 다음 버전을 승인합니다.
