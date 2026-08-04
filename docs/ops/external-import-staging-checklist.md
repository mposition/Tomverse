# 릴리스 A(외부 대화 Import) staging 검증 체크리스트

`docs/policy/external-conversation-import-and-memory.md` §23이 요구하는
"릴리스 A 완료 후 staging 검증 체크리스트"입니다. **이 체크리스트의 실행과
승인은 릴리스 B(`RELEASE_B_MEMORY`) scope 승인의 전제 조건**이며(§23 항목 7),
릴리스 B의 나머지 pending 항목(§23 1–6)을 대체하지 않습니다.

실행·판정·서명은 사람이 합니다. 에이전트는 이 문서의 검증 항목을 갱신할 수
있지만 맨 아래 승인 기록을 스스로 기입할 수 없습니다 — 정책 frontmatter의
승인 필드와 같은 규칙입니다.

## 사전 조건

- [ ] staging이 develop의 검증 대상 커밋으로 배포되어 있고, 커밋 SHA를 아래
      승인 기록에 적었다.
- [ ] external import 관련 forward migration이 모두 적용되어 있다
      (`external_conversation_import_schema`, `external_import_staging_ledger`,
      `external_import_analytics_events` 포함). baseline은 수정되지 않았다.
- [ ] `feature.externalConversationImportEnabled`가 **off**인 상태로 배포됐다
      (§15: flag off 상태에서 먼저 배포 가능해야 한다).
- [ ] 검증용 일반 계정 1개(비어 있는 import 상태), admin 계정 1개가 있다.
- [ ] 검증용 export 파일: 실제 ChatGPT export ZIP(미디어 포함), 그 안의
      `conversations.json` 단독 파일, 실제 Claude export. 개인 데이터가
      들어 있으므로 검증 후 파일과 staging 계정 데이터를 정리한다.

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
- [ ] 배포 직후, seal 이전 버전 화면을 열어 둔 탭에서 `staging` finalize가
      여전히 성공한다(72시간 호환 기간).

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
      부합한다. `parserVersion`이 `v2`로 기록된다.
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

## 승인 기록 (사람이 기입)

| 항목 | 값 |
|---|---|
| 검증 대상 커밋 SHA | 8c43430 |
| 실행자 | @mposition |
| 실행일 | 04/08/2026|
| 결과 (통과 / 조건부 / 실패) | 통과 |
| 발견 사항·후속 티켓 | |
| 승인자 서명 | TH |
| 승인일 | 04/08/2026 |
