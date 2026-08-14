# 이미지 생성 v2 staging 검증 체크리스트

`docs/policy/image-generation.md` §15가 요구하는 검증입니다. **이 체크리스트의
실행과 승인은 production에서 `feature.imageGenerationEnabled`를 켜기 위한 전제
조건**입니다. 정책 §15의 문장이 그대로 기준입니다.

> **v1 flag는 staging 내부 검증 전용이다.** 멀티 모델 UX(§11–§13)가
> 구현·검증되기 전에 production에서 flag를 켜 공개 베타로 활성화하지 않는다.
> flag-off 코드 배포는 허용된다.

구현은 끝났습니다. 남은 것은 **검증**이고, 그것이 이 문서입니다.

실행·판정·서명은 사람이 합니다. 에이전트는 항목을 갱신할 수 있지만 실행 결과를
스스로 기입할 수 없습니다.

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 체크박스는 항상 비어 있고, 그것이 이 파일의
상태입니다. 실행 결과는 `image-generation-staging-verification-records/`에
**날짜와 전체 deploy SHA로 이름 붙인 별도 파일**로 남습니다.

이 구조는 외부 import 쪽에서 한 번 실제로 틀린 뒤에 만들어졌습니다. 항목과
승인 기록이 한 파일에 있으면, 승인란은 서명된 채 남고 그 위 항목들만 조용히
바뀝니다. 표 하나가 어느 시점을 덮는지 말하지 못한 채 낡습니다.

이미지 생성은 그 실수를 **거의 반복할 뻔했습니다.**
`.github/audits/image-generation-v2-staging-verification-2026-08-04.md`가
관측·절차·미체크 항목을 한 파일에 담고 있었고, 그 문서의 §3은 "Google 모델
가격 검증이 끝나기 전까지 실행할 수 없다"는 당시 사실을 전제로 쓰였습니다.
2026-08-14에 그 전제가 사라졌지만 문서는 그대로였습니다. 그 파일은 이제
그날의 **관측 기록**으로 고정하고, 실행할 절차는 이 template이 가집니다.

- **template revision**: `2026-08-14` — 항목이 바뀌면 이 값을 올리고, 실행
  기록은 자기가 어느 revision으로 실행됐는지 적습니다.
- 실행 방법과 파일 이름 규칙:
  `image-generation-staging-verification-records/README.md`
- 기록 template:
  `image-generation-staging-verification-records/_record-template.md`

## 사전 조건

실행 전에 확인합니다. 하나라도 어긋나면 검증이 아니라 **다른 것을 측정**하게
됩니다.

- staging이 서비스 중인 전체 40자리 deploy SHA를 확보했고, 기록에 적었다
- `GET /api/ready`의 `imageProviderBudget`이 `true`
- 활성 이미지 모델이 **둘 이상**이다. 하나뿐이면 §B의 멀티 모델 항목은
  실행할 수 없고 `n/a`로 기록합니다 — 통과가 아닙니다
- Pro 또는 Max 계정, Free 계정, 그리고 비로그인 세션을 각각 준비했다
- **크레딧이 실제로 차감됩니다.** §B·§E는 유료 실행입니다

### 활성 모델 확인

`GET /api/admin/image-generation`(관리자)에서 활성 모델과 provider를 확인하고
기록에 그대로 옮깁니다. 2026-08-14 기준 기대값은 `gpt-image-2`(openai)와
`fal-ai/nano-banana-2`(fal) 둘이며, **provider가 서로 달라야** §B가 의도한
cross-provider 비교가 됩니다. 같은 provider의 두 모델은 fan-out은 검증해도
provider별 예산·동시성 분리는 검증하지 못합니다.

## A. Fail-closed (flag off)

flag가 꺼진 상태에서 먼저 봅니다. 켜고 나면 다시 만들기 어려운 상태입니다.

- [ ] 네 진입점(사이드바 split button, 모바일 드로어 행, 컴포저 도구 메뉴,
      카탈로그 이미지 탭)이 **하나도 렌더되지 않는다**
- [ ] `/api/images/groups`에 직접 POST하면 거절되고, DB에 그룹·target·attempt·
      예약이 **하나도 생기지 않는다**

## B. 멀티 모델 fan-out (핵심 계약, 유료)

정책 §11이 이 제품의 핵심 계약이라고 말하는 부분입니다. **2026-08-14 이전에는
활성 모델이 하나뿐이라 실행할 수 없었습니다.**

두 모델을 함께 선택해 한 번 제출합니다. 프롬프트는 토큰이 적게 드는 것으로:
`a single red apple on white`

- [ ] 제출 **전에** 모델별 가격과 합계가 표시된다
- [ ] 요청이 **단일 POST**이고 `modelIds`에 두 모델이 들어간다
- [ ] 결과 카드가 target당 정확히 1개 렌더된다
- [ ] 폴링이 **그룹 endpoint 하나**(`GET /api/images/groups/{groupId}`)로만
      일어난다 — 모델 수에 비례해 요청이 늘지 않는다
- [ ] 새로고침해도 timeline이 서버에서 그대로 복원된다
- [ ] 크레딧이 예약 → 정산으로 **모델당 한 번씩만** 차감된다. 정산 후 잔액을
      기록에 적는다
- [ ] provider별 예산 사용량이 **각 provider에** 기록된다 — fal 사용이
      `IMAGE_PROVIDER_OPENAI_*`에 잡히지 않는다

마지막 항목이 owner/provider 분리가 실제로 동작하는지 보는 유일한 지점입니다.
Nano Banana 2는 Google 모델이지만 fal이 청구하므로, 예산은 fal에서 빠져야
합니다.

### B2. 부분 실패

한 모델만 실패시키기는 어렵습니다. 자연 발생하면 기록하고, 아니면 `n/a`로
둡니다 — 유도하려고 무리한 프롬프트를 쓰지 않습니다.

- [ ] 한쪽이 실패해도 성공한 결과가 유지된다(그룹 전체 재실행 강요 없음)
- [ ] 실패한 attempt의 예약만 환급된다

## C. 진입점 네 곳

- [ ] 데스크톱 사이드바 split button — 기본 클릭은 새 채팅, 캐럿에 이미지 생성
- [ ] 모바일 드로어 — 같은 메뉴가 full-size 행으로 열린다(캐럿 축소 없음)
- [ ] 컴포저 도구 메뉴 → 이미지 생성 — 작성 중 텍스트가 prompt로 이월되고,
      "채팅으로 돌아가기"가 원래 대화의 draft를 복원한다
- [ ] 모델 카탈로그 → 이미지 탭 — 채팅 목록과 분리돼 있고, 고르면 그 모델로
      workspace가 열린다
- [ ] 이미지 draft로 전환해도 **서버에 행이 생기지 않는다**(제출 전까지)

## D. 잠금 노출 (무료)

정책 §13은 숨기지 말고 **잠금을 보이라**고 요구합니다. 마지막 단계에서 막는
것도 금지입니다.

- [ ] 비로그인(Guest) — 네 진입점 모두 **보이고** 잠금이 표시되며, 클릭하면
      로그인으로 간다
- [ ] Free 계정 — 같은 위치에서 잠금이 보이고 클릭하면 `/pricing`으로 간다.
      **prompt 입력창에 도달하지 않는다**
- [ ] 두 경우 모두 요구 조건이 클릭 **전에** 문장으로 적혀 있다

## E. 재시도 (유료)

- [ ] 실패 카드에 사유와 환급이 함께 표시된다
- [ ] 재시도하면 **같은 카드가 교체**되고 항목 수가 늘지 않는다
- [ ] 성공한 target에는 재실행 버튼이 없다 (이중 과금 금지)

## F. 자산과 라벨

- [ ] 생성 이미지에 AI 생성 라벨이 붙는다
- [ ] 클라이언트에 전달된 URL에 R2 key가 노출되지 않는다
- [ ] signed URL이 응답에만 있고 DB에 저장되지 않는다
- [ ] 만료된 카드가 단일 복구 endpoint로 다시 열린다

## G. 이미지 대화의 금지 사항

- [ ] AI Review가 이미지 대화에서 제공되지 않는다
- [ ] 비교 action rail이 마운트되지 않는다

## H. 관측

관리자 계정으로 `GET /api/admin/image-generation`:

- [ ] provider별 예산 사용량이 보인다
- [ ] registry의 hold 상태가 보고된다
- [ ] 이 실행에서 만든 그룹이 집계에 반영된다

## 실행 기록

결과는 여기에 적지 않습니다.
`image-generation-staging-verification-records/README.md`를 따릅니다.
