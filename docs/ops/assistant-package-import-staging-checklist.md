# 외부 assistant package 가져오기 staging 검증 체크리스트

`docs/policy/assistant-package-import.md`가 요구하는 검증입니다. **이
체크리스트의 실행과 승인은 production에서
`feature.assistantPackageImportEnabled`를 켜기 위한 전제 조건**이며, 같은 문서
§12가 그 flag를 끄는 행위(rollback)가 무엇을 하고 무엇을 하지 않는지 정합니다.

이 기능은 **production에서 한 번도 켜진 적이 없습니다.** flag는 기본값이
없는 `AppSetting` 키이고, 값이 `"true"`가 아닌 모든 경우 — 행이 없는 경우
포함 — 에 route가 404입니다. 즉 지금까지 이 기능의 production 동작은 관측된
적이 없고, 이 체크리스트는 그 공백을 staging에서 먼저 메우기 위한 것입니다.

실행·판정·서명은 사람이 합니다. 에이전트는 항목을 갱신하고 실행자가 보고한
관측을 기록 초안에 옮겨 적을 수 있습니다. 쓸 수 없는 것은 **판정과 서명**뿐이며,
지어낸 관측은 어느 쪽에서도 허용되지 않습니다 — 기록 README의 5번 참조.

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 체크박스는 항상 비어 있고, 그것이 이 파일의
상태입니다. 실행 결과는 `assistant-package-import-staging-verification-records/`
에 **날짜와 전체 deploy SHA로 이름 붙인 별도 파일**로 남습니다.

- **template revision**: `2026-08-24b` — 항목이 바뀌면 이 값을 올리고, 실행
  기록은 자기가 어느 revision으로 실행됐는지 적습니다.

  `2026-08-24a` → `2026-08-24b`: §B-1이 script를 "개수로만" 나타난다고 적어
  두었지만, `docs/policy/assistant-package-import.md` §7 표의 `scripts/**` 행은
  **개수와 경로**를 표시하라고
  정합니다. 낡은 기대대로 읽으면 정책이 요구한 동작을 `fail`로 적게 됩니다.

  `2026-08-24` → `2026-08-24a`: §A-2·A-3이 기대하는 오류 코드가 틀려 있었고
  (`ASSISTANT_PROFILES_DISABLED`, 실제는 `ASSISTANT_PACKAGE_IMPORT_DISABLED`),
  §G가 서로 다른 세 가지를 한 갈래로 묶고 있었습니다. **낡은 기대는 올바른
  동작을 `fail`로 적히게 만듭니다** — assistant profile 체크리스트에서 이미 한
  번 그렇게 됐습니다. 그래서 문구 수정이라도 revision을 올립니다.
- 실행 방법과 파일 이름 규칙:
  `assistant-package-import-staging-verification-records/README.md`
- 기록 template:
  `assistant-package-import-staging-verification-records/_record-template.md`

## 시료는 실행자가 만들지 않습니다

**이 회차에 필요한 package는 전부 저장소가 만들어 줍니다.** 명령 하나입니다.

```
npm run make:assistant-package-staging-fixtures
```

`.tmp/assistant-package-staging-fixtures/` 아래에 package 여섯 개와
`MANIFEST.md`(정답지)가 생깁니다. 정답지에는 각 package가 무엇을 담고 있고
**무엇이 왜 거절되거나 손실로 보고되어야 하는지**가 적혀 있으므로, 실행자는
답을 판정할 근거를 가지고 시작합니다. 정답지 없이 판정하면 그것은 판정이
아니라 추측입니다.

생성물은 저장소에 commit 하지 않습니다 — 명령이 언제든 같은 바이트를
다시 만들고, `MANIFEST.md`가 각 파일의 SHA-256을 함께 적습니다.

## 무엇이 되돌릴 수 없는가

**이 기능에서 되돌릴 수 없는 것은 두 가지입니다.**

**1. 유출.** package는 사용자가 다른 도구에서 가져온 파일이고, 그 안에는
자격증명이 들어 있을 수 있습니다. 이 기능이 자격증명을 로그·오류 응답·
provenance 행에 옮겨 적으면 회수가 성립하지 않습니다. §C가 그것을 봅니다.

**2. 남의 profile을 지우는 것.** `merge` mode의 취소·만료는 **이 import가 만든
파일만** 지워야 합니다(정책 §5.5). mode 판정이 틀리면 취소가 사용자의 기존
profile을 지우고, `AssistantProfile` 삭제는 되돌릴 수 없습니다. §E가 그것을
봅니다.

**되돌릴 수 있는 것**은 나머지 전부입니다. 라벨·손실 보고서 문구·단계 배치·
목록 정렬은 고쳐서 배포하면 끝납니다. 실패한 가져오기가 남긴 staging 행과
객체도 만료 sweep이 가져가므로 되돌릴 수 있습니다.

`merge`가 만드는 revision이 대상 profile의 이름·지시문·manifest를 바꾸는 것은
**되돌릴 수 있습니다** — 이전 revision이 이력에 남아 있습니다. 그래서 차단이
아니라 §F의 공개 항목입니다.

## 무엇이 flag를 막고, 무엇이 막지 않는가

**항목 43개가 전부 릴리스 차단 사유는 아닙니다.** 목록만 보면 전부 그렇게
보이고, 그것이 1인 조직에서 검증을 감당 못 할 일로 만듭니다. 그래서 여기에
갈라 적습니다.

기준은 위와 같습니다 — **되돌릴 수 있는가.**

### 차단 (flag를 켜기 전에 반드시)

| 구획 | 왜 차단인가 |
|---|---|
| **A** Fail-closed | flag가 실제로 막는지 모르면 켜는 행위 자체가 무의미하다. 0크레딧 |
| **B** 실행하지 않음 | package 안의 script·URL·지시문이 실행되거나 신뢰되면 그것은 원격 코드 실행이거나 prompt injection이다. 0크레딧 |
| **C** 자격증명 | 유출은 회수되지 않는다. 0크레딧 |
| **D** 컨테이너 방어 | 거짓 헤더·symlink·경로 이탈이 통과하면 서버가 읽는 바이트를 공격자가 정한다. 0크레딧 |
| **E** 격리와 취소 | 취소가 남의 파일을 지우면 복구할 수 없다. 0크레딧 |
| **G-3** 지표에 식별자가 없음 | 지표에 package 이름·파일명·계정 식별자가 새면 회수가 성립하지 않는다 — §C와 같은 이유다. 0크레딧 |

**합계: A 5 + B 6 + C 6 + D 5 + E 7 + G 1 = 30항목, 유료 turn 0건.**

§G의 나머지 두 항목은 이 표에 없습니다. **G-1은 이 회차의 차단이 아니라
production 활성화의 차단**이고(아래 §G), **G-2는 관측 편의라 차단이
아닙니다.** 셋을 한 줄로 묶으면 "콘솔 활성화 증거가 없어 §G 전체가 막혔다"가
되는데, 그것은 식별자 유출을 보는 G-3에 대해 틀린 말입니다.

**이 회차의 차단 항목에는 유료 turn이 하나도 없습니다.** 가져오기는 모델을
부르지 않습니다 — package를 읽고, 파일을 저장하고, revision을 게시할 뿐입니다.
크레딧을 쓰는 것은 §H(가져온 assistant로 실제 대화)뿐이고 그것은 차단이
아닙니다.

### 차단 아님 (켠 뒤에 고쳐도 되는 것)

| 구획 | 왜 아닌가 |
|---|---|
| **F** 손실 보고서와 병합 공개 | 문구와 목록. 틀려도 아무것도 파괴하지 않고 앞으로 고칠 수 있다. 단 **"병합이 무엇을 바꾸는지 선택 전에 화면에 있다"** 한 항목은 사용자가 낱말에서 읽어 낼 수 없는 결과라 차단으로 올린다 |
| **G-2** 단계 지표 | 지표가 비어 있어도 아무것도 파괴하지 않는다. 유출을 보는 **G-3은 위 차단 표에 있습니다** |
| **H** 가져온 assistant로 대화 | 가져오기가 만든 것은 평범한 profile이고 그 경로는 릴리스 C에서 이미 검증됐다. 유료 |
| **I** export 왕복 | 편의 기능. 실패해도 가져오기가 망가지지 않는다 |

**차단 아닌 항목은 `미기록`으로 남기고 서명해도 됩니다.** 판정란에 어느 구획을
왜 건너뛰었는지 적으면, 그 기록은 비어 있는 것이 아니라 **범위를 밝힌** 것이
됩니다.

### 이 갈래를 바꾸려면

항목을 차단으로 올리는 근거는 **되돌릴 수 없음**입니다. "중요해 보인다"는
근거가 아닙니다. 새 항목을 차단에 넣을 때는 무엇이 복구 불가인지 한 줄로
적으십시오. 적을 수 없으면 차단이 아닙니다.

## 비용

| 구획 | 유료 turn | 무엇을 판별하는가 |
|---|---|---|
| A–G | **0** | 가져오기는 모델을 부르지 않습니다 |
| H | 2 | 가져온 instructions와 문서가 실제 답에 쓰이는가 |
| I | 0 | export는 읽기 전용입니다 |

기본 모델(`gpt-5-6-luna`) Standard 기준 turn당 1크레딧이므로 **합계 2크레딧**,
차단 항목만 실행하면 **0크레딧**입니다.

## 사전 조건

실행 전에 확인합니다. 하나라도 어긋나면 검증이 아니라 **다른 것을 측정**하게
됩니다.

- staging이 서비스 중인 전체 40자리 deploy SHA를 `GET /api/build-info`에서
  읽어 기록에 적었다. git에서 추측하지 않는다
- 그 SHA가 production이 서비스 중인 SHA와 같다. 다르다면 아래 diff가 비어
  있음을 확인하고 그 결과를 기록에 적는다

  ```
  git diff <staging> <production> -- 'lib/assistantPackage*' \
      'lib/assistantProfileImport*' 'app/api/assistant-profiles/imports/**' \
      'components/assistants/import/**'
  ```

- `feature.assistantPackageImportEnabled`가 **아직 꺼져 있다** — §A를 먼저
  실행합니다
- `feature.assistantProfilesEnabled`와 `feature.assistantKnowledgeEnabled`가
  **켜져 있다.** 둘 중 하나라도 꺼져 있으면 가져오기는 7단계에서 막히고, 그것은
  이 회차가 판별하려는 것이 아닙니다
- **`20260823090000_assistant_package_import`가 적용돼 있다.** `EmailCampaign`이
  아니라 이 migration입니다 — 없으면 7단계가 테이블 없음으로 실패합니다
- 시료를 만들었다 (`npm run make:assistant-package-staging-fixtures`)
- 로그인 계정 **2개**와 비로그인 세션을 준비했다. 두 번째 계정은 §E-6에서만
  씁니다

## A. Fail-closed (flag off)

flag가 꺼진 상태에서 먼저 봅니다. 켜고 나면 다시 만들기 어려운 상태입니다.

- [ ] `/settings/assistants/import`가 **404**를 렌더한다. "준비 중" 안내가
      아니다 — 안내는 아직 공개하지 않은 기능의 존재를 알린다
- [ ] 로그인 상태에서 `POST /api/assistant-profiles/imports`가 403이고 코드가
      `ASSISTANT_PACKAGE_IMPORT_DISABLED`이다. 본문이 비어 있어도 이 코드입니다
      — route가 세션 확인 다음, 본문 parse **전에** `assertImportEnabled()`를
      부르기 때문입니다
- [ ] `GET /api/assistant-profiles/{id}/export`도 같은 flag로 막힌다 (403,
      같은 코드)
- [ ] `feature.assistantKnowledgeEnabled`만 끄고 import flag를 켜도 위 route가
      **여전히 거절**한다 — 두 flag를 함께 보는 것이 `assertImportEnabled()`의
      계약이다
- [ ] 위 요청 어느 것도 `AssistantProfileImport`·`AssistantKnowledgeFile` 행을
      만들지 않는다

## B. 실행하지 않고, 요청하지 않고, 신뢰하지 않는다 (차단)

**이 구획이 이 기능의 이유입니다.** package는 다른 제품이 만든 파일이고,
그 안의 어떤 것도 이 앱의 권한으로 움직여서는 안 됩니다.

시료: `P1-skill-with-script.zip`

- [ ] package 안의 `.sh`가 **실행되지 않는다.** 손실 보고서에 **개수와
      경로로만** 나타난다 — 경로 표시는 `docs/policy/assistant-package-import.md` §7
      표의 `scripts/**` 행이 요구하는 동작입니다("읽지도 inflate하지도 않고 개수·경로만 표시").
      경로가 보인다는 이유로 `fail`로 적지 않습니다
- [ ] 손실 보고서가 script의 **내용을 보여주지 않는다** — 이것이 위 항목과
      다른 점이고, 이 구획이 보는 것입니다
- [ ] 지시문 안의 URL이 **방문되지 않는다.** staging 네트워크 로그에 그
      호스트로 나가는 요청이 없다
- [ ] 그 URL이 **host로만** 공개된다 — 경로·query·자격증명이 화면에 없다
      (정답지의 §P1 참조)
- [ ] `ignore previous instructions` 류가 들어간 package의 지시문이 그대로
      profile instructions가 되고, **신뢰된 지시로 승격되지 않는다** — §H-2가
      실제 turn으로 다시 확인한다
- [ ] 6단계까지 진행하는 동안 브라우저 네트워크 탭에 **이 기능의 요청이 하나도
      없다**(profile 목록은 페이지 로드 시 서버가 읽어 prop으로 내려오므로
      요청으로 보이지 않는다). 이것이 "6단계 전 취소는 지울 것이 없다"의 근거다

## C. 자격증명 (차단)

시료: `P2-planted-credentials.zip`

- [ ] 심어 둔 자격증명 **전부**가 발견된다 (정답지가 개수와 규칙 id를 적어
      두었습니다)
- [ ] 화면 어디에도 **일치한 원문이 보이지 않는다.** 규칙 이름·위치·digest만
      보인다
- [ ] 하나도 waive 하지 않으면 **다음 단계로 갈 수 없다**
- [ ] 하나만 waive 하면 나머지 때문에 여전히 막힌다
- [ ] 전부 waive 한 뒤 7단계로 넘어간다
- [ ] staging 서버 로그와 오류 응답 어디에도 자격증명 문자열이 없다. **이
      항목은 로그를 실제로 열어 확인합니다** — 화면만 보고 통과로 적지 않습니다

## D. 컨테이너 방어 (차단)

시료: `P3-lying-size.zip`, `P4-symlink.zip`, `P5-too-many-entries.zip`

- [ ] `P3`이 거절되고 코드가 `ASSISTANT_PACKAGE_UNSAFE_ENTRY`다 — 선언한 크기와
      실제로 풀린 크기가 다르면 조용히 잘라 읽지 않는다
- [ ] `P4`가 거절되고 코드가 `ASSISTANT_PACKAGE_UNSAFE_ENTRY`다
- [ ] `P5`가 거절되고 코드가 `ASSISTANT_PACKAGE_TOO_MANY_ENTRIES`다
- [ ] 세 거절 모두 **서버에 아무 행도 만들지 않는다** — 브라우저에서 끝난다
- [ ] 거절 문구에 항목 경로·파서 메시지가 실려 있지 않다

## E. 격리와 취소 (차단)

**여기서 틀리면 사용자의 profile이 사라집니다.**

시료: `P1-skill-with-script.zip` (문서 2개 포함)

- [ ] 7단계에서 업로드된 파일이 **일반 knowledge 목록에 보이지 않는다**
      (`importId`가 NULL이 아니므로)
- [ ] 그 profile의 일반 publish(편집 화면의 저장)가 거절되고 코드가
      `ASSISTANT_PROFILE_IMPORT_IN_PROGRESS`다. **화면에 그 뜻의 한국어 문장이
      나온다** — 일반 메시지가 아니다
- [ ] `create` mode에서 취소하면 draft profile과 그 파일이 사라진다
- [ ] `merge` mode에서 취소하면 **이 import가 올린 파일만** 사라지고 대상
      profile의 기존 파일·revision은 그대로다
- [ ] 게시 후에는 파일이 일반 목록에 나타난다(`importId`가 NULL이 됨)
- [ ] 같은 profile에 두 번째 import를 시작하면 거절되고 코드가
      `ASSISTANT_PROFILE_IMPORT_IN_PROGRESS`다
- [ ] **다른 계정**의 profile id를 `targetProfileId`로 보내면 404다. "권한
      없음"이 아니라 "없음"이다 — 존재 여부를 알려주지 않는다

## F. 손실 보고서와 병합 공개

한 항목만 차단입니다.

- [ ] **(차단)** 병합을 고르면 무엇이 바뀌는지가 **선택 전에** 화면에 있다 —
      새 revision이 이름·설명·지시문·모델·문서 목록을 대체하고, 기존 문서는
      profile에 남지만 새 revision에는 들어가지 않는다는 것
- [ ] 대상을 바꾸면 업로드 경계 동의가 **풀린다** (문장이 create와 merge에서
      다르므로)
- [ ] 손실 보고서의 개수가 정답지와 일치한다
- [ ] 라이선스가 있는 package와 없는 package가 **다른 문장**을 낸다
- [ ] 게시된 profile의 provenance가 원본 이름·형식을 보여준다
- [ ] 만료: 24시간 idle / 72시간 absolute가 UI에 표시되거나, 최소한 만료된
      import를 다시 열었을 때 상태가 정확하다 (staging에서 시간을 기다리기
      어려우면 `n/a`로 두고 이유를 적습니다 — DB 통합 테스트가 이 계약을 덮고
      있습니다)

## G. 관측

**세 항목이 서로 다른 것을 봅니다.** 하나로 묶으면 셋 중 하나가 못 하는 일
때문에 나머지 둘이 함께 막힙니다.

### G-1 — flag를 켠 행위의 감사 기록 (production 활성화 차단, staging 회차는 `n/a`)

- [ ] flag를 켠 행위가 `AdminAuditLog`에 남는다

**이 회차에는 `n/a`로 적습니다. `pass`로 간주하지 않습니다.** 이 staging
회차에는 애플리케이션 writer와 Admin 콘솔 제어가 **의도적으로** 존재하지 않아
SQL로 활성화했고(`tests/appSettingWriters.test.mjs`가 이 키를 읽기 전용으로
등록해 둔 것이 그 의도입니다), 따라서 `AdminAuditLog` 생성 경로가 없습니다.
대신 **실행자·UTC 시각·실행 SQL·변경 전후 값·`updatedAt`·배포 SHA를 실행
기록에 남깁니다.**

**Production 활성화 전에는 감사 가능한 Admin 제어 경로 구현과 성공 감사 로그
확인을 별도 차단 조건으로 합니다** — `docs/policy/assistant-package-import.md`
§12.2. 그 제어가 들어오는 변경에서 writer 등록과 `READ_ONLY_KEYS` 예외 제거,
테스트 갱신이 함께 일어납니다.

### G-2 — 단계 지표 (차단 아님)

- [ ] Admin analytics의 imports 탭에 이 회차의 단계 진입·완료가 나타난다

지표가 비어 있어도 아무것도 파괴하지 않고, 고쳐서 배포하면 끝납니다.
`미기록`으로 두고 서명해도 됩니다.

### G-3 — 지표에 식별자가 없다 (차단)

- [ ] 그 지표 어디에도 package 이름·파일명·계정 식별자가 없다 — 개수뿐이다

**유출은 회수되지 않습니다.** §C가 package 안의 자격증명을 보는 것과 같은
이유로, 지표에 새어 나온 파일명·계정 식별자도 되돌릴 수 없습니다. G-2가
`미기록`이어도 이 항목은 실행합니다 — 지표에 이 회차의 행이 하나도 보이지
않는다는 것 자체가 "식별자가 보이지 않았다"의 근거가 되지 못하므로, 그때는
`fail`이 아니라 무엇을 봤는지를 증거란에 적습니다.

## H. 가져온 assistant로 대화 (유료 2턴)

- [ ] 가져온 instructions가 실제로 답에 반영된다
- [ ] `ignore previous instructions`가 들어간 package로 만든 assistant가 그
      문장을 **지시로 따르지 않는다** (§B-5의 실제 확인)

## I. Export 왕복

- [ ] 가져온 profile을 export 하면 package가 내려온다
- [ ] 그 package를 다시 가져오면 필드가 일치한다
- [ ] 삭제된 문서가 있으면 export가 그 개수를
      `X-Assistant-Package-Omitted-Documents`로 알린다

## 실행 기록

결과는 여기에 적지 않습니다.
`assistant-package-import-staging-verification-records/README.md`를 따릅니다.
