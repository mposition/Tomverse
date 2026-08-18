# 릴리스 A(외부 대화 Import) staging 검증 체크리스트

`docs/policy/external-conversation-import-and-memory.md` §23이 요구하는
"릴리스 A 완료 후 staging 검증 체크리스트"입니다. **이 체크리스트의 실행과
승인은 릴리스 B(`RELEASE_B_MEMORY`) scope 승인의 전제 조건**이며(§23 항목 7),
릴리스 B의 나머지 pending 항목(§23 1–6)을 대체하지 않습니다.

실행·판정·서명은 사람이 합니다. 에이전트는 이 문서의 검증 항목을 갱신할 수
있지만 실행 결과를 스스로 기입할 수 없습니다 — 정책 frontmatter의 승인 필드와
같은 규칙입니다.

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 체크박스는 항상 비어 있고, 그것이 이 파일의
상태입니다. 실행 결과는 `staging-verification-records/`에 **날짜와 전체 deploy
SHA로 이름 붙인 별도 파일**로 남습니다.

그렇게 나눈 이유는 한 번 실제로 틀렸기 때문입니다. 이전 구조는 항목과 승인
기록이 한 파일에 있었고, 승인란은 `8c43430`에 대해 `통과`로 서명돼 있는데
체크박스는 전부 비어 있었습니다. 그 서명 이후 seal→finalize 항목이 새로
추가되고 snapshot lock·source 삭제·설정 IA가 바뀌었지만, 표는 그대로 남아
어느 시점을 덮는지 말하지 못한 채 낡았습니다. 표 하나가 조용히 낡는 구조
자체가 문제였습니다.

- **template revision**: `2026-08-18a` — 항목이 바뀌면 이 값을 올리고, 실행
  기록은 자기가 어느 revision으로 실행됐는지 적습니다. 그래야 "그때는 없던
  항목"을 나중에 구분할 수 있습니다.
- 실행 방법과 파일 이름 규칙: `staging-verification-records/README.md`
- 기록 template: `staging-verification-records/_record-template.md`

## 무엇에 대해 실행하는가 — 활성화 대상 SHA

**검증 대상은 브랜치가 아니라 불변 SHA입니다.** 이 문서는 오랫동안 "staging이
develop의 검증 대상 커밋으로 배포되어 있다"고 적고 있었습니다. staging이
develop을 추적하고 develop이 곧 다음 release이던 동안에는 맞는 문장이었지만,
release 흐름이 늘 그렇게 흐르지는 않습니다. 2026-08-15에 provider 수정 하나가
develop을 거치지 않고 `main`으로 cherry-pick돼 production에 먼저 올라갔고, 그
순간 develop head는 **production이 서빙할 코드가 아니었습니다.** 그 상태에서
develop을 검증했다면 검증 대상과 배포 대상이 43커밋 어긋난 채로 "통과"가
기록됐을 것입니다.

그래서 기준을 브랜치에서 SHA로 옮깁니다.

> staging에는 **예정된 production 활성화 대상의 정확한 40자리 commit SHA**와
> **동일한 migration 집합**을 배포하고, 그 위에서 실행합니다.

브랜치 이름은 이 판정에 등장하지 않습니다. develop head든 main head든,
활성화 시점에 production이 실제로 서빙할 SHA가 아니라면 그 실행은 **탐색
결과이지 활성화 승인의 근거가 아닙니다.**

### 두 종류의 실행

| | 탐색 실행 (`exploratory`) | 정식 실행 (`formal`) |
|---|---|---|
| 목적 | 결함을 일찍 찾는다 | 활성화 승인 근거를 만든다 |
| 대상 SHA | 아무 SHA나 가능 | 활성화 대상 SHA여야 한다 |
| 서명·동결 | 하지 않는다 | 한다 |
| 승인 근거로 인용 | 불가 | 가능 |

활성화 시점이 아직 정해지지 않았다면, 지금 SHA에서 탐색 실행을 해 두는 편이
낫습니다. 결함은 일찍 찾을수록 싸고, **그 실행이 정식 실행을 대신하지 않는다**는
것만 기록에 분명히 적으면 됩니다.

### 동결한 기록이 무효가 되는 조건

"한 번만 검증"은 목표이지 보장이 아닙니다. 정식 실행을 동결한 뒤 다음 중
하나라도 달라지면 **그 기록은 새 대상을 덮지 못하며, 새 기록이 필요합니다.**

1. production 활성화 대상 SHA
2. 적용 migration 집합
3. import·parser·wizard 관련 코드
4. 검증 결과에 영향을 주는 feature flag 또는 런타임 설정
5. 실제 배포 artifact

5번이 따로 있는 이유는 **같은 SHA가 같은 artifact를 보장하지 않기** 때문입니다.
의존성 해석, builder 버전, build 환경은 그 사이에 움직일 수 있습니다. 그래서
기록에는 SHA만이 아니라 **deployment ID 또는 artifact digest**를 함께 적습니다.

### staging 통과가 증명하지 않는 것

정식 실행이 통과해도 그것은 **그 코드와 migration 조합이 올바르게 동작한다**는
근거이지, production이 그 상태라는 증명이 아닙니다. 활성화 전에 production에서
따로 확인합니다.

- migration이 실제로 적용됐다 — 식별자와 완료 시각
- 정확히 그 40자리 SHA가 배포됐다 — deployment ID로 확인
- readiness가 통과한다
- `feature.externalConversationImportEnabled` 값을 **read-back**했다

## 사전 조건

- [ ] staging에 **예정된 production 활성화 대상 SHA**가 배포되어 있고, 그
      **전체 40자리 SHA와 deployment ID(또는 artifact digest)**를 실행 기록에
      적었다. 활성화 대상이 아직 정해지지 않았다면 이 실행은 탐색 실행이며,
      기록의 `runType`을 `exploratory`로 두고 서명·동결하지 않는다.
- [ ] staging의 **적용 migration 집합이 활성화 대상의 것과 같다.** SHA가 같아도
      migration이 덜 적용돼 있으면 다른 조합을 검증한 것이다.
- [ ] **migration이 앱 배포보다 먼저 적용됐다.** 적용된 migration 식별자와
      완료 시각을 실행 기록에 적는다. 넓히는 방향의 migration은 기존 코드와
      역호환이지만, 앱이 먼저 올라가면 migration 적용 전의 요청이 제약에서
      실패한다 — 배포 직후 몇 분에만 나타나고 나중에 원인을 되짚기 어려운
      실패다.
- [ ] external import 관련 forward migration이 모두 적용되어 있다
      (`external_conversation_import_schema`, `external_import_staging_ledger`,
      `external_import_analytics_events` 포함). baseline은 수정되지 않았다.
- [ ] `feature.externalConversationImportEnabled`가 **off**인 상태로 배포됐다
      (§15: flag off 상태에서 먼저 배포 가능해야 한다). A절을 마친 뒤 **staging
      에서는** 이 flag를 on으로 두고 나머지를 실행한다 — production flag는 별도
      승인 전까지 계속 off다.
- [ ] 검증용 일반 계정 1개(비어 있는 import 상태), admin 계정 1개가 있다.
- [ ] 검증용 export 파일이 준비됐다. 아래 "검증용 export를 어떻게 준비하나"의
      조건(전용 계정, 통제된 최소 데이터, 두 형식, 두 export 사이 변경 없음)을
      만족해야 한다.
- [ ] **정리 담당자와 완료 기한을 실행 전에 정해 기록에 적었다.** "검증 후
      정리한다"는 담당자도 기한도 없어 지켜졌는지 알 수 없다. 정리 확인 전에는
      기록을 동결하지 않는다.

## 검증용 export를 어떻게 준비하나

실제 export가 필요한 이유는 합성 fixture로 증명되지 않는 것이 남아 있기
때문입니다 — ID 결정성, 재-import 중복 skip, 분기의 실제 비용. 그래서 준비
조건도 검증 항목의 일부입니다.

| | |
|---|---|
| 계정 | 개인 계정이 아니라 **전용 검증 계정** |
| 콘텐츠 | H/H2에 필요한 **통제된 최소 데이터**(분기 대화 포함)만 생성 |
| 형식 | 같은 계정에서 **JSON과 HTML 둘 다** |
| 시점 | 두 export **사이에 대화를 추가·수정·삭제하지 않는다** |
| 재-import | 새로 export하지 말고 **같은 JSON 파일을 다시** 쓴다 |

재-import 조건이 특히 중요합니다. 새로 뽑은 export로 다시 가져오면 ID 결정성이
아니라 "두 export가 우연히 닮았는가"를 본 것이 됩니다.

**보관 위치.** `.gitignore`는 개인정보 보호 수단이 아닙니다. 저장소 안이나
worktree 안에는 잠시라도 두지 않고, 동기화되지 않는 접근 제한·암호화 임시
디렉터리에 둡니다.

**기록에 남기는 것**은 데이터가 아니라 데이터에 대한 사실입니다 — 계정 종류
(주소는 적지 않음), 익명 evidence ID, export 생성 시각, 형식과 파일 SHA-256,
실행자, staging 데이터 삭제 시각, 로컬 파일 정리 시각과 확인자. 기록 template의
"검증용 export와 정리" 절이 그 칸을 가지고 있습니다.

### 파일마다 무엇을 증명하는가

여섯 개를 "검증용 파일"로 뭉뚱그리면 HTML export가 실패하는 것이 결함으로
읽힙니다. 각각이 증명하는 경로가 다릅니다.

| 파일 | 증명하는 것 |
|---|---|
| ChatGPT export ZIP | 정상 import 경로 |
| 그 안의 `conversations.json` 단독 | 정상 import 경로 |
| Claude 실제 export | 정상 import 경로 |
| Google Takeout **JSON** | Gemini 정상 import, 분기 처리, H2 측정 |
| Google Takeout **HTML** | 정상 import가 **아니라** 지원되지 않는 형식의 안내·복구 경로 |
| 합성 XSS export | viewer가 HTML을 실행하지 않는다는 안전성 경로 |

마지막 줄만 합성본이며, 그것으로 충분합니다 — 증명 대상이 개인 데이터가 아니라
렌더링 동작이기 때문입니다.

## A. Fail-closed (flag off)

- [ ] `GET /api/imports/external/capacity`가 403
      `EXTERNAL_IMPORT_DISABLED`를 반환한다.
- [ ] `/settings/imports`가 비활성 안내를 표시하고 파일 선택 UI가 없다.
- [ ] 계정 설정 Data 탭에 "다른 AI 서비스에서 가져오기" 진입점이 보이지
      않는다(게스트 대화 가져오기 섹션과 혼동 없음).
- [ ] 기존 chat 흐름(전송·comparison·attachment)에 회귀가 없다.

## B. 활성화와 기본 흐름

- [ ] Admin Console → Platform settings의 "External conversation import"
      토글로 flag를 켠다. audit 로그에 app_settings 갱신이 남는다.
- [ ] Data 탭에 진입점과 사용량 요약이 나타나고 `/settings/imports`
      (관리 화면)로 이동한다. "새로 가져오기"가 `/settings/imports/new`
      Wizard를 연다.
- [ ] Wizard 1단계에서 ChatGPT·Claude 내보내기 안내 카드와 "파일이 아직
      없어요 / 이미 있어요" 두 경로가 보이고, 개인정보 전체 설명이 접근 가능한
      disclosure 뒤에 있다.
- [ ] ChatGPT export **ZIP**을 선택하면 브라우저에서 파싱되고(개발자 도구
      Network에 원본 archive 업로드가 **없어야 한다** — §5.1), 대화 선택
      단계에 대화 수·메시지 수·예상 저장량·남은 공간·경고(건너뛴 항목·분기)가
      표시된다.
- [ ] 안내에서 ChatGPT를 고르고 Claude export를 올려도 실패하지 않고
      "Claude 기준으로 진행합니다" 비차단 안내만 표시된다.
- [ ] 일부만 선택해 "선택 내용 확인" → "대화 N개 가져오기"로 확정하면 완료
      요약과 함께 목록·용량이 갱신된다.
- [ ] 검색·날짜 필터를 걸어도 화면 밖 선택이 유지되고 "선택 N개 중 M개는
      현재 필터에 표시되지 않음" 안내가 보인다. 필터를 지우면 이전 선택이
      그대로 복원된다.
- [ ] `conversations.json` 단독 파일과 Claude export로도 같은 흐름이 된다.
- [ ] viewer에서 가져온 대화가 원문 그대로(plain text) 보이고, 원본 모델
      라벨이 provenance로 표시된다.

## C. 한도·중복·truncation 의미론

- [ ] 100,000 code point를 넘는 메시지가 있는 export: preview가 승인
      체크박스를 요구하고, 미승인 시 해당 대화가 선택되지 않으며, 승인 후
      저장본에 `[[tomverse:truncated]]` marker와 truncation 안내가 보인다.
- [ ] 1,000,000 code point를 넘는 메시지가 있는 대화는 "가져올 수 없음"으로
      표시되고 선택 자체가 불가능하다(§5.3 — 메시지 단위 누락 없음).
- [ ] 같은 export를 다시 가져오면 전부 "중복 제외"로 skip되고 저장량이 늘지
      않는다(§4.2 완전 일치).
- [ ] 대화가 추가된 최신 export를 가져오면 **새 snapshot**이 생기고, 목록이
      같은 lineage로 묶어 최신본을 앞에, 이전 버전을 disclosure 뒤에
      표시한다. 이전 snapshot을 개별 삭제할 수 있다(§4.2).
- [ ] (선택) 잔여 quota를 초과하는 선택을 시도하면 업로드 전에 UI가
      차단하고, 서버 finalize 강행 시 409 `EXTERNAL_IMPORT_QUOTA_EXCEEDED`
      all-or-nothing 거부가 확인된다. admin 지표의 `quota_rejected`
      카운터가 증가한다.

## C2. Seal · 재개 · 만료 (§5.5)

- [ ] 확인 화면에 도달하면 `ExternalImport.status`가 `preview_ready`이고,
      같은 선언으로 seal을 다시 호출하면 200 idempotent replay가 온다.
- [ ] 선언을 바꿔(예: duplicate count) seal을 호출하면 409
      `EXTERNAL_IMPORT_SELECTION_CHANGED`이고 상태는 그대로다.
- [ ] `preview_ready` import에 batch를 더 보내면 409로 거부된다.
- [ ] 확인 화면에서 일부 대화를 해제하고 확정하면 선택한 것만 저장되고
      나머지 staged row는 삭제된다(부분집합 finalize).
- [ ] Wizard 중간에 브라우저 뒤로가기를 누르면 관리 화면으로 나가고,
      서버 import가 아직 없으면 "Tomverse에 저장된 데이터 없음"이 보인다.
      `beforeunload` 경고가 뜨지 않는다.
- [ ] 관리 화면의 진행 중 카드: `preview_ready`에만 "이어서 완료하기"가 있고,
      seal되지 않은 `staging`에는 다시 시작·삭제만 있다.
- [ ] TTL이 지난 작업은 조용히 사라지지 않고 "만료되어 다시 시작해야 함"으로
      표시된다. 15분 maintenance sweep이 `staging`과 `preview_ready`를 모두
      정리한다.
- [ ] seal 없이 `staging`에서 바로 finalize를 호출하면 409
      `EXTERNAL_IMPORT_SELECTION_CHANGED`로 거부되고, 같은 요청이 seal 이후에는
      성공한다. TTL이 지난 import는 계속 410
      `EXTERNAL_IMPORT_STAGING_EXPIRED`이며, 두 거절은 복구 방법이 다르므로
      화면 문구도 달라야 한다(전자는 "확인 후 완료", 후자는 "다시 시작").

  > **호환 기간 종료됨.** seal 이전 버전 화면을 열어 둔 탭이
  > `staging`에서 바로 finalize할 수 있던 72시간 창은 닫혔습니다. 기준은
  > seal 코드의 production 배포 시각 2026-08-04T01:38:42Z이며, 그 뒤로 seal
  > 없는 finalize는 위와 같이 거부됩니다. 이 항목은 더 이상 "여전히 성공한다"를
  > 확인하지 않습니다 — 정책 §5.5 참조.

## C3. 용량 부족 복구 (§5.3)

- [ ] 대화 선택 단계에서 선택량과 남은 공간이 나란히 보이고, 초과하면
      진행 버튼이 잠긴다.
- [ ] 업로드 중 서버가 quota로 거부하면 **같은 내용 다시 시도 버튼이 없고**
      선택을 줄이라는 안내만 나온다. 승인된 batch가 하나라도 있었다면 기존
      staging이 삭제되고 새 import로 다시 시작한다는 안내가 함께 보이며,
      로컬 선택과 truncation 동의는 유지된다.
- [ ] 네트워크를 잠깐 끊어 전송을 실패시키면 같은 sequence 재시도 버튼이
      나오고, 재시도 시 이미 도착한 batch가 중복 생성되지 않는다.
- [ ] finalize에서 quota로 거부되면 아무것도 저장되지 않고 확인 화면으로
      돌아와, 선택을 줄여 **재업로드 없이** 다시 확정할 수 있다.

## D. 보안 spot check

- [ ] `<script>`·`onerror` 속성이 든 HTML을 본문에 포함한 합성 export를
      가져와 viewer에서 **문자 그대로** 렌더링되는지 확인한다(§19 XSS).
      alert·요소 삽입이 없어야 한다.
- [ ] 다른 계정으로 importId·conversationId를 직접 조회하면 404가 온다
      (IDOR — 존재 여부가 새어 나가지 않음).
- [ ] 서버 구조화 로그를 열람해 filename·대화 제목·본문·외부 ID·digest·
      fingerprint가 로그에 없음을 확인한다(§19/§22 content-free).

## E. 삭제·export·계정 정리

- [ ] JSON export 다운로드가 동작하고 provenance(digest·모델 라벨·시각)가
      포함된다. flag를 꺼도 다운로드와 삭제가 계속 동작한다(§15 rollback).
- [ ] import 전체 삭제·snapshot 개별 삭제 후 목록·용량·상세 수치가 서로
      맞는다.
- [ ] staging 검증 계정을 계정 삭제 절차로 지우면 Import·대화·메시지가
      함께 사라진다(§13.1 — 회귀 테스트:
      `tests/integration/account-deletion.db.test.ts`).

## F. 관측·운영

- [ ] `GET /api/admin/external-imports`가 provider·parserVersion 분해,
      bucket, 중복·truncation 비율, 카운터를 반환하고 값이 위 검증 활동과
      부합한다. `parserVersion`이 **배포된 값**으로 기록된다 —
      `lib/externalImportAdapters/index.ts`의
      `EXTERNAL_IMPORT_PARSER_VERSION`이 정하며, 이 문서에 숫자를 박아 두면
      다음 실행에서 틀린 값을 확인하게 된다.
- [ ] `external_import_step_entered` / `_abandoned`가 기록되고 `import_step`
      외의 속성이 없다. **단계별 `entered` 합계와 `abandoned` 합계가 맞지 않는
      것은 정상이다**(브라우저를 그냥 닫는 이탈은 측정되지 않음, §22). 실질
      이탈은 연속 단계의 `entered` 차이로 읽는다.
- [ ] 15분 maintenance 결과에 `externalImportStaging` sweep 수치가 보인다
      (중도 이탈 import를 만들어 두고 다음날 만료 처리를 확인하는 것은
      선택 항목).
- [ ] 모바일 기기(또는 시뮬레이터)에서 320px 폭 레이아웃이 깨지지 않고,
      대형 archive에서 데스크톱 권장 안내가 표시된다(가능한 경우).
- [ ] ko/en 두 locale로 대표 화면(설정·preview·viewer)을 렌더링해 확인한다
      (§16 — 나머지 5개 locale은 정적 parity 테스트로 갈음).

## G. Rollback drill

- [ ] flag를 다시 끄면 A 항목의 fail-closed 상태로 즉시 돌아가고, 이미
      가져온 데이터는 목록·삭제·export로 계속 접근 가능하다.
- [ ] drill 종료 후 flag 상태를 운영 결정에 맞게 되돌려 놓았다.

## H. Gemini(A2) import

계약은 `docs/policy/external-import-gemini-a2.md`입니다. **이 절은 실제
Takeout에 대해서만 의미가 있습니다** — 저장소의 fixture는 합성본이고, 그것이
초록이라는 사실이 여기서 확인할 것을 대신하지 않습니다. A2 scope 승인은
구현 착수까지만 덮으므로, Gemini 구현의 근거는 이 절의 실행 기록입니다.

**H/H2만 실행하는 것은 Gemini 구현 확인에는 충분하지만, 외부 import의
production 활성화에는 불충분합니다.** flag가 하나뿐이라 그것을 켜는 것은
Gemini rollout이 아니라 **외부 import 전체의 최초 production 공개**이고,
활성화의 근거는 사전 조건과 A~H/H2 전체 기록입니다. H만 실행한 회차는 이렇게
남깁니다.

- `runType`은 `exploratory`, 실행하지 않은 A~G 항목은 전부 `미기록`
- 전체 결과를 `통과`로 서명하지 않고, production 승인 근거로 인용하지 않음
- 나중에 활성화한다면 그때의 활성화 대상 SHA에서 **A~H/H2 전체를 다시** 실행

**그리고 H는 문자 그대로 H만 떼어낼 수 없습니다.** 아래 viewer 항목은 D절의
XSS 확인을 참조하므로, H만 실행하는 회차에서도 **그 D 항목은 함께 실행**해야
검증이 완결됩니다. 참조된 항목을 빼면 "확인했다"가 가리키는 것이 없습니다.

- [ ] Wizard 1단계에 Gemini 안내 카드가 있고, 문구가 **`My Activity → Gemini
      Apps`와 JSON 형식**을 지목한다. Takeout에서 "Gemini" 항목을 그대로
      고르면 대화가 아니라 Gems를 받게 된다는 사실이 읽힌다.
- [ ] 실제 Takeout ZIP을 올리면 브라우저에서 파싱되고(개발자 도구 Network에
      원본 archive 업로드가 **없어야 한다**), provider가 Gemini로 인식된다.
      **경로가 한국어인 계정과 영어인 계정 모두** 같은 결과가 나온다
      (§3.1 — 경로·파일명·라벨은 모두 번역된다).
- [ ] 대화에 `.zip`을 첨부한 적이 있는 계정의 export가 **거절되지 않는다**
      (§3.2). 첨부 자체는 가져오지 않으며, preview가 그 수를 말한다.
- [ ] preview의 네 수치가 화면에 **각각 따로** 보인다 — 분기 중복 메시지,
      아카이브에 없는 첨부, 어느 대화에도 속하지 않은 항목, 서식을 읽지 못해
      제외한 답변. 실제 export에서 셋 이상이 0이면 그 export가 해당 경우를
      담고 있는지 먼저 확인한다(0이 정상일 수도, 미표시일 수도 있다).
- [ ] **분기된 대화가 각각 독립 대화로 들어온다**(§2.2). 분기점 이전 turn이
      각 분기에 모두 있고, 선택 화면에서 분기를 개별로 해제할 수 있다.
- [ ] 답변이 viewer에서 안전하게 렌더링된다. parser가 markdown으로 바꿨다는
      것과 화면이 안전하다는 것은 **다른 사실**이므로, HTML을 본문에 담은
      대화가 있다면 D절의 XSS 확인을 그 대화로도 한 번 수행한다.
- [ ] **같은 export를 다시 가져오면 전부 중복으로 skip되고 저장량이 늘지
      않는다.** 이것이 ID 결정성의 실제 확인이며, 합성 fixture로는 증명되지
      않는 부분이다.
- [ ] 답변이 markdown으로 **저장**된다 — 표·코드 블록·목록의 markdown 표기가
      본문에 들어 있고, 변환되지 않은 HTML 태그가 산문에 남아 있지 않다
      (코드 블록 안의 태그는 그 대화의 내용이므로 해당하지 않는다).
      **viewer는 이것을 렌더링하지 않습니다.** 정책 §4가 "sanitised plain
      text 또는 안전한 제한 Markdown"을 허용하고 구현은 앞쪽을 골랐으므로
      (`ExternalConversationViewer.tsx` — React text node), 화면에서 표가
      `|` 문자로, 코드 블록이 백틱 세 개로 보이는 것이 **정상**이다.
      확인 대상은 렌더링 여부가 아니라 저장 형식이다.
- [ ] **HTML 형식으로 내보낸 파일**을 올리면 파일 선택기에서 고를 수 있고,
      "내 활동을 JSON 형식으로 다시 내보내 주세요"라는 안내가 나온다. 일반
      "읽을 수 없음"이 아니다(§6). 진단 라벨은 `html_export_unsupported`.
- [ ] Gems·예약 작업 파일(`Takeout/Gemini/*.html`)만 담긴 ZIP도 같은 안내로
      이어지고, 조용히 "대화 0건"으로 끝나지 않는다.
- [ ] 활동 기록이 꺼져 있어 대화가 없는 export는 **오류가 아니라 정상 상태**로
      구분해 표시된다(§1).
- [ ] admin 지표에서 이 import가 provider `gemini`로 잡힌다.

### H2. 분기가 실제로 얼마를 쓰는지

분기별 독립 대화(§2.2)는 **의도된 동작이고 비용이 있는 동작**입니다. 그 비용을
숫자로 남기지 않으면, 저장량이 예상보다 크다는 사용자 보고가 들어왔을 때
설계대로인지 결함인지 판별할 수 없습니다.

**`duplicatedBranchMessages`를 추가 비용으로 읽지 않습니다.** 이 카운터는 둘
이상의 대화에 속한 turn의 메시지를 **대화마다 한 번씩** 셉니다 — 즉 첫 번째
복사본도 포함합니다. 2026-08-14 exploratory 표본에서 이 값은 저장 예정 메시지
2,606 중 1,434였지만, 그것이 "quota가 55% 더 든다"는 뜻은 아닙니다.

기록에 다음 네 값을 함께 적습니다.

| 값 | 구하는 법 |
|---|---|
| 저장 예정 메시지 | preview의 메시지 수 |
| 공유 분기 복사본 | preview의 분기 중복 메시지 수 |
| **순수 추가 메시지** | 공유 turn마다 `(속한 분기 수 − 1)`의 합 |
| **순수 추가 bytes** | 분기 복제를 뺀 예상 저장량과 실제 예상 저장량의 차 |

quota는 메시지 수뿐 아니라 **대화 수와 bytes에도** 걸리므로(§5.3), 셋을 함께
적지 않으면 어느 한도에 먼저 닿는지 알 수 없습니다.

확인할 것:

- [ ] preview에 표시된 분기 중복 메시지 수가 실제 값과 **정확히** 일치한다.
- [ ] 그 숫자가 **선택분이 아니라 export 전체 기준**임을 화면에서 알 수 있다.
- [ ] 분기 대화를 해제하면 **선택 메시지 수와 예상 저장 bytes가 즉시 줄어든다.**
- [ ] **어느 대화를 해제해야 하는지 사용자가 식별할 수 있다.** 목록에서 분기끼리
      구분되지 않으면, 총량 경고만 있고 손댈 방법이 없는 상태다.
- [ ] 서버 finalize 뒤 실제 저장량이 선택 화면의 예상량과 맞는다.

**이 수치 자체는 차단 사유가 아닙니다** — §2.2가 승인한 동작입니다. 다만 총량
경고만 보이고 분기 해제가 비직관적이라면 후속 UX 이슈로 남깁니다.

## 실행 기록

이 파일에는 결과를 적지 않습니다. `staging-verification-records/`를 보세요.

| 실행 | 상태 |
|---|---|
| `2026-08-04__8c43430.md` | legacy summary — 서명은 있으나 항목별 증거 미기록 |
| 최신 staging SHA에 대한 재검증 | **아직 없음** |

재검증이 필요한 이유는 그 기록 파일 안에 적혀 있습니다.
