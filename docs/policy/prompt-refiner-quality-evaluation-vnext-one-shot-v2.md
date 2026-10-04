---
status: draft
policyVersion: 2
workId: CHAT-01
scope: ONE_SHOT_OPERATOR_MANAGED_HOLDOUT_GATE
implementationBlockedUntilApproved: true
approvedBy: null
approvedAt: null
---

# Prompt Refiner vNext 단회 운영자 평가 정책 v2 — 승인 제안

이 문서는 1인 운영에 맞는 **한시적 공식 합성 품질 게이트**를 제안한다. 운영자
`mposition`이 이 문서의 정확한 commit과 SHA-256을 승인하기 전에는 새 구현 범위,
holdout 작성·봉인, 유료 호출, stage/run 또는 `pass` 권한이 생기지 않는다. 정책
구현 승인 뒤에도 holdout 작성·봉인은 접근자·보존 수치가 포함된 **별도 exact
봉인 승인**으로만 열리고, 유료 실행은 다시 별도 승인이다. 기존
[v1 정책](prompt-refiner-quality-evaluation-vnext-draft.md)과
[N=80 수치 계약](../ops/prompt-refiner-quality-evaluation-vnext-numeric-spec-draft.md)의
문항 수·분모·방향·안전·품질·비용·지연·감사 문턱은 낮추지 않는다. v1 후보 source
closure와 v1 corpus, v3–v6 실행·판정(특히 v6 13/16 FAIL)은 수정하거나 재채점하지
않는다. 이 정책은 제품 노출·Auto/Router 결합·실사용 traffic의 승인이 아니다.

## 1. 한 사람 운영의 신뢰 경계

- 후보 model/adapter/system prompt·parser·평가기 작성자는 Codex다. 독립 문항과
  정답·rubric·반례의 작성·보관 및 최종 disposition은 mposition이 맡는다. Codex는
  실제 holdout 내용을 요청·작성·열람하지 않고, 개발에는 공개·합성 fixture만 쓴다.
- mposition은 실제 원문·정답을 이 채팅, 공개 저장소/PR·artifact, Codex가 읽는
  비공개 문서 저장소에 넣지 않는다. 보관 위치는 운영자가 정한다. 별도 Railway
  프로젝트를 사용할 수 있지만 필수 신규 계정·GitHub 인증 이전·토큰 회전·서버
  권한 거부 시험을 이 **단회 절차의 선행조건으로 요구하지 않는다**.
- 이 경계는 운영자와 후보 작성자의 **절차적 약속**이다. 악의적인 관리자나 공유
  호스트 침해에 대한 기술적 격리를 증명한다고 표현하지 않는다. 그 수준이 필요한
  미래 반복·대외 인증은 별도 정책으로 설계한다. 운영자가 예상치 못한 원문 접근을
  발견하면 그 집합은 즉시 development-only가 된다.
- 코드·계약의 독립 검토는 작성자와 다른 Claude Code Max 구독 CLI가 맡는다.
  검토자에게도 실제 holdout 내용은 보내지 않는다.

## 2. 후보 고정과 단회 평가

1. 문항 작성 **전에** 승인된 numeric spec, 후보 source closure의 full commit SHA와
   파일 digest, 모델·adapter·parser·평가기·canonicalizer, runner version, 가격 pin,
   timeout 15초·retry 0, 접근자·보존 수치를 고정한다. 이 값과 actor·시각을
   **작성 전에** 제한 승인 기록과 기존 hash-chained audit writer로 append-only
   기록한다. 이 선행 기록 없이는 작성·봉인·dispatch가 없다. v1 closure의
   파일을 소급 변경하지 않고 단회 runner는 별도 exact digest로 결속한다.
2. mposition이 기존 N=80(ko/en 각 40)의 합성 문항·label·rubric·반례를 작성한다.
   owner가 실행하는 잠긴 validator가 전수 schema·셀·challenge·중복·제품/개인정보
   제외를 검사하고 전체 manifest root를 계산한다. 원문과 root는 제한 보관하며,
   어느 receipt에도 root나 본문·정답·출력 및 그 digest를 넣지 않는다.
3. 실제 원문은 owner가 통제하는 단회 runner에서만 읽는다. 이 runner는 매 dispatch
   직전 전체 manifest root와 후보·가격·남은 슬롯을 다시 계산·대조한다. **이
   단회 경로에 한해** v1 정책 §4의 앱 서버가 원문 전체를 재해시해야 한다는
   요구를 owner-runner의 전수 재해시와 owner의 결속 확인으로 대체한다. 앱은
   원문을 받거나 저장하지 않는다. 이는 위 §1의 절차적 신뢰를 전제로 하는
   명시적 예외이며, caller가 임의 boolean만 보내도 admission되는 뜻이 아니다.
4. 비용·예약·감사 상태는 기존 앱의 서버 소유 경계를 사용한다. 새 successor는
   원문 없는 manifest root·source·deployment·가격·80슬롯을 exact stage와 run
   승인에 결속하고, dispatch마다 durable reservation을 consume한 사실을
   검증한다. source closure의 파일 digest·exact 앱 deployment·가격 pin·남은
   durable reservation은 **비용 승인 결속과 같은 transaction 직전 및 매
   dispatch 직전에 앱 서버가 직접 재관측·재검증**한다. runner가 보낸 값이나
   boolean은 이를 대신하지 못한다. runner는 제품 DB 자격증명·제품 게시 권한을
   갖지 않는다. 이 연결은 별도 구현·테스트·Claude 검토와 **exact 운영 승인**
   전까지 차단한다. 기존
   v1의 `reservation_authority_unavailable`을 과거 승인으로 해제하지 않는다.
5. cache-write count가 미사용 시에도 명시 정수 `0`을 포함해 보고된다는
   **무과금 계약·관측 증거**를 비용 승인 전에 확인한다. provider-free shadow
   준비는 무과금으로 할 수 있으나, **별도 exact stage와 run 승인 뒤 첫 유료
   dispatch 전에** shadow 1회와 content-free read-back으로 승인·예약 결속
   경로를 검증한다. 그 뒤 최대 80건을 **한 번만** 실행한다. 요청당
   29,918 microUSD, 같은 80슬롯의 전체 2,393,440 microUSD, tool 0,
   provider retry 0을 호출 전 강제한다. usage·cache-write·가격·outcome이
   불명확하면 최악 예약을 유지하고 정지한다. 결과 불명은 조회와 사람 인계이며
   같은 문항 재전송은 없다. 실패 문항을 바꾸거나 유리한 회차만 고르지 않는다.
6. 잠긴 결정적 gate가 기존 numeric spec의 **모든** 분모·셀·challenge·안전·비용·
   지연 문턱을 채점한다. 사전 고정 4건과 예외 최대 4건만 mposition이 제한
   감사한다. 원문 없는 합계·실패 이유 코드·비용·지연·source·root 결속은 앱의
   승인 기록과 기존 hash-chained audit writer에 남기고, 운영자가 `pass` /
   `fail` / `insufficient_evidence`를 최종 disposition한다. 사람은 결정적
   gate 결과를 확인하거나 하향할 수 있으나 `fail`·`insufficient_evidence`를
   `pass`로 상향할 수 없다.

## 3. 증거의 범위와 보존

- `pass`는 이 80건 합성 holdout과 고정 후보에 대한 **한시적 공식 품질 게이트**
  결과다. 일반적인 의미 개선율, 주입 저항 인증, 실사용 성공 또는 제품 출시
  승인이 아니다. 필수 증거 한 항목이라도 빠지면 `pass`가 아니다.
- 실패 문항 원문이나 label을 Codex에게 공개해 수정에 쓰면 그 문항과 집합은 이후
  development-only다. 새 공식 확인에는 새 미노출 집합과 별도 run 승인이 필요하다.
- mposition은 제한 원문·answer bundle을 disposition 후 30일 또는 작성·봉인 후
  60일 중 이른 시점까지 파기하고 그 사실을 기록한다. 이 단회 경로는 백업의
  암호학적 복구 불능이나 제3자 침해 방지를 보증하지 않는다. content-free receipt와
  기존 감사 기록은 각자의 보존 계약을 따른다.
- 본문 없는 source SHA·runner digest·manifest root·승인 actor/시각·비용·
  aggregate·disposition만 제한 승인 기록에 둔다. 어느 receipt·알림·PR에도
  root와 본문·출력에 결속된 digest를 넣지 않으며 opaque ID와 내용 없는
  상태만 둔다.

## 4. 승인·구현 차단

이 정책 초안은 v1 정책의 **holdout 원문·manifest root 전수 재해시 주체와
절차적 접근 경계**만 단회 범위에서 변경한다. 수치 spec의 서버 read-back 중
원문·root 전수 재해시 부분만 위의 owner-runner 전수 검사로 대체한다.
source closure·deployment·가격·예약의 서버 직접 재검증과 나머지 수치·판정
규칙은 그대로다. 이 차이를 숨겨 기존 v1 gate가 통과한 것처럼 표시하지 않는다.

운영자가 정확한 정책 버전·commit·SHA-256과 `ONE_SHOT_OPERATOR_MANAGED_HOLDOUT_GATE`
구현 범위를 승인한 뒤에만 원문 없는 runner/서버 결속 코드·합성 테스트를
개발한다. **그 구현 승인도** mposition의 실제 holdout 작성·보관, 별도 exact
봉인 승인(접근자·보존 수치 포함), 비용·stage·run 승인, provider 호출,
PR 병합·배포, flag·제품 연결을 허용하지 않는다. 새 코드는 Claude Code Max
구독 CLI의 독립 검토와 CI를 거친다.
