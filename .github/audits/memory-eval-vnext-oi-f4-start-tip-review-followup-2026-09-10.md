# OI-F4 재검증 V — 최초 검토 경고에 대한 후속 근거

작성자 Codex, 2026-09-10. 상태: 작성자 후속 관측 / 외부 확인 전.
대상 V: 1f34a6fb0d61b8704d656fee7638a93c9ef42c75.
parent T: aafdceca3e4270ff146077c02f480ba3fd68c9f4.
이 파일은 V의 일부가 아니며 raw SHA-256으로 별도 고정하는 후속 기록이다.
V의 두 원문, 기존 승인, 최초 Claude 보고서는 수정하지 않는다.

## 1. 대상과 후속 실행 권한

사용자 후속 지시: “해당 부분 독립 검토 pass 될때까지 자동으로 진행해주세요.”
이는 해당 검토의 증거·도구 보완과 재검토 실행에 대한 지시다.
최초 1회 승인과 구분하며, 이번 후속 검토를 최초 승인으로 소급 정당화하지 않는다.
구현·새 사람 승인·원문 승인 범위 변경·dataset/register/flag·운영 DB·기능 activation·병합 권한은 열지 않는다.
PASS는 reviewer가 근거에 따라 정한다. 경고를 숨기거나 요구조건을 낮춰 판정을 바꾸는 지시가 아니다.

| 고정 대상 | raw SHA-256 |
|---|---|
| V Markdown: .github/audits/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.md | 452d7b80399d2eff66f5ed32998ba6d1a1a7544af9e5533ec07eb810cc4fc16c |
| V evidence: .github/audits/evidence/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.json | 20d7e09d66cd1f7f3bd2a3c2c0938e643bd785d7f2194cd6a68d57e70208df87 |
| 최초 Claude 보고서: .github/audits/memory-eval-vnext-oi-f4-start-tip-independent-review-2026-09-10.md | e654ea05778efe170624e941fc7b14cb304bc8f9f553a242c879943c01fb62ac |
| 최초 실행·작성자 후속 관측: .github/audits/evidence/memory-eval-vnext-oi-f4-start-tip-review-execution-2026-09-10.json | b9de45050981e9391ce30ea15caa59a13624e57faf3b5894d33f325b7e712d5a |

최초 보고서는 PASS_WITH_WARNINGS, P0/P1/P2 0, P3 V-F1/V-F2/V-F3 3건이다.
최초 미검증 항목과 당시 도구 오류는 역사적 사실로 남긴다. 이 기록 자체는 CONFIRMED가 아니다.

## 2. V-F1 — 시점별 Git config 차이

최초 리뷰의 config SHA 011874ca...는 당시 사실이다.
작성자의 사후 관측에서는 codex/to-main/fix-admin-session-loop의 완전한 추적 section 한 개를
메모리 내 제거하면 0978548a...가 재현됐다. 따라서 최초 reviewer의 “V branch 발행 때문일 가능성”은
확인된 원인이 아니며 실제 해시 대조는 다른 branch section을 지목한다. 원 보고서의 추측 문구를 고치지 않았다.

이번 후속 시작의 config SHA는
25bb2a4abe6f336420897bdd37fe09ab102a575154566813fa4548845d008496,
mtime은 2026-09-10T08:59:27.661Z다.
앞서 관측된 두 branch의 merge 값이 각각 refs/heads/develop, refs/heads/main에서
refs/heads/codex/to-develop/fix-admin-session-loop,
refs/heads/codex/to-main/fix-admin-session-loop로 바뀌었다.

현재 bytes에서 이 두 merge 값만 **메모리 안에서** 과거 값으로 투영한 다음
아래처럼 완전한 section을 제외하면 해시가 순서대로 재현된다.
실제 config 파일을 수정·복구·정규화한 것이 아니다.

| 메모리 내 투영 | 결과 SHA-256 |
|---|---|
| 두 merge 값만 과거 값으로 투영 | 011874ca2449ef7a060ce8a71bf9d094b084bc8c7c22c39bc3992ca2c644f833 |
| 위 + to-main/fix-admin-session-loop section 제외 | 0978548a8b1ee007337690681fd3cdff6fece55f77ae64ef868282f984eb1b5e |
| 위 + to-develop/fix-admin-session-loop section 제외 | e3cab8eb198a28363829059b3e86a476964d1c6610bb738913c88abefd1d5bf5 |
| 위 + router-collector-cache-observation-fix section 제외 | 74daa3336def61337c3b7bd4f06d9c35051660ef8111ae5f292e04383bd8bbb4 |

이름은 모두 codex/ 접두사를 포함한다. 2026-09-10T09:11:03Z 이후 도구 self-check에서 재현했다.
config_projection 도구는 위 정확한 세 section의 비밀값 없는 remote=origin/merge=refs/heads/...와
현재 raw hash·mtime 및 reviewer가 지정한 메모리 내 투영 결과를 반환한다.
다른 config 내용이나 자격증명은 반환하지 않는다.
변경 주체는 여전히 모른다. config 전체 bytes 보존 PASS나 변경 승인을 주장하지 않는다.
더 오래된 4b07f53f...→74daa333...의 provenance 예외는 그대로다.

## 3. V-F2 — 검토 도구 경로와 누락 측정 보완

최초 gateway의 environment helper는 저장소 밖 temp에 있었다.
require('js-yaml')은 helper 위치에서 module을 찾았으므로 MODULE_NOT_FOUND였다.
기존 저장소의 node_modules/js-yaml을 명시적으로 해석하도록 temp helper만 고쳤다.
저장소 package/lock/node_modules는 수정하거나 재설치하지 않았다.

동일 V tree에서 2026-09-10T09:11:03.506Z 새 self-check 관측:
- metadata 924, workspace directory/link 3/3.
- required missing/version mismatch/hidden mismatch 각각 0.
- optional 미설치 175, 그중 OS/CPU 제외 164.
- inventory SHA da51cfba9083e21086a94af80ee00e3278c228e1b3775b1f4972f15b43ea181a.
- server/client 654/4, Git/working 순서 일치.
- naiveQuotedUtf16IncludingNull 41014, conservativeCost 80043.
- 기존 js-yaml 버전 4.3.2, npm ls exit0와 기존 optional extraneous 2건 유지.

이는 작성자의 재관측이다. 이번 Claude가 도구를 직접 호출하여 다시 관측해야 외부 확인이라고 부를 수 있다.
설치 metadata/graph 일치이지 전체 설치 파일 integrity, Prisma 생성물, 앱/운영 readiness를 증명하지 않는다.

## 4. V-F3 — 재실행과 reviewer 지정 교차계산의 구분

installation_and_discovery와 run_baseline_checks는 여전히 **작성자 제공 스크립트 재실행**이다.
이를 reviewer가 독립 구현한 oracle이라고 표현하지 않는다. 최초 검토의 방법론 한계를 소급 지우지 않는다.

추가한 reviewer_query는 환경 스크립트를 호출하지 않는 별도 raw-data 조회 도구다.
package-lock의 원 순서 항목·실제 package.json의 version/raw SHA·hidden lock version,
working 디렉터리 이름·Git tree 경로 및 runtime metadata만 읽는다.
필터, projection, 정렬과 산식은 reviewer가 선언형 JSON query로 지정한다.
도구는 그 query 그대로와 count/JSON SHA/문자열 목록 LF SHA/숫자 합을 반환한다.
작성자 계산식을 그대로 재사용하지 않고 같은 주장을 다른 조회 경로로 대조할 수 있다.

이것도 Codex가 만든 도구이며 별도 외부 하드웨어 oracle·임의 코드 sandbox가 아니다.
도구 소스를 공개한다. evaluator는 한정된 JSON 연산만 해석하고 eval/new Function/임의 script/명령을 실행하지 않는다.
reviewer는 직접 query를 작성하고, raw 항목과 산식 및 결과를 읽어 증거의 충분성을 판단한다.
도구와 원문이 제공하지 않는 사실은 미검증으로 남긴다.

## 5. 유지되는 경계

V가 보존한 과거 Railway staging snapshot은 현재 active/production 상태가 아니다.
이번 확인은 V-F1–V-F3 보완과 회귀 확인이지 현재 배포의 새 인증이 아니다.
현재 원격 develop을 T로 바꾸거나 다른 tip의 CI를 T 증거로 쓰지 않는다.
PR #1328의 11체크 성공은 별도의 V CI 관측이며 Windows 전체 test:unit 성공이 아니다.

기존 ENAMETOOLONG 및 cache-wiring 이름별 실패, 별도 구현 착수 지시,
R01–R03 범위와 이후 구현 검토/사람 수용 조건은 변하지 않는다.
새 source/test/fixture, 승인 receipt, dataset/register/purpose, flags를 작성·변경하지 않는다.
후속 검토 결과는 새 보고서로 보존하며 최초 보고서와 모든 승인 bytes는 유지한다.
