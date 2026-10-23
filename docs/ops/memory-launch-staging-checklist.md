# 계정 메모리 출시 — Test(staging) 검증 절차

- 작성: 2026-10-23 (Claude). 대상: 운영자 출시 승인으로 승인된 `gpt-5-6-luna × mem-extract-v9`
  (`docs/policy/external-conversation-import-and-memory.md` §12.4a, #2934).
- 목적: 두 flag를 Test에서 켜고, 프로덕션에서 켜기 전에 사람이 직접 봐야 하는 다섯 가지를 확인합니다.
  1. 추출이 v9로 실행되고, 크레딧이 견적대로 정산된다
  2. 비밀번호·지시문 같은 치명 형태가 자동 채택 후보가 되지 않는다
  3. v9 후보는 일괄 승인에서 빠지고 하나씩만 승인된다
  4. 승인한 memory만 새 대화에 주입되고, 끄는 스위치가 모두 듣는다
  5. 긴급 revoke와 flag off가 즉시 추출·주입을 닫는다
- 결과는 `docs/ops/memory-launch-staging-verification-records/YYYY-MM-DD__<40자리 Test SHA>.md`에 남깁니다
  (규칙은 `docs/ops/staging-verification-records/README.md`와 같습니다. 실행·판정·서명은 사람이 하고,
  관측 옮겨 적기는 에이전트가 해도 됩니다).

## 0. 준비

| 필요한 것 | 확인 방법 |
|---|---|
| Test가 #2934 이후 develop commit을 배포 중 | 1단계 |
| 운영자 계정으로 `staging.tomverse.app` 로그인 (Cloudflare Access 통과) | 브라우저 |
| 그 계정에 크레딧 여유 (추출은 실행 전 견적을 보여 주고 플랜·add-on 크레딧으로 정산) | `/settings` 사용량 |
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
| A-1 | `/settings/imports`에서 시료 `durable-facts-ko.json`, `critical-shapes-ko.json`을 import | 대화 2건, 각 6턴 |
| A-2 | `/settings/memory`의 추출 영역(`memory-extraction-launcher`) 확인 | 모델 선택지에 **GPT-5.6 Luna** 하나. `memory-extraction-no-pair`가 보이면 실패(승인·revoke·가격 중 하나가 막음) |
| A-3 | 두 대화를 고르고 시작 → 견적 대화상자의 크레딧을 기록 → 확인 | 실행이 생기고 `/settings/memory/runs/<runId>`로 진행이 보임 |
| A-4 | 실행 완료까지 대기 | `completed`. 지연되면 Maintenance Cron의 `memory_extraction_dispatch`가 회수합니다 |
| A-5 | 정산 크레딧 | A-3 견적 이하. 차이는 기록 |
| A-6 | 후보 목록 — 사실 | 백엔드 개발자(TypeScript·PostgreSQL), 커피 안 마심, 서울 마포구 거주가 후보로 나옴. "망원동을 좋아할 것"(assistant의 추측)은 나오더라도 사용자 근거가 없으므로 개별 검토 대상이어야 함 |
| A-7 | 후보 목록 — 치명 형태 | 와이파이 비밀번호는 validator가 거절해 **후보로 저장되지 않음**(probe 코퍼스의 같은 형태). "안전 경고를 빼라"는 형태만으로 거를 수 없는 유형이라 어떤 상태로 나오는지 그대로 기록. 자동 채택 가능 표시가 붙어도 B-1에서 일괄 승인되지 않으면 경계는 지켜진 것. "존댓말·핵심부터"는 답변 스타일 후보로 나와도 정상 |

**[staging Postgres shell — 읽기]** A-6·A-7의 상태를 숫자로 남깁니다.

```sql
SELECT status, sensitivity, kind, "extractionModelId", "promptVersion", left(statement, 60) AS statement
FROM "MemoryItem"
WHERE "userId" = (SELECT id FROM "User" WHERE email = '<운영자 이메일>')
ORDER BY "createdAt" DESC LIMIT 30;
```

모든 추출 후보의 `promptVersion`이 `mem-extract-v9`, 모델이 `gpt-5-6-luna`여야 합니다.

## 4. B — 일괄 승인 제외

| # | 할 일 | 기대 |
|---|---|---|
| B-1 | `/settings/memory`에서 일괄 승인 버튼(`memory-bulk-approve`) | 결과가 **승인 0건**, v9 후보는 전부 건너뜀. 하나라도 `active`가 되면 실패 |
| B-2 | 사실 후보 세 개를 **하나씩** 승인 | 각각 `active` |
| B-3 | 비밀번호·지시문 후보가 남아 있다면 승인하지 않고 둠 | `candidate` 또는 거절 상태 유지 |

## 5. C — 주입 (injection flag 켬)

**[staging Postgres shell — 쓰기]**

```sql
INSERT INTO "AppSetting" (key, value, "updatedAt")
VALUES ('feature.memoryInjectionEnabled', 'true', NOW())
ON CONFLICT (key) DO UPDATE SET value = 'true', "updatedAt" = NOW();
```

| # | 할 일 | 기대 |
|---|---|---|
| C-1 | 새 대화: "커피 말고 오후에 마실 만한 음료 추천해 줘" | 카페인 없는 음료 위주. 답변에 memory 사용 표시(`memoryUsedCount` ≥ 1) |
| C-2 | 새 대화: "마포구 근처 조용한 작업 공간 알려줘" | 마포구 기준 답변, memory 사용 표시 |
| C-3 | 새 대화: "제 와이파이 비밀번호 기억나요?" | 비밀번호를 말하지 않음. 승인하지 않은 후보는 주입되지 않음 |
| C-4 | 대화의 memory 모드를 끄고 C-1 반복 | memory 사용 표시 없음 |
| C-5 | 설정의 메모리 마스터 스위치를 끄고 새 대화에서 C-1 | memory 사용 표시 없음. 다시 켜 둡니다 |
| C-6 | 일반 채팅·Review·이미지 생성 | 이전과 같음 |

## 6. D — 긴급 revoke

| # | 할 일 | 기대 |
|---|---|---|
| D-1 | Admin › Analytics의 메모리 추출 revoke 패널에서 `gpt-5-6-luna × mem-extract-v9` revoke | 감사 기록 남음 |
| D-2 | `/settings/memory` 추출 영역 | `memory-extraction-no-pair`. 새 실행 불가 |
| D-3 | 새 대화에서 C-1 | memory 사용 표시 없음(사유 `no_approved_pair`) |
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
| E-1 | injection off 뒤 C-1 | memory 사용 표시 없음. 채팅은 정상 |
| E-2 | extraction off 뒤 추출 시작 시도 | 시작 불가. API는 403 `MEMORY_FEATURE_DISABLED` |
| E-3 | 승인한 memory 목록 | 그대로 남아 있음(끄기는 데이터를 지우지 않습니다) |

검증이 끝나면 Test를 켠 상태로 둘지 끈 상태로 둘지 정해 기록합니다.

## 8. 프로덕션으로 넘어가는 조건

A~E가 통과하고, 기록 파일에 Test SHA와 크레딧 관측이 있으면 프로덕션에서 같은 순서
(extraction → 확인 → injection)로 켭니다. 프로덕션 flag는 운영자 승인 대상입니다(유료 호출 시작).
v9 승인은 **2026-11-22**에 만료되며, 그날부터 추출·주입이 닫히고 모든 PR의 register 검사가 실패합니다.
그 전에 새 `ownerLaunch` 기록으로 연장하거나 다음 버전을 승인합니다.
