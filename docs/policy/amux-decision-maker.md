# AMUX Decision Maker

상태: **초안 — 승인 대기. 구현 없음.** 최초 작성 2026-10-07.

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | **승인 대기** | 최초 초안. 2026-10-07 운영자가 대화에서 정한 결정(§0)을 담는다. 독립 검토 세 회차 뒤 운영자 결정 10에 따라 **제안 모드 전용**으로 줄였고, 네 번째 회차의 지적을 반영한 여섯 번째 초안이다. |

이 문서는 운영자가 `approvedBy`·`approvedAt`을 기록하기 전까지 구현 근거가 아니다(공통 기반
원칙 1). 이 정책은 두 개정을 전제로 하며, 각각 운영자가 따로 승인한다.

- **공통 기반 r16:** 원칙 11(DM 프로세스의 실행 위치), §3(카드와 저장소 스냅샷의 공급사 전송), §4(질문·답 본문의 앱 DB
  저장)의 좁은 예외. 원칙 3은 개정하지 않는다. v1의 DM 출력은 운영자가 확정하는 신호이기 때문이다.
- **오케스트레이션 정책의 새 버전**(다음 빈 번호): 전용 Ubuntu runner의 worker 목록에 DM 둘을
  §5의 격리 조건(실행 계정, 전용 launcher의 고정 argv, hard timeout)으로 더한다. 새 버전은 그 조건을 빼고 목록만 넓힐
  수 없다. 이 정책은 그 목록을 스스로 넓히지 않는다.

두 개정이 승인되기 전에는 §12의 해당 단계를 시작하지 않는다. 승인돼도 각 단계의 독립 검토는 그대로다.

## 0. 운영자 결정 (2026-10-07)

1. DM이 다룰 수 있는 질문 유형은 `decision`, `judgment`, `budget`, `credential`, `access`,
   `external`이다. `customer_outbound`는 항상 운영자. 되돌릴 수 없는 행위는 유형과 무관하게 운영자.
2. 시작은 제안 모드. 자율 졸업 기준은 운영자가 결정한 제안 **50건**, 첫 제안 뒤 **30일**, 수정 없이
   확정한 비율 **95%** 이상.
3. DM은 공급사를 교차한 두 개(GPT-6 Astra, Claude Fable 5.1).
4. 자율 답변을 위해 공통 기반 원칙 3을 개정한다.
5. DM은 질문 카드와 묻는 worker의 저장소를 읽는다.
6. 기록은 Tomverse 앱 DB와 해시 체인 감사에 둔다.
7. DM은 Tomverse AMUX의 추가 worker로 둔다.
8. 코드·문서·테스트 변경 선택지도 경로 검사를 통과하면 자율 대상이다.
9. 운영자는 제안을 Tomverse Admin에서 확정한다.
10. **v1은 제안 모드만이다.** 효과 등급·`resolution`·경로는 묻는 worker가 스스로 선언하고, 결정적 코드는
    그 의미를 검증하지 못한다(세 번째 검토의 차단 지적). 그래서 결정 2의 졸업, 결정 4, 결정 8은 **v2 정책과
    공통 기반 원칙 3의 별도 개정**으로 넘긴다. v2의 근거는 v1이 기록하는 선언 정확도(§4)다. 졸업 기준이
    이미 제안 50건·30일이므로 이 순서는 자율 시작을 늦추지 않는다.

## 1. 목적과 경계

AMUX worker가 운영자의 답을 요구하는 질문(로컬 AMUX board의 typed ask)을 DM이 먼저 읽고 **답의 제안**을
만든다. 운영자는 Tomverse Admin에서 그 제안을 그대로 확정하거나, 고쳐서 확정하거나, 거절하고 직접 답한다.
**DM의 출력은 운영자가 확정하기 전에는 worker에게 가지 않는다.** v1에 자율 답변은 없다.

DM은 **제안을 쓰는 worker이지 승인자가 아니다.**

- `docs/policy/amux-agent-approval-contract.md`(이하 승인 계약)의 작업 검토·외부 행위 승인,
  `docs/policy/development-agent-orchestration.md`(이하 오케스트레이션 정책)의 승격·자동 승격·완료
  확정, PR 병합, 배포, 그 밖에 사람 actor를 요구하는 모든 게이트에서 DM은 사람으로 인정되지 않는다.
  DM의 시스템 actor는 닫힌 목록 항목이고 `auditRowActorKind()`가 사람으로 판정하지 않는다.
- 운영자가 확정한 답도 질문에 대한 답일 뿐 승인 계약의 승인이 아니다. 사람 승인이 필요한 게이트는
  worker가 따로 요청한다.
- worker 계정에는 제품 DB·배포·main 병합·외부 발송 권한이 없다(오케스트레이션 정책 v23). DM도 확정된
  답도 그 권한을 만들지 않는다.
- DM은 자기 라우팅 규칙, 용어 목록, 효과 등급 어휘, 경로 분류, 스위치, 이 정책, 정책 테스트를 고칠 수
  없다(원칙 6). 경로 분류의 원천인 `lib/agentAuthorityFiles.ts`는 사람이 소유한다.

## 2. 흐름

1. worker가 typed ask를 올리면 로컬 AMUX가 bridge(오케스트레이션 정책 v23의 outbound 경로)로 앱
   내부 route에 요청을 보낸다. **카드는 상태 `needsyou` 그대로 운영자 대기열에 있고, 운영자는 처음부터
   끝까지 언제든 직접 답할 수 있다.** route는 요청 행을 만들 때 DB 시계로 배정 마감(생성 + 2분)을 적고,
   마감이 지난 요청에는 배정을 내주지 않는다. route 실패·bridge 실패·마감 경과면 DM 없이 운영자만 남는다.
2. **앱 내부 route(결정적 판정, LLM 없음)** 가 §3으로 `operator`나 `dm_proposal`을 정하고, 요청 행과
   시스템 감사를 같은 트랜잭션에 쓴다.
3. DM 배정이 오면 로컬 AMUX는 **한 번의 비교·교체**로 카드에 DM 대기 표시를 붙인다(상태는 바꾸지 않는다).
   카드가 아직 같은 질문 revision의 `needsyou`이고 운영자 답이 없을 때만 붙이며, 아니면 배정을 버리고 그
   사실을 route에 보고해 요청을 닫는다.
4. 로컬 AMUX는 §5의 입력(카드와 스냅샷)을 DM 계정의 작업 디렉터리에 **먼저 다 만들고**, 그 바이트의 payload
   digest와 스냅샷 manifest digest를 계산한다. 그 두 digest를 담아 §10의 전송 의도를 route에 기록하고, 응답을
   받은 뒤에만 그 바이트 그대로 DM 프로세스를 시작한다. 만든 뒤 바뀐 입력은 보내지 않는다.
5. DM의 구조화된 출력을 bridge가 route로 보낸다. route가 §6으로 검증하고, 통과하면 제안으로 저장한다.
   시간 초과·검증 실패·이관이면 로컬 AMUX가 표시를 떼고 카드에는 **닫힌 사유 코드**(`dm_timeout`,
   `dm_invalid`, `dm_escalated`, `dm_unavailable`)만 남긴다. 모델이 쓴 문장은 카드에 쓰지 않는다.
6. 운영자는 Admin에서 제안을 그대로 확정·고쳐서 확정·거절한다. 권한은 `ops:write`와 최근 step-up이고
   판정은 사람 감사로 남는다(승인 계약 §2와 같은 조건). 같은 화면에서 선언 정확도(§4)를 기록할 수 있다.
7. 운영자가 확정한 답만 bridge가 가져가고, 로컬 AMUX가 기존 운영자 답변 경로(worker 세션 메시지 + 카드
   기록)로 전달하며 전달 영수증을 보고한다. **질문 revision 하나에는 답이 한 번만 전달된다.** 로컬 AMUX는
   (카드 id, 질문 revision)을 유일 키로 갖는 답변 기록을 두고(S2가 추가한다. 지금의 답변 경로는 세션
   메시지 id로만 중복을 거른다), 운영자의 직접 답과 확정된 DM 답이 모두 그 기록을 먼저 써야 보낸다. 먼저 쓴
   쪽만 전달되고, 다른 쪽은 거절되어 운영자에게 보인다. 운영자의 직접 답이 먼저면 요청은 닫힌다.

## 3. 라우팅 — 앱 route의 결정적 판정

아래 검사를 **모두 실행**하고 하나라도 걸리면 `operator`다. DM에게 보내지 않으며, 카드는 운영자 대기열에
그대로 있다. 모두 통과하면 `dm_proposal`이다. 선택지가 없는 질문도 제안 대상이다.

1. 전체 kill switch가 켜짐, 배정될 인스턴스 스위치가 `off`, 설정을 읽지 못함.
2. `ask_type`이 허용된 여섯(§0-1) 밖. `customer_outbound`도 여기다.
3. 되돌릴 수 없는 행위 용어 목록에 걸림. 판정 입력은 카드의 type·tag·제목·질문·선택지·해제 조건·worker가
   적은 맥락. 아래가 v1 목록이며 바꾸면 정책 버전이 바뀐다: main 병합, ship·release·배포·production,
   삭제·delete·drop·truncate·덮어쓰기, migration, 결제·환불·청구, 외부 게시·발송·연락, secret·token·
   password·API key의 제공, 권한·접근 설정 변경, 정책·workflow·branch protection 변경. 정확한 대소문자·
   어형 규칙과 검사 문자열은 S1의 테스트 고정값이 정한다.
4. `credential`·`access`·`external` 질문의 `resolution`이 `decision_only`가 아님. worker는 이 세 유형에
   `resolution`(`needs_secret`·`needs_permission_change`·`needs_contact`·`decision_only`)을 적는다. 비밀값
   제공, 권한 변경, 제3자 연락은 DM이 도울 수 없는 일이다. DM은 비밀값을 받지도 주지도 않는다.
5. 묻는 worker의 모델 공급사가 확인되지 않음(§7).
6. 처리량 초과: 인스턴스마다 시간당 20건, 하루 100건.
7. 입력 한도 초과(§5).
8. 카드 텍스트가 secret 검사에 걸림. route는 카드 전체를 기존 secret 검사 규칙으로 검사하고, 걸리면 전송하지
   않는다.

용어 목록과 `resolution`은 v1에서 **DM이 제안을 쓸지**만 정한다. worker가 `resolution`을 잘못 적어도 운영자
확정 없이는 아무것도 worker에게 가지 않으며, 카드는 8의 검사를 통과해야 전송된다. DM의 출력은 질문을
**운영자 쪽으로만** 옮길 수 있다(§6).

## 4. 효과 등급 선언과 정확도 기록 — v2의 근거

worker는 선택지마다 효과 등급을 선언한다. 변경 등급은 바꿀 저장소 경로 목록(1~50개)을 함께 적는다.
v1에서 이 선언은 **라우팅에 쓰지 않는다.** 운영자가 판단할 정보이고, v2가 쓸 측정 대상이다.

| 효과 등급 | 뜻 |
|---|---|
| `choice_only` | 정보·방향 선택. 그 자체로 파일이 바뀌지 않는다. |
| `wait_or_defer` | 기다리거나 다른 작업을 먼저 한다. |
| `branch_code_change` | 그 worker의 작업 브랜치에서 코드 변경 |
| `docs_change` | 작업 브랜치의 문서 변경 |
| `test_change` | 작업 브랜치의 테스트 변경 |
| `other` | 위에 없는 효과. 선언이 없거나 형식이 틀린 선택지도 여기로 기록한다. |

- route는 선언한 경로마다 `lib/agentAuthorityFiles.ts`의 분류를 계산해 요청에 기록하고 Admin에 보인다.
- 운영자는 제안을 판정할 때 질문 단위로 **선언 정확도**를 `matched`·`mismatched`·`not_judged` 중 하나로
  기록할 수 있고, `mismatched`면 틀린 항목(효과 등급, `resolution`, 경로)을 고른다. 기본값은 `not_judged`다.
  이 기록은 판정과 같은 트랜잭션의 사람 감사다.
- **보고:** 인스턴스별로 운영자가 결정한 제안 수, 첫 제안 뒤 일수, 수정 없이 확정한 비율, 판정된 질문 중
  `matched` 비율, `not_judged` 수를 각자의 분모와 함께 보인다. 분모가 비면 `insufficient_evidence`다. 보고는
  스위치·모드를 바꾸지 않고, 졸업을 기록하지 않으며, 자율을 허락하지 않는다.
- **v2가 답해야 할 질문**(이 정책은 답하지 않는다): 선언을 무엇으로 검증하는가. `lib/agentAuthorityFiles.ts`가
  정책 테스트를 `product`로 분류하는 점. 통제 평면이 읽는 제품 파일이 엔지니어링 Agent 게시 등급에서 T2인
  점. 변경 뒤 실제 commit 경로를 어느 구간으로 대조하는가.

## 5. DM의 입력과 격리 — 공통 기반 r16 §3 예외

- **카드:** 질문 카드의 구조화된 필드(유형·질문·선택지·효과 등급·경로·`resolution`·해제 조건·worker가 적은
  맥락)만. 상위·의존 카드는 넣지 않는다. 카드 텍스트는 합계 16 KiB 이하. 카드의 URL을 가져오지 않는다.
- **저장소 스냅샷:** 저장소 전체가 아니라 **고른 파일**이다. 대상은 worker가 typed ask에 적은 맥락 경로
  (최대 64개)와 변경 선택지가 선언한 경로를 합친 것이며, 각각 그 worker의 현재 HEAD에 있는 Git 추적
  파일이어야 한다. 디렉터리, untracked·ignored 파일, worker 홈, 다른 worktree, submodule, symlink,
  바이너리(NUL 바이트 또는 UTF-8 아님)는 넣지 않는다. 비밀 패턴 목록에 걸린 경로를 뺀다. v1 목록은
  `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_*`, `*secret*`, `*credential*`, `.npmrc`, `.netrc`,
  `.pgpass`이고 바꾸면 정책 버전이 바뀐다. 남은 파일 전체를 기존 secret 검사 규칙으로 검사해 걸린 파일을
  뺀다. 파일당 256 KiB·합계 2 MiB를 넘으면 §3-7로 운영자다. 무엇을 뺐는지는 건수와 사유만 기록한다.
- **허용 저장소:** v1 허용 목록은 `github.com/mposition/Tomverse` 하나다. worker는 같은 계정에서 `origin`
  같은 로컬 Git 설정을 바꿀 수 있으므로, 저장소 판정에 remote 설정이나 worker가 적은 값을 쓰지 않는다. 판정은
  **내용**으로 한다. HEAD 이력의 root commit이 정확히 하나이고, 그것이 정책 버전에 고정한 이 저장소의 root
  commit SHA와 같아야 한다. 이 검사와 스냅샷 읽기는 replace 객체·graft를 끈 Git(`GIT_NO_REPLACE_OBJECTS=1`)으로
  하며, shallow 이력은 root를 증명하지 못하므로 거절이다. 통과하지 못한 질문은 카드만 보낸다. 통과한 저장소의
  파일은 공개 저장소의 commit에서 온 것이거나 그 worker가 자기 브랜치에 쓴 것이다.
- **r16 §3 승인 전에는 아무것도 보내지 않는다.** 카드도 스냅샷도 DM 공급사로 가는 회수할 수 없는 새
  전송이다(§11). 그 승인 전에는 DM 프로세스를 시작하지 않는다.
- **실행 계정:** DM 프로세스는 worker 계정과 다른 권한 없는 Linux 계정에서 돈다. 두 CLI 로그인만 있고
  GitHub 로그인·git credential helper·SSH 키·제품 DB·배포 자격증명·bridge 환경 파일·worker 홈 읽기
  권한이 없다. 입력은 그 질문 동안만 그 계정의 작업 디렉터리에 있다.
- **실행 방식:** DM은 일반 worker launcher를 쓰지 않는다. 지금의 launcher는 `codex`에
  `--dangerously-bypass-approvals-and-sandbox`나 `--sandbox workspace-write`와 `--add-dir`을, `claude`에
  `--dangerously-skip-permissions`를 붙이기 때문이다. 전용 launcher가 질문마다 비대화형 프로세스 하나를
  **고정 argv**로 시작한다. `codex`는 read-only sandbox에 추가 디렉터리 없음, `claude`는 도구를 모두 끈
  모드다. 정확한 argv는 S0이 실측해 정책 버전에 기록한다. 실행 직전 argv에 위의 플래그나 쓰기·명령 실행을
  허용하는 플래그가 있으면 시작을 거부한다.
- **hard timeout:** 질문당 30분이 지나면 DM 프로세스를 강제 종료한다. 늦은 결과는 §9가 거절한다.
- **외부 텍스트:** worker가 카드에 인용한 로그·이슈 발췌는 데이터다. DM 지시문은 그 안의 지시를 따르지
  말라고 명시한다(원칙 3의 둘째 문장).

## 6. DM 출력의 검증과 운영자 확정

DM 출력은 `.strict()` 스키마 값 하나이며 종류별로 검증한다.

| 종류 | 내용 | 결과 |
|---|---|---|
| `select` | 선택지 id, 근거, `irreversible` | 제안 |
| `free_text` | 답 본문(상한 있음), 근거, `irreversible` | 제안 |
| `escalate` | 이관 사유 | 제안 없이 운영자. 검증 실패가 아니다 |

- `select`: 선택지 id가 요청에 있어야 한다.
- `irreversible`이 true면 제안을 저장하되 Admin에 그 표시를 먼저 보인다. 검증 실패로 세지 않는다.
- 답 본문·근거·이관 사유는 secret 검사를 통과해야 한다. 이관 사유는 Admin에만 보이고 카드에는 가지 않는다.
- 스키마 위반, 없는 선택지 id, secret 검사 실패만 **검증 실패**다. 제안을 저장하지 않고 §8의 latch에 센다.
- **종결 결과는 하나:** 제안, 이관, 검증 실패, 시간 초과, DM 불가 가운데 요청마다 **먼저 기록된 하나**만
  남는다(DB 유일 제약). 그 뒤에 온 출력은 늦은 결과로 거절한다.
- **확정 시점 확인:** 운영자의 확정은 요청이 열려 있고 §9의 결속 값이 그대로이며, Admin이 보여 준 제안
  본문의 digest가 저장된 본문과 같을 때만 그 본문을 답으로 만든다. 본문 행은 고칠 수 없다(§10). 운영자가
  고친 답은 새 본문 행이 되고 그 digest가 판정에 기록된다. 결속 값이 바뀌었으면 Admin은 제안을 낡은 것으로
  보이고 그대로 확정할 수 없게 한다. 운영자는 직접 답한다.
  kill switch와 `off`는 새 라우팅과 DM 프로세스 시작을 멈추며, 이미 저장된 제안을 운영자가 확정하는 것은 막지 않는다.
  확정은 사람의 답이기 때문이다.

## 7. DM 인스턴스, 실행 위치, 표시

| 인스턴스 | CLI와 모델 | 받는 질문 |
|---|---|---|
| `decision-maker-openai` | `codex`, GPT-6 Astra | `claude` provider worker |
| `decision-maker-anthropic` | `claude`, Claude Fable 5.1 | `codex` provider worker |

- 공급사는 오케스트레이션 정책의 확인된 provider(`claude`, `codex`) 기준이다. 그 밖의 provider(gemini,
  ollama, cursor, copilot, devin 등)의 질문은 운영자다. 확인 목록이 넓어지면 이 표도 정책 버전으로 넓힌다.
- 배정된 DM이 꺼져 있거나 응답할 수 없으면 다른 DM으로 넘기지 않는다. 운영자만 남는다.
- **실행 위치:** 두 DM은 Tomverse AMUX가 관리하는 추가 worker로, 오케스트레이션 정책 v23의 전용 Ubuntu
  runner에서 질문마다 전용 launcher가 시작하는 비대화형 프로세스로 돈다(§5). 이 배치는 r16 원칙 11 예외와 오케스트레이션 정책의 새 버전이 승인해야 성립한다.
- **사용량:** DM CLI 호출은 오케스트레이션 정책 v22 §5의 공통 사용량 사건을 남기되 namespace
  `amux-decision-maker`를 갖는다. 이 namespace의 unknown은 Task 비용 판정과 claim 보류에 쓰이지 않는다.
  DM에게 강제 가능한 호출 전 상한은 §3-6의 처리량이다.
- **worker에게 보이는 표시:** 확정된 답의 메시지는 `[Decision Maker <인스턴스> (<모델>) 제안,
  <operator-confirmed|operator-edited>, re <카드>]`로 시작하고 "승인 계약의 승인이 아니다. 사람 승인이
  필요한 게이트는 따로 요청한다"는 문장을 붙인다. 카드 기록도 같은 표시를 쓴다.

## 8. 스위치와 정지

- 인스턴스별 스위치는 `off`·`proposal` 둘뿐이다. 기본 `off`, 읽기 실패 `off`. 저장소의 CHECK 제약이 다른
  값을 거부한다. 전체 kill switch는 모든 질문을 운영자에게 보낸다. 스위치 변경과 latch 해제는 `ops:write`와
  최근 step-up을 요구하고 사람 감사로 남는다.
- 검증 실패(§6)가 연속 3건이면 그 인스턴스를 `off`로 latch한다. 해제는 운영자만.
- §4의 보고가 결정 2의 기준을 넘어도 이 정책 안에서는 아무것도 바뀌지 않는다.

## 9. 결과를 모를 때와 늦은 결과

- 요청은 (카드 id, 질문 revision)당 하나다. 같은 질문이 다시 와도 새 요청을 만들지 않는다.
- **결속 값:** 카드 id와 질문 revision, 묻는 worker id, AMUX 세션 id와 그 세션의 시도 번호, 저장소
  root commit 판정 결과와 HEAD commit, 선택지 집합 digest, 스냅샷 manifest digest, 입력 payload digest, 정책 버전,
  용어 목록·경로 분류·scanner 버전. 요청이 닫혔거나 결속 값이 하나라도 바뀐 요청에 도착한 결과는 거절을
  기록한다.
- **DB 시계 마감:** 요청 행은 DB 시계로 배정 마감(생성 + 2분)과 결과 마감(배정 + 30분)을 갖는다. 배정과
  결과 수신을 쓰는 트랜잭션은 오케스트레이션 정책 v19의 `AmuxCommitDeadline` 장치를 쓴다. 그 트랜잭션의
  fence가 기한 D(해당 마감에서 commit 예비시간 200 ms를 뺀 값)를 남기고, `DEFERRABLE INITIALLY DEFERRED`
  constraint trigger가 COMMIT의 검사 시점에 DB 시계가 D에 닿았으면(`clock_timestamp() >= D`, migration
  `20260929200000_amux_commit_deadline_check`) 트랜잭션 전체를 거부한다. 그래서
  **검사 시점에 마감을 넘긴 결과는 DB가 제안으로 기록하지 않는다.** 검사 뒤의 commit record 기록·flush는
  이 장치 밖이며 commit 예비시간이 그 구간을 위해 있다. 이 정책은 durable 완료 시각을 보장한다고 쓰지
  않는다. 운영자 확정은 결과 마감에 묶이지 않고 요청의 열림 상태와 결속 값에만 묶인다.
- **한 번만 소비:** 요청마다 종결 결과 행과 전달 결정 행은 각각 하나뿐이다(DB 유일 제약).
- **timeout 층:** route 트랜잭션은 기존 AMUX DB 경계(`lib/amux/dbBoundary.ts`)를 그대로 쓴다.
  `statement_timeout` 200 ms, `idle_in_transaction_session_timeout` 100 ms, commit 예비시간 200 ms이고, DM
  연산마다 Prisma 호출 상한을 12 이하로 둔다. 트랜잭션당 최대 시간은 그 셋에서 유도한
  12 × (200 + 100) + 200 = 3,800 ms이며, 앱이 유도한 값이고 DB 상한이 아니다(Prisma 호출 상한은 SQL 문장
  카운터가 아니다). `transaction_timeout`은 걸지 않는다. CI에 PostgreSQL 16이 있고 16에는 그 설정이 없으며,
  기존 경계도 같은 이유로 걸지 않는다. route 예산은 `AMUX_ROUTE_BUDGET_MS`(15초)이고, 남은 route 시간이
  트랜잭션 최대 시간보다 짧으면 트랜잭션을 시작하지 않는다(`amuxRouteHasBudgetForMs`). 연결 대기도 남은
  시간에서 그 최대 시간을 뺀 만큼으로 묶는다(`amuxDbConnectionWaitMs`). 묶이지 않고 남는 구간은 첫 문장
  전까지와 COMMIT 검사 뒤의 기록·flush다.
- worker에게 확정된 답을 전달한 결과가 불명확하면 다시 보내지 않는다. 그 요청을 `delivery_unknown`으로
  두고, **그 worker 세션을 일시 정지**(AMUX pause)한 뒤 로컬 메시지 멱등 키로 전달 영수증을 조회한다. 확정되지
  않으면 운영자에게 "전달 여부 미확인"을 보인다. 운영자가 확인하고 재개하기 전에는 다른 답을 보내지
  않는다(원칙 7).

## 10. 기록, 본문, 보존 — 공통 기반 r16 §4 예외

- **결정 원장(변경 불가):** 요청, 배정, DM 결과, 운영자 판정과 선언 정확도, 전달 영수증, 스위치 기록을
  append-only 행으로 둔다. 상태는 새 행으로 남기며(요청 열림·닫힘), UPDATE·DELETE는 DB trigger가 막는다.
  본문은 원장에 넣지 않는다. 본문 식별은 서버 키의 keyed digest로 하며 평문 hash를 두지 않는다.
- **digest 키:** 키는 30일 단위로 바꾸고 서버 비밀 저장소에만 두며 로그에 남기지 않는다. 한 기간의 본문
  행이 모두 지워지면 그 기간의 키를 파기해, 원장의 digest를 더는 본문과 대조할 수 없게 한다. legal hold가
  걸린 행이 남은 기간의 키는 hold가 풀릴 때까지 둔다. 키 교체·파기는 시스템 감사로 남긴다.
- **본문 저장소(분리):** 운영자가 Admin에서 판단하려면 본문이 필요하다. 별도 표에 다음 다섯 필드만 둔다.
  질문 카드 텍스트(16 KiB), DM 제안 답 본문(8 KiB), DM 근거(4 KiB), DM 이관 사유(1 KiB), 운영자가 고친
  답(8 KiB). 요청당 합계는 40 KiB 이하다. 저장 전에 secret 검사를 통과해야 한다. 행은 고칠 수 없다(UPDATE를
  trigger가 막는다).
- **보존:** 요청이 닫힐 때 DB 시계로 `retentionUntil`(닫힘 + 90일)을 적고, trigger가 그 값의 변경을 막는다.
  열린 요청은 생성 30일 뒤 `stale`로 닫으므로 본문은 길어야 120일 남는다. legal hold는 `ops:write`와 최근
  step-up의 사람 조작으로만 걸고 풀며 사람 감사로 남는다. 그 표의 DELETE는 `retentionUntil`이 지났고 hold가
  없는 행에만 trigger가 허락한다. 예외는 하나다. 개인정보 삭제 요청이 확인되면 운영자가 해당 행을
  `ops:write`와 최근 step-up으로 지우며, 그 삭제는 사람 감사로 남고 hold가 걸린 행은 hold를 먼저 풀어야 한다.
  백업은 플랫폼의 백업 보존 기간을 따른다. 본문은 감사 metadata·로그·알림에 넣지 않는다. 저장소 스냅샷은
  앱으로 보내지 않는다.
- **데이터 등록부:** 본문 표(worker가 쓴 자유 텍스트에 개인정보가 섞일 수 있다)와 사람의 id를 가진 원장
  행을 공개 data-domain registry에 운영 기록으로 등록한다. 본문 표에는 사용자 계정 키가 없으므로 계정 단위
  고객 export에 넣지 않으며, 열람·삭제 요청은 운영자가 본문을 검색해 처리한다.
- **전송 기록:** 카드와 스냅샷을 DM 공급사로 보내는 일은 회수할 수 없으므로, 로컬 AMUX는 입력을 다 만든
  뒤(§2-4) DM 프로세스를 시작하기 전에 route에 전송 의도(인스턴스, 공급사, 입력 payload digest, 스냅샷
  manifest digest)를 기록하고 그 응답을 받은 뒤에만 시작한다. 프로세스가 끝나면 전송 영수증을 보낸다.
  의도만 있고 영수증이 없으면 `transmit_unknown`으로 두고 보낸 것으로 친다. 그 요청은 다시 보내지 않는다.
- **감사 action**은 다음으로 닫는다. 시스템: `amux.decision.route`, `.assign`, `.assign_discarded`,
  `.transmit_intent`, `.transmit_receipt`, `.transmit_unknown`, `.result`, `.result_rejected`, `.deliver`,
  `.delivery_unknown`, `.latch`, `.digest_key_rotate`, `.digest_key_destroy`. 사람: `.confirm`, `.edit_confirm`,
  `.reject`, `.mode`, `.latch_release`, `.legal_hold`, `.delivery_unknown_resolve`, `.body_erase`. 시스템의
  `.stale_close`도 여기에 든다.
- **actor:** `amux-decision-router`, `amux-decision-maker-openai`, `amux-decision-maker-anthropic`을 닫힌
  시스템 actor 목록에 리뷰로 추가한다. 모든 쓰기는 `writeSystemAuditLog()` 또는 사람 감사와 같은 트랜잭션이다.
- 단일 writer 모듈이 위 표들에 쓴다.

## 11. 비용, 데이터, 법규

- DM은 구독형 CLI 계정을 쓴다. 공급사 청구액을 측정한다고 주장하지 않는다. 사용자 크레딧·플랜·Chat
  provider 예산과 닿지 않는다(원칙 5). `budget` 질문의 지출은 운영자가 확정할 때 운영자의 결정이다.
- 질문 카드와 스냅샷은 묻는 worker의 공급사와 **다른** 공급사로 간다. 그 공급사가 같은 바이트를 이미
  받았다고 가정하지 않는다. **카드와 스냅샷의 전체 payload를 배정된 DM 공급사에 대한 새 전송으로 보며**,
  공통 기반 r16 §3의 승인, 전송 의도 기록, S0의 처리위탁·국외 이전(APP 포함) 검토가 그 전체를 범위로 한다. 이 정책은 처리 region을 보장한다고 쓰지 않는다. 중국 본토 접속·처리
  region·그 지역 공급자는 쓰지 않는다.
- DM은 고객 대면 문구를 만들지 않는다.

## 12. 단계

1. **S0(유료 turn 포함, 운영자 승인 필요):** 두 CLI의 두 모델 가용성, DM 계정의 읽기 전용 모드가 쓰기·
   명령 실행을 막는지, 구조화 출력, 강제 종료, 재시도·중복 응답 형태, 두 공급사의 처리위탁 조건 → CLI별
   복구 계약 표.
2. **S1:** 앱 DB(원장·본문 표·trigger·단일 writer), 라우팅 route, 시스템 actor, 스위치(기본 `off`, 값은
   `off`·`proposal`뿐), 선언 정확도 기록과 보고, 용어 목록의 테스트. DM 호출 없음.
3. **S2:** 로컬 AMUX(typed ask의 선택지·효과 등급·경로·맥락 경로·`resolution` 필드, DM 대기 표시의 비교·
   교체, (카드 id, 질문 revision) 유일 키의 답변 기록, 닫힌 사유 코드), bridge 경로, DM 계정과 전용
   launcher, Admin 제안 화면. 카드 입력만. 선행 조건은 오케스트레이션 정책의 새 버전, r16 원칙 11·§3·§4
   승인, 그리고 S0의 쓰기·명령 실행 차단 실측 증거다. 서버 반영은 운영자 승인.
4. **S2b:** 저장소 스냅샷. S2가 선행 조건이다.

자율 답변은 이 정책의 단계가 아니다. v2 정책과 공통 기반 원칙 3의 별도 개정이 필요하며, 그 근거는 §4의
기록이다.

차단 기준(되돌릴 수 없는 것): DM이 승인 게이트에서 사람으로 인정되지 않는다는 테스트, **운영자 확정 없이는
어떤 DM 출력도 worker에게 전달되지 않는다는 테스트**, 스위치가 `off`·`proposal` 밖의 값을 거부한다는 DB
테스트, 용어 목록·`resolution`·카드 secret 검사 라우팅 테스트, 검사 시점에 마감을 넘긴 COMMIT 거부 DB
테스트, 요청당 종결 결과 1개 테스트, 직접 답과 확정 답이 함께 와도 하나만 전달된다는 로컬 테스트, 모델이 쓴
문장이 카드에 가지 않는다는 테스트, 보여 준 digest와 다른 본문은 확정되지 않는다는 테스트, 전용 launcher가
금지 플래그를 거부한다는 테스트, 읽기 전용 모드·DM 계정 격리의 S0 증거, 스냅샷의 허용 저장소(root commit 불일치·replace 객체·shallow 이력 거절)·비밀 제외
테스트, 전송 의도 없이는 DM 프로세스가 시작되지 않는다는 테스트.

## 13. 이 정책이 하지 않는 것

- 자율 답변을 하지 않는다. DM의 출력은 운영자가 확정하기 전에는 worker에게 가지 않는다.
- 공통 기반 원칙 3을 개정하지 않는다.
- 승인 계약, 오케스트레이션 정책의 게이트·승격·자동 승격·확인된 provider 목록을 바꾸지 않는다.
- 터미널의 대화형 질문(`AskUserQuestion` 등)에 키를 눌러 답하지 않는다(AMUX의 기존 규칙 유지). 도구
  실행 승인 화면에도 답하지 않는다.
- worker의 권한을 넓히지 않는다.
