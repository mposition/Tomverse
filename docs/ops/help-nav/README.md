# HELP-NAV-01 — 제품 내 도움말 도우미 준비물

- 상태: **준비 단계.** 화면·launcher·질문 매칭·provider 호출은 없습니다. 모바일 composer 안정화와
  온보딩 변경 뒤에 UI를 붙입니다.
- 등록부: `lib/helpNavigationIntents.ts` (`help-nav-intents-v2`)
- 정답지: `docs/ops/help-nav/answer-key.v2.json` (`help-nav-answer-key-v2`)
- 검사: `tests/helpNavigationIntents.test.mjs`

## 등록부가 정하는 것

| 항목 | 규칙 |
| --- | --- |
| 의도 | 12개(승인 범위 8~12). 가져오기·이어가기, Memory, 모델 선택, AI Review, 파일, 프로젝트, 잠금·공유, 크레딧·플랜, 환불·결제, 이메일 수신, 데이터 내보내기·계정 삭제, 문제 신고 |
| 목적지 | 설정 섹션·설정 탭·Chat 작업공간 가이드 anchor·공개 페이지(`/pricing`, `/refund`, 도움말 센터)·문의 창 중 하나의 **id**. `resolveHelpDestination()`만 링크나 동작으로 바꾸며, 이 함수는 앱의 `settingsSectionHref()`·`chatWorkspaceGuideHref()`를 그대로 씁니다 |
| 조건 | 목적지마다 로그인 필요 여부·필요한 flag·플랜 여부. 지금은 플랜이 여는 것을 막는 목적지가 없고, 목적지 안의 한도는 그 화면과 서버가 판단합니다. flag가 꺼져 있으면 "지금은 사용할 수 없음"이지 업그레이드 안내가 아닙니다 |
| 단계 | 목적지와 조건이 다른 단계를 따로 적습니다(가져오기는 import flag, 이어가기는 import + continuation flag) |
| 금지 | 모든 의도에 전역 금지(대화·가져온 원문·Memory·첨부·초안·프로필 지식·Review 결과를 읽거나 보내기, 설정 변경, 삭제, 공유, 구매, 유료 실행, 문의 자동 제출, 관리자 경로 안내)와 의도별 금지가 붙습니다. test가 두 목록을 문자 그대로 대조합니다 |

## 정답지

- dev 22개, holdout 21개. 한국어 중심에 영어 포함. 사용자에게서 모은 질문이 아니라 이 검사용으로 쓴 합성 질문입니다.
- 한 사례에 기대값 하나: 의도 하나(`expect`), 되물어야 하는 경우(`clarify`, 정말 두 의도에 다 맞을 때만), 지원하지 않는 요청(`unsupported`). 되묻기와 거절에는 이유를 붙입니다.
- 매칭 규칙을 만들 때는 dev만 보고, holdout은 판정에만 씁니다. holdout은 제품 용어를 덜 쓰고, 비슷하지만 없는 기능(메모장)·관리자 경로·대화 본문을 읽어 달라는 요청처럼 거절해야 하는 경우를 따로 담았습니다.
- 구매 요청(크레딧 충전해 주세요)은 되묻기가 아니라 `credits-and-plan` 안내입니다. 어디서 사는지 알려 주고 사지는 않습니다.

## 아직 정하지 않은 것 (구현 전에 필요)

- 매칭 방식(동의어·검색). 1차는 provider 호출 없이 합니다.
- 안내 문장 원문. 등록부의 `summary`는 검토용 초안이며, 확정 문구는 7개 locale에 넣습니다.
- 계측. 허용된 intent id와 결과 분류만 남기고 질문 원문·대화 id·개인 경로는 남기지 않습니다.
- 데스크톱 launcher 위치와 모바일 진입점. 모바일 composer·drawer 계약과 함께 검증합니다.
