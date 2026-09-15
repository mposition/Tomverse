# Tomverse Chat 전체 범위와 개발 우선순위 재평가

- 기준일: 2026-09-11, Australia/Brisbane
- 성격: 읽기 전용 코드·정책·검증 기록 기반 자문. 기능 구현, 출시 승인, 운영 설정 변경이 아니다.
- develop 기준: `0efc936a1ca4281c99b56d129dae51dd38ce249d`
- main 기준: `54a0813242b14f8f599f804cff520a480f85eaad`
- 공개 제품 설명: [Tomverse 홈페이지](https://tomverse.app/), 2026-09-11 조회.
- 사용자 피드백: 음성·Native 앱에 반복 요청이 있다는 사용자 진술. 요청 수, 사용자 수, 전환·유지율은 제공되지 않았으므로 정량 효과로 환산하지 않았다.

## Production 확인에 따른 정정 — 2026-09-11 12:53 AEST

초판은 운영 상태를 조회하지 않고 Voice Input을 출시 마무리 후보에 넣었다. 사용자 지적 후 Railway의 Tomverse/production 환경, 실제 도메인 연결, 공개 build-info, production AppSetting을 직접 대조했다. **Voice Input은 이미 production에서 활성화되어 있으며, 신규 출시 작업에서 제외한다.**

| 확인 항목 | 실제 관측 |
| --- | --- |
| 서비스/도메인 | Tomverse / production, tomverse.app 연결 ACTIVE |
| 현재 배포 | SUCCESS, SHA `54a0813242b14f8f599f804cff520a480f85eaad`, deployment `d8715d76-9ac8-4b53-850f-2c41db21473c` |
| 공개 build-info의 배포 완료 시각 | 2026-09-11T02:15:59.671Z |
| A: `feature.voiceInputEnabled` | `true`; row updatedAt 2026-09-10T03:54:17.147Z |
| Voice kill switch | 미작동 — production 서비스 변수에서 빈 값/미설정 |
| 외부 대화 가져오기: `feature.externalConversationImportEnabled` | `true`; row updatedAt 2026-08-22T23:51:31.569Z |
| B: 이어가기의 `feature.externalConversationContinuationEnabled` | **행 없음**. 개발 정책의 기본값은 비활성 |
| 현재 배포 SHA의 이어가기 구현 | `lib/externalContinuationService.ts` 및 전용 flag 소비 경로 없음 |

따라서 **A와 외부 대화 Import는 활성화 확인**, 하지만 초판 B가 가리킨 **외부 대화 “Tomverse에서 이어가기”는 현재 production 활성화를 확인할 수 없고, 전용 설정·배포 코드도 없다.** Import와 continuation을 같은 기능으로 표현하면 안 된다.

DB 확인은 2026-09-11T02:53:13.303Z에 `BEGIN READ ONLY` 및 `transaction_read_only=on`으로 세 키만 조회한 뒤 ROLLBACK했다. 설정·데이터·배포는 변경하지 않았다. updatedAt은 행의 마지막 수정 시각이며 최초 활성화 시각으로 단정하지 않는다. 실제 음성 전사나 새 이어가기 생성은 실행하지 않았으므로, 이번 확인을 유료 기능의 end-to-end 품질 검증으로 확대하지 않는다.

근거: [운영 build-info](https://tomverse.app/api/build-info), [Railway production 서비스](https://railway.com/project/0c5f17ad-a42a-4fa8-a245-bcd6a3275a35/service/f0a4f7f4-a476-4726-87a6-9114f8da8147?environmentId=4ffdeab7-a1fb-4ec1-bf4a-4dd2818ba668), 위 시각의 제한된 읽기 전용 DB 조회.

## 1. 결론

이전 표는 Tomverse Chat이라는 제품 출시 프로그램을 빠뜨리고, 그 하위 구성 요소인 Auto Router와 이미 구현된 기능을 같은 수준의 신규 개발 후보로 비교했다. 현재 상태를 반영하려면 다음 두 순서를 구분해야 한다.

**큰 개발 투자:** Chat 모바일 웹 완성 → Native Mobile 실제 앱 → Memory Release B 품질 → 제한형 MCP Preview.

**남은 출시·통합 정리:** 현재 Review형 외부 대화 이어가기 → 기존 생성 파일의 Chat 통합 확인. Voice Input은 이미 production 활성화된 기존 서비스로 분류한다.

기존 서비스의 개선, 가까운 가치를 전달할 소규모 완료 작업, 개발 역량을 주로 투입할 중장기 작업을 구분한다. 기존 83·80·76.5 등의 점수는 측정 모델과 입력 데이터가 확인되지 않아 승계하지 않는다. 아래 순위는 확인된 의존성과 구현 상태를 토대로 한 추천이며, 시장 점유율이나 사용자 선호의 실측 순위가 아니다.

## 2. Tomverse Chat의 정확한 범위

공식 계획은 Tomverse Chat을 별도 백엔드가 아닌 공통 Tomverse 플랫폼 위의 **모바일 우선 단일 답변 제품 화면**으로 정의한다. Auto가 기본 모델 선택 방식이고, Prompt Planner와 웹·모바일 공통 구성 요소를 포함한다. 계정·프로젝트 소유권·모델 카탈로그·과금·프라이버시는 Review와 공유한다.

전체 v1 프로그램에는 Native 배포도 포함된다. 따라서 아래의 Chat 웹과 Native 순위는 서로 다른 제품을 새로 만드는 순서가 아니라, **동일 프로그램 안의 웹 제품 완성과 앱 배포 단계**를 나눈 것이다. Memory는 별도 승인된 Release B이며, 메모리 없는 v1의 선행 조건이 아니다.

현재 공개 홈페이지도 Review 중심으로 설명한다. 소스의 `/chat`은 이름과 달리 아직 `ReviewWorkspaceShell`을 연다. 새로운 Chat 생성 endpoint가 존재하는 것과, 사용자가 새로운 Chat 제품을 이용할 수 있다는 것은 다르다.

근거: [v1 Delivery Plan](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/docs/policy/tomverse-chat-delivery-plan.md), [현재 /chat 화면](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/app/(site)/(application)/chat/page.tsx), [Chat 생성 경계](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/app/api/products/chat/conversations/route.ts).

## 3. 전체 기능 점검

여기서 “구현”은 해당 경로가 코드에 존재함을 뜻한다. 모든 지원 모델·기기에서 검증됐다거나 production에서 활성화됐다는 뜻이 아니다.

| 기능 묶음 | 확인한 현재 상태 | 남은 작업·우선순위 영향 |
| --- | --- | --- |
| Chat 전용 단일 답변 화면·제품 진입 | 기존 /chat은 Review. Chat 생성 경로는 Auto 제공 가능 여부에 종속 | 제품 화면·진입·이력·설정의 연결을 완성해야 한다. 최우선 본체 |
| 스트리밍·중지·재시도·재생성·수정 후 재전송 | Review의 대화 기반을 재사용할 수 있음 | 새 단일 답변 화면에서 회귀 확인. 전부 재개발할 일이 아님 |
| Auto 선택·선택 이유·수동 전환·Auto 복귀 | 서버·UI·제품 경계 구현과 품질 평가가 진행 중 | 품질 근거, shadow 관측, 실제 요청 기록 경계가 미완료. Chat의 핵심 선행 작업 |
| 문맥 구성·토큰 추정·모델별 fallback | inventory·추정·attempt별 manifest·실패 처리 기반 있음 | 최신 dispatch 경로의 실측과 연결 검증 필요. 기반 코드와 출시 증거를 구분 |
| Prompt Planner | Chat route가 plannerVersion: none을 기록하며 미구현임을 명시 | 기존 v1 범위에서 누락할 수 없는 작업. Router와 같은 기능이 아님 |
| 웹 검색·인용·Deep Research | 기존 제품 기능과 요청 처리 경로 있음 | Chat/Auto의 모델 능력·검색 모드·장시간 작업 인계와 통합 확인 |
| 이미지·PDF·Office·텍스트 첨부, Google Drive 가져오기 | 기존 첨부 경로와 Drive 파일 선택·가져오기 구현 | Chat에서 모델별 호환성·권한·지속성을 재사용. 일반 MCP 연결과는 다름 |
| 생성 파일·Artifacts | 구조화 도구, 렌더러, 파일 카드·다운로드, 모델별 허용 정책 있음. main에도 핵심 구현 존재 | 신규 플랫폼이 아니라 기존 기능의 Chat 통합·지원 조합 검증 |
| 프로젝트·검색·이력·공유 | 기존 대화 관리 기능 있음 | 프로젝트는 현재 대화 분류 모델. 프로젝트 공통 지침·지식은 별도 후속 기능 |
| Assistant profile·knowledge | 별도 설정·지식·대화 바인딩 경로 있음 | Chat 문맥 구성에 기존 승인된 동작을 연결. 프로젝트 지식·계정 메모리와 혼동 금지 |
| 외부 대화 가져오기·이어가기 | Import와 별개로 continuation 서비스·화면 구현. 현 정책의 목적지는 Review | 현재 기능 출시 정리와, 새 Chat 목적지 추가는 별개 작업 |
| 장기 Memory | 저장·관리·추출·주입 기반과 평가 작업 존재 | 현재 extraction register에 approved pair 없음. 품질·승인 대기이며 Chat 전체의 출시 대기는 아님 |
| Voice Input | 녹음→텍스트 입력 구현. 제한 실기기 staging 기록 및 production flag 활성화 확인 | 신규 개발·최초 출시 목록에서 제외. 필요할 때 지원 범위 확대·기존 서비스 개선 |
| 실시간 양방향 음성 대화 | Voice Input 완료의 범위에 포함되지 않음 | STT 입력과 통화형 음성·TTS·중간 끼어들기는 별도 제품 범위. 이번 상위 투자에서는 제외 |
| 모바일 웹·PWA·공용 UI | 기존 모바일 웹 기반 존재. packages에는 chat-core와 ui-tokens만 확인 | 새 Chat 모바일 UX, chat-ui·api-client 추출 및 설치 경험이 남음 |
| Native 앱·모바일 인증 | apps/mobile 기본 틀, N2 인증 서버·bridge 구현. 앱 entry는 진단 화면 | 실제 대화 앱 아님. N1b 경로 개방·실기기·로그인·스트림·파일·배포 통합 필요 |
| 크레딧·소유권·삭제·export·운영 안전 | 공통 서버 기반 존재 | 새 Chat/Native/도구 경로가 동일 정책을 지키는지 확인. 전 dispatch moderation의 완성 증거는 별도 공백 |

이미지 **생성**은 별도 이미지 작업 화면의 계약이 있다. 이를 일반 Chat의 이미지 **입력**과 합치거나, Review·Studio 경계를 없애는 변경은 이 우선순위가 승인하지 않는다.

주요 근거: [Chat route](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/app/api/chat/route.ts), [Artifact 지원 정책](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/lib/generatedArtifactToolPolicy.ts), [현재 프로젝트 데이터 모델](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/prisma/schema.prisma), [모바일 앱 entry](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/apps/mobile/src/main.tsx).

## 4. 순위를 바꾸는 결정적 증거

### 4.1 Auto Router는 “거의 GA”로 단정할 단계가 아니다

`check:auto-rollout-readiness`는 검사 자체는 성공하지만 READY는 NO이고, 다음 세 근거가 모두 pending이다.

1. shadow report
2. offline quality evaluation
3. attempt manifest boundary

`check:router-quality-eval`의 성공도 평가 데이터·등록 구조의 유효성을 확인하는 것이지 답변 품질 통과가 아니다.

9월 9일 정리된 사람 평가 60쌍의 judge 비교에서는 최종 judge 선택이 undecided이고 sample size 활성화도 false다. Luna judge의 사람과 반대 판정 비율은 15%로 해당 비교의 10% 기준을 넘었다. 이는 **평가용 심사 모델의 보정 문제**이며, “현재 Tomverse Router 답변의 15%가 틀린다”는 뜻이 아니다.

9월 10일 replay의 제한된 문제·모델 결과와 9월 11일 search-intent 변경도 구분했다. 이전 pilot의 수치를 최신 라우팅 정책 전체의 품질이나 일반 사용자 성능으로 확장할 수 없다. 현재 최우선은 정책 개선과 믿을 수 있는 평가·실제 경로 증거 확보다.

근거: [Auto readiness register](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/lib/autoRolloutReadiness.ts), [사람 평가와 judge 비교](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/docs/ops/router-human-review/primary-60-20260831a/judge-comparison.json), [Replay 진단의 범위](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/docs/ops/router-replay/pilot-60-diagnostics.md).

### 4.2 Voice Input은 새로 만들 일이 아니다

9월 10일 frozen 기록은 staging 통과다. 실제 기기는 Android 10 / Edge 152이며, Android Chrome으로 일반화하지 않았다. iOS Safari·일부 다른 브라우저·언어 및 상호작용 항목은 기록에서 미기록으로 명시한다. 그 미기록을 자동으로 출시 차단으로 격상시키지 않는다.

기록 이후의 guest 관련 변경은 그 기록이 검증한 범위와 같지 않다. 다만 후속 운영 조회에서 production flag=true, kill switch 미작동을 확인했다. 따라서 **이미 활성화된 서비스**이며 최초 출시 후보가 아니다. 지원 기기 확대나 실제 회귀가 확인될 때 필요한 개선을 따로 잡는다. 이번 확인에서 flag를 변경하지 않았다.

근거: [Voice staging 서명 기록](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/docs/ops/voice-input-staging-verification-records/2026-09-10__e8613a554bfbb22676a1be6552932954d79a88c8.md), [Voice 정책](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/docs/policy/voice-input.md).

### 4.3 “외부 대화 이어가기”와 “Tomverse Chat으로 이어가기”가 다르다

최신 continuation 정책은 새 대화를 `productKey=review`, `kind=chat`으로 만든다. kind=chat은 단일 답변 제품 Tomverse Chat을 뜻하지 않는다.

현재 구현은 원본을 지우거나 일반 Message로 통째로 복사하는 방식이 아니라, 원본 snapshot과 연결된 timeline을 보여 주고 제한된 원문 문맥으로 새 답변을 이어가는 방식이다. 기존 대화를 화면에서 확인하며 이어갈 수 있어야 한다는 요구를 다루는 구현이지만, **새 Tomverse Chat 제품으로 보내는 기능까지 완료됐다고 말할 수는 없다.**

현재 Review형 이어가기는 memory flag 둘이 모두 꺼져도 동작해야 한다. Memory 품질 승인을 기다리게 만들 이유가 없다. 새 Chat 목적지를 지원하려면 별도 제품 계약·UI·생성 경로·출처/삭제/잠금 검증이 필요하며, 기존 Review continuation의 productKey를 바꿔 이식하는 방식은 추천하지 않는다.

develop에는 구현이 있으나 이번 main snapshot 및 실제 production 배포 SHA에는 `lib/externalContinuationService.ts`가 없다. 운영 DB에서도 전용 continuation flag 행은 없고 Import flag만 true다. 저장소의 해당 검증 기록 폴더에서는 template·README·fixtures는 확인했지만 완료 서명 기록은 찾지 못했다. 기록 부재 자체를 검증 실패로 판단하지는 않으며, 이번에는 별도의 운영 조회로 배포/활성화 상태를 구분했다.

근거: [외부 대화 이어가기 정책](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/docs/policy/external-conversation-continuation.md), [Continuation 서비스](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/lib/externalContinuationService.ts).

### 4.4 Native는 “아직 아무것도 없음”도 “가볍게 포장하면 완료”도 아니다

N2 인증 구현은 develop에 병합됐다. 다만 `N1B_BEARER_ROUTES = []`이며 이 코드의 존재는 production 개방을 뜻하지 않는다. 앱 entry는 진단 화면이고, 실제 대화 UI와 공용 chat-ui·api-client 패키지가 없다.

앱 README의 “인증 미구현” 설명보다 9월 2일 N2 구현 보고서와 현재 코드를 우선했다. Native는 사용자 수요와 기존 투자 때문에 큰 개발 투자 2순위로 올릴 만하지만, 실제 인증·스트리밍·파일·기기 동작·배포까지 남아 있어 작은 작업으로 추정할 근거는 없다.

근거: [N2 구현 보고서](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/.github/audits/2026-09-02-native-mobile-auth-n2-implementation-report.md), [Bearer 개방 목록](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/lib/mobileAuthContract.ts), [Native 진단 화면](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/apps/mobile/src/ReadinessScreen.tsx).

### 4.5 Memory와 MCP도 같은 종류의 일이 아니다

Memory는 이미 투자한 기능의 품질 문제를 해결하고 승인 가능한 결과를 만드는 작업이다. 현재 extraction register에 approved 상태의 pair는 없다. 후보 등록이나 평가 실행 예산의 승인은 기능 출시 승인이 아니다.

MCP는 새로운 도구 연결·권한·실행 계층을 확장하는 작업이다. Google Drive 파일 가져오기는 이미 있으므로 “첫 외부 연결”이라고 설명하면 안 된다. 이번 소스 범위에서 고객용 일반 MCP 연결·관리·실행 제품 경로는 확인하지 못했다. 개발용 검토 실행기의 MCP 언급은 고객 기능이 아니다.

제한 Preview는 허용한 소수 연결, 읽기 전용 용도, 명시적 연결/해제, 사용자·대화별 권한, 전송 데이터 표시, 비밀값 보호, 결과 출처와 도구 응답의 지시문 분리부터 시작하는 것이 타당하다. 단순히 읽기 전용이라는 이유만으로 데이터 유출 위험이 사라지는 것은 아니다. 임의 서버와 쓰기 도구·자율 실행·마켓플레이스를 한꺼번에 범위에 넣지 않는다.

근거: [Memory extraction 등록부](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/lib/memoryExtractionEvalRegister.ts), [기존 Drive 가져오기](https://github.com/mposition/Tomverse/blob/0efc936a1ca4281c99b56d129dae51dd38ce249d/components/chat/ChatInput.tsx).

## 5. 수정된 우선순위

### 큰 개발 투자의 순서

| 순위 | 작업 | 추천하는 다음 완료 단위 | 이유·조건 |
| --- | --- | --- | --- |
| 1 | Tomverse Chat 모바일 웹 제품 완성 | 단일 답변 화면·진입 + Auto 품질/실제 경로 증거 + 기존 기능 통합. 기존 v1의 Planner·안전 범위도 누락 없이 관리 | 다른 기능이 모일 본체이며 Auto만 끝나도 Chat이 완성되는 것은 아님 |
| 2 | Native Mobile 실제 앱 MVP | 공용 chat-ui·api-client, N1b 개방 조건, 실제 로그인→대화→재접속→파일/음성 입력의 얇은 흐름 | 반복 사용자 요청, 이미 만든 인증 기반. Chat과 공용 UI를 먼저 맞추며 진행 |
| 3 | Memory Release B 품질 완성 | 평가 기준·정답·심사 신뢰성 정리 → 승인 가능한 추출/주입 근거 | 진행 중 투자를 보존하되 no-memory Chat/Native 출시와 독립 |
| 4 | 제한형 MCP Connector Preview | 요구가 확인된 한 가지 업무와 소수 읽기 전용 연결의 끝까지 이어지는 경험 | 확장성은 크지만 현재 본체·모바일 미완료보다 앞설 실측 수요/효과 근거는 없음 |

Chat의 “모바일 웹 우선”은 공식 방향과 맞는다. 다만 Auto 없는 manual-only 공개나 Planner를 제외한 축소 beta는 **새로운 출시 범위 결정안**이다. 이번 분석만으로 기존 승인 조건을 면제하거나 flag를 켜지 않는다.

### 이미 출시한 기능과 남은 짧은 통합 작업

| 순서 | 작업 | 완료의 의미 |
| --- | --- | --- |
| A — 기출시 | Voice Input 운영·필요한 개선 | production 활성화 확인. 최초 출시 작업에서 제외. iOS 등 지원을 넓힐 때 필요한 기기 관측을 별도로 확보 |
| B | 기존 Review형 외부 대화 이어가기 출시 정리 | develop/main 차이·승인 기록 확인, 원문 표시와 첫 답변·잠금·삭제·회귀 검증. 새 Chat 목적지 추가는 1번에 연결된 별도 후속 범위 |
| C | 기존 생성 파일의 Chat 통합 | 지원 모델·검색 조합·재다운로드·권한을 새 Chat에서 확인. 독립적인 대규모 “Artifacts 신규 개발”은 배정하지 않음 |

B의 작은 완료 작업이 투자 순위 4 뒤로 밀리는 것은 아니다. A는 이미 출시되었으므로 되풀이하지 않으며, 주 개발 인력은 Chat에 유지한다.

추가 후보로 **프로젝트 공통 지침·지식**을 남긴다. 다만 현재 프로젝트 분류 기능 및 Assistant profile을 재사용할 수 있는지, 실제 반복 수요가 있는지 확인하기 전에는 신규 상위 작업으로 확정하지 않는다. 실시간 양방향 음성, 임의 MCP 쓰기/마켓플레이스, push/IAP 확대도 이번 상위 목록에서는 제외한다.

## 6. 병행 개발의 현실적인 경계

1인 조직을 기준으로 모든 기능을 동시에 새로 착수하는 방식은 권하지 않는다.

- 주 개발: Chat의 Auto 품질·dispatch·제품 경계와 화면 통합.
- 분리 가능한 클라이언트 작업: shared UI/API 계약을 먼저 맞춘 뒤 Native 클라이언트 구성. 인증/서버 경계 변경은 주 개발과 조율.
- 짧은 출시 작업: continuation과 기존 기능의 Chat 통합을 한 번에 하나씩 검증·정리. Voice의 최초 출시는 반복하지 않음.
- Memory: 진행 중 평가·데이터 작업을 유지하되 Chat·Planner·MCP의 서버 오케스트레이션 변경을 동시에 넓히지 않음.
- MCP: 사용자 업무 선택·권한 설계까지는 진행 가능. 실제 도구 실행 계층의 큰 구현은 위 핵심 흐름이 안정된 뒤.

기존 계획의 22~30주 등 일정은 3인 기준 초기 계획이다. 현재 남은 기간으로 다시 제시하지 않는다. 병행 가능성과 일정은 같은 말이 아니며, 코드 작성이 분리돼도 리뷰·유료 평가·실기기 확인·출시 판단은 같은 운영자에게 모인다.

## 7. 성숙도에 대한 객관적 표현

**공통 플랫폼의 구현 범위는 넓지만, Tomverse Chat 제품 경험과 출시 증거는 아직 그 수준에 도달하지 않았다.**

- 기존 Review 기반 서비스: 재사용 가능한 실제 기능·서버 경로가 다양함. 운영 지표 없는 상황에서 전체를 일괄 GA/고성숙도로 채점하지 않음.
- 새 Chat: 구성 요소 개발·품질 검증 단계. 완성된 대화 제품이라고 보기 어려움.
- Auto·Memory: 테스트·평가 체계가 존재하지만 품질 승인과 같지 않음.
- Voice: production 활성화 확인. 제한 환경에서의 검증 근거도 존재하나 전 기기 품질 검증과는 구분.
- Continuation: 개발 구현과 main 반영·출시 증거 사이에 남은 단계가 있음.
- Native: 인증 기반 구현 단계. 사용 가능한 앱 단계는 아님.
- MCP: 기존 Drive 연결과 별도로 새 제품 범위를 정의해야 하는 단계.

따라서 다음 경쟁력 투자는 기능 메뉴를 늘리는 것보다 **사용자가 Chat에서 첫 답변을 얻고, 문맥을 유지하며, 모바일에서도 다시 돌아오는 완결된 흐름**을 만드는 데 우선 배정하는 것이 합리적이다. 이는 경쟁사 대비 실측 우위 주장이 아니라 현재 Tomverse의 의존성과 구현 공백에 대한 판단이다.

## 8. 조사 방법·한계

- 기존 작업 트리는 detached Aug 29 snapshot이어서 이를 최신으로 간주하지 않았다. origin develop/main을 fetch하고 별도 임시 worktree에서 고정 SHA를 조사했다. 원래 작업의 미커밋 자료는 보존했다.
- 구조 탐색 도구가 일부 TS 파일을 파싱하지 못해 문자열 검색과 관련 코드 경로·정책·서명 기록의 직접 대조로 보완했다.
- 실행한 보고: `check:auto-rollout-readiness`, `check:router-quality-eval`, `report:release-gate-evidence`, `report:issue-backlog -- --issues-file audit-open-issues.json`.
- 보고 실행은 기존 설치 의존성을 연결한 환경에서 수행했다. 깨끗한 설치·전체 테스트·실제 provider 호출을 실행한 것은 아니다.
- issue 보고는 develop/main을 각각 확인했다. 열린 이슈를 미개발 목록으로 간주하지 않았다. 낡은 모델 평가 후보처럼 report의 open_work도 최신 등록부와 다시 대조해야 한다.
- release gate 40건의 draft/pending은 정상 상태다. evidence 보고의 9건 미구현·7건 측정 없음·20건 산출물 존재·4건 Memory 적용 여부 미상은 수동 매핑의 출력이지 현재 기능 완성도 점수가 아니다. 특히 ROUTE-01·AUTH-03·AUTH-04의 매핑 설명은 최신 평가/인증/앱 기본 틀 진척을 충분히 반영하지 못해 코드와 재대조했다.
- 승인된 범위에서 생략한 비차단 검증은 미기록으로 유지한다. 기기별 미기록이나 문구 문제를 근거 없이 전체 출시 차단으로 올리지 않는다.
- 초판에서는 production DB·실제 flag·배포 SHA를 조회하지 않았으나, 사용자 지적 후 위 정정에 기록한 production 배포와 세 AppSetting 키를 읽기 전용으로 확인했다. 사용률·지원 티켓 빈도·결제 전환·유지율은 조회하지 않았다. main 반영이나 flag=true는 전 기능의 품질 검증·GA 승인의 증명이 아니다.
- 계정 인증이 필요한 실제 대화, 실기기, 유료 평가, 비공개 운영 지표까지 검증한 전수 감사는 아니다. 공개 홈페이지와 저장소에서 검증 가능한 범위를 밝힌 제품 우선순위 분석이다.
- 코드/DB/flag/승인 registry/PR/운영 설정은 변경하지 않았다. 산출물은 이 자문 문서뿐이다.
