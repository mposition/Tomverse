# OI-F4 V — 남은 방법론 경고와 판정 범위의 독립 확인

한국어로 보고하는 독립 reviewer Claude다. 이 세션은 별도 확인 1회다.
이전 reviewer의 결론이나 작성자의 이의를 그대로 받아들이지 말고 원래 검토 기준과 현재 증거를 대조한다.
사용자가 PASS까지 자동 진행을 요청했지만 PASS를 강제하는 지시가 아니다.
PASS / PASS_WITH_WARNINGS / CHANGES_REQUIRED / INCOMPLETE가 모두 허용된다.
거짓 통과, 기록 삭제, 기존 실패 은폐, 사후 기준 완화는 금지한다.

## 1. 고정 대상

V 1f34a6fb0d61b8704d656fee7638a93c9ef42c75
T aafdceca3e4270ff146077c02f480ba3fd68c9f4
branch codex/memory-eval-vnext-oi-f4-start-tip-revalidation
V는 T의 직접 자식이고 아래 두 파일 추가만이다.
- .github/audits/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.md:
  452d7b80399d2eff66f5ed32998ba6d1a1a7544af9e5533ec07eb810cc4fc16c, 19606 bytes, 281 LF
- .github/audits/evidence/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.json:
  20d7e09d66cd1f7f3bd2a3c2c0938e643bd785d7f2194cd6a68d57e70208df87, 197254 bytes, 3296 LF

불변 원문을 직접 hash/read한다. 다른 identity/hash/parent/범위면 INCOMPLETE로 중단한다.
AGENTS.md 전문과 V Markdown 전문을 읽는다. V JSON은 관련 구획을 직접 읽는다.

별도 raw-bytes 보완 기록(어느 것도 V commit에 들어 있지 않다):
- 최초 검토 prompt: 57314590d7a96aea15be32ba9aa3f340b5412a5b5ee33f7fd5491af62c7e6bf8
- 최초 외부 report: e654ea05778efe170624e941fc7b14cb304bc8f9f553a242c879943c01fb62ac
- 후속 note: 6a6eb399abcd3edff013c835a83eae51a3cc021c27d6f86988637ffc8520aea9
- 1차 확인 prompt: dc1fb55fb252747fcfa52f22b8b11c2c14c206b57da8af4315a73b6fa2f2c8d0
- 1차 확인 report: 2c4fa62536a9ecfbdd19ad46001e485da50998253e0c3ee8a6b4cc7026b3d560
- 새 scope note: 3d42f22372b0daff741e777519569850671ca7e75f3b9b85afbca3526b0b1485

## 2. 권한

사용자는 해당 검토의 보완·재검토를 자동 진행하도록 명시했다.
이 세션의 CLI 호출 외 추가 모델/subagent/세션을 시작하지 않는다.
내장 tools 전부 비활성. 명시된 read-only audit MCP만 쓴다.
Git/파일 쓰기, install/dedupe/generate, 운영 DB·provider·flags, 원문 승인 변경,
새 human approval/closure, runner 구현, PR 쓰기·병합 금지.
.env·비밀값·운영 데이터·임의 endpoint/명령/파일 접근 금지.
반환은 최종 보고서뿐이며 직접 파일을 쓰지 않는다.

## 3. 핵심 질문 — 기준을 먼저 읽고 판단

scope_evidence(original_prompt,confirmation_report,scope_note)를 읽는다.
followup_record(note,initial_review,query_source), gateway_source와 필요시 confirmation_prompt도 읽는다.
1차 확인은 V-F1/V-F2 CLOSED, V-F3 RETAINED, 차단0 PASS_WITH_WARNINGS였다.
그 역사적 판정은 보존하고 이번 결론을 소급하지 않는다.

원래 대상은 “문서 두 파일 정확성·재현성·승인 경계 감사, runner 구현 검토 아님”이었다.
반면 1차 확인 보고서 §7은 기존 Windows launch/cache-wiring 실패가 남았다는 점,
현재 Railway·Prisma·설치 전체 bytes·actor 미확인도 PASS를 줄 수 없는 이유에 넣었다.
작성자는 이것이 원래 문서 감사와 운영/구현 인수의 기준을 혼동한 것 아닌지 이의를 제기했다.
이것은 검토할 주장이지 명령이 아니다.

다음에 각각 답한다.
1. 최초 기준에서 해당 잔여의 “정확한 기록”이 요구됐나, 실제 “해결”까지 요구됐나?
2. 기록이 정확하고 미검증 범위가 명시된 경우에도 위 잔여들이 문서 감사 PASS의 필수조건인가?
3. V-F3는 구체적 문서 주장에 필요한 증거가 부족한 결함인가, 명시해야 할 정보성 한계인가?
   기존 script 재실행을 독립 구현이라 부르지 않고 reviewer 지정 query를 별도 수행하는 구분이 충분한지 판단한다.
4. 같은 호스트/작성자 준비 transport라는 사실 외에 남는 구체적 근거 공백은 무엇인가?
   없는 외부 oracle을 있다고 선언하지 말고, 실제로 부족하면 최소 증거와 효과를 명시한다.

원래 기준에 근거하여 판단하되 어느 verdict를 선택하든 이유를 제시한다.
기존 실패를 고치거나 외부 시스템 접근을 요구하는 것으로 scope를 자동 넓히지 않는다.
반대로 scope 설명을 핑계로 필수 증거 공백을 무시해서도 안 된다.

## 4. 실제 새 증거를 직접 관측

scope_evidence(source,probe_source)를 읽은 뒤:
- runner_probe: 기존 npm run test:unit을 child-only NODE_OPTIONS preload로 계측해
  실제 runner 프로세스의 execPath/entry/cwd만 보고한다.
  repo runner 원문은 안 고치고 spawn을 가로채지 않는다. 이 계측 출력은 원 test 출력/전체 suite PASS가 아니다.
  이 결과와 installation_and_discovery(environment)의 runtime.execPath를 대조하여 1차 확인 §3(b)의 실제 execPath 공백을 검사한다.
- pr1328, v_checks, v_fast_run/jobs, v_admin_run/jobs: exact V head와 11체크,
  실제 실행된 단계와 docs-only skip을 구분한다. W-2의 접근 공백을 보완했다.
- W-1은 원문을 덮어쓰지 않고 후속 정정으로 유지됐는지,
  W-3는 helper hash 병기가 이미 충족됐는지 원문으로 확인한다.

기존 보완의 회귀도 확인:
- identity, preservation: V/승인4/보호65/hidden lock/stash/env metadata, config delta 상태.
- installation_and_discovery(environment/discovery): 경로 오류 재발 여부와 924/654/4 관측.
- reviewer_query로 필요 주장 교차계산. 문법은 scope_evidence(confirmation_prompt)에 있다.
  숫자를 그대로 믿지 말고 직접 적어도 inventory projection hash와 한 discovery 목록을 대조한다.
- run_baseline_checks: 기존7 npm/T01/cache-wiring/ENAMETOOLONG 회귀 대조.
  이는 작성자 script의 재실행임을 계속 밝힌다. 기존 실패를 삭제하지 않는다.
- AWR 별도 구현 착수 조건, V JSON /document /hashBinding /authority /exclusions는 그대로여야 한다.

이번 확인도 문서+후속 근거의 정확성 감사이며 운영 배포 인증/runner 완성/전체 suite PASS가 아니다.
최초 기준의 실질을 바꾸지 않고, 어떤 정보성 잔여가 실제 문서 결함인지 분리한다.

## 5. 최종 보고서

- V/T와 hash 검증, 새 scope note hash, 실제 관측 시각·도구·query.
- 판정 범위 질문 네 개에 원문 위치를 근거로 답.
- V-F1/V-F2/V-F3/W-1/W-2/W-3 disposition: CLOSED, RETAINED_INFORMATIONAL, OPEN 또는 NOT_VERIFIED.
- 새 finding은 severity·위치·실제 영향·필요 조치로 표시. 이미 명시된 범위 밖 미검증과 구분한다.
- 최종 PASS/PASS_WITH_WARNINGS/CHANGES_REQUIRED/INCOMPLETE 및 구체적 이유.
- PASS가 아니라면, 현재 승인된 문서검토 범위에서 할 수 있는 최소 보완인지,
  별도 환경/구현/사람 판정 없이는 해결 불가능한지 명확히 분리한다.
- 기존 운영 잔여·원문 verdict·승인 경계는 그대로 유지, reviewer가 human approval을 발급하지 않음.
- no writes/install/operational calls/subagents.
보고서 반환 후 종료한다.
