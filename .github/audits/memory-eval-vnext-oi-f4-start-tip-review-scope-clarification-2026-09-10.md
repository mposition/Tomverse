# OI-F4 V — 판정 범위 명확화와 추가 관측

작성자 Codex, 2026-09-10. 작성자 의견·관측이며 외부 판정 또는 사람 승인이 아니다.
V=1f34a6fb0d61b8704d656fee7638a93c9ef42c75, T=aafdceca3e4270ff146077c02f480ba3fd68c9f4.
V와 최초 보고서, 후속 note, 1차 확인 보고서는 모두 원 bytes로 보존한다.

## 1. 이미 나온 확인 결과를 보존

1차 확인 보고서 raw SHA:
2c4fa62536a9ecfbdd19ad46001e485da50998253e0c3ee8a6b4cc7026b3d560.
판정은 PASS_WITH_WARNINGS이며 V-F1/V-F2 CLOSED, V-F3 RETAINED다.
이 기록은 그 판정을 바꾸지 않는다. 새 판단은 별도 reviewer 응답으로만 기록한다.

## 2. 작성자의 판정 범위 이의 — 원래 기준을 대조할 질문

최초 검토 프롬프트 raw SHA:
57314590d7a96aea15be32ba9aa3f340b5412a5b5ee33f7fd5491af62c7e6bf8.
그 도입부는 “문서 두 파일의 정확성·재현성·승인 경계 감사이며 runner 구현 검토가 아니다”라고 정했다.
원래 §4.7은 기존 ENAMETOOLONG/cache-wiring 실패를 정확히 구분할 것을 요구했고,
§4.9는 Railway 현재/production 상태를 직접 재조회했다고 쓰지 말도록 했다.
§4.10은 config actor 및 전체 bytes 보존을 과장하지 않도록 했으며,
§4.12는 V가 전체 unit PASS·OI-F4 closure가 아님을 점검하도록 했다.

따라서 1차 확인 §7이 “기존 Windows launch 실패와 cache-wiring 1건 실패가 남아 있기 때문”에
문서 감사 PASS를 줄 수 없다고 한 부분은 원래 검토 대상과 혼동 가능성이 있다고 본다.
이는 작성자 이의이며 reviewer가 원래 지시·V 본문에 비추어 판단해야 한다.
기존 실패를 숨기거나 허용 테스트를 줄이거나 원문 판정 조건을 바꾸자는 제안이 아니다.
해당 실패를 고치거나 운영 검증을 추가할 권한도 이 기록으로 열지 않는다.

V-F3의 새 reviewer 지정 query는 두 번째 수집/계산 경로를 제공했으나 모든 transport/tool은 작성자가 준비했다.
이 한계를 명시한 채 재현성·정확성 감사를 수행할 수 있는지, 아니면 실제 근거 공백이 남는지가 질문이다.
외부 하드웨어 oracle 또는 독립 JavaScript sandbox가 있다고 주장하지 않는다.
PASS_WITH_WARNINGS를 유지한다면 구체적으로 어느 문서 주장이 어떤 필수 증거 없이 남는지 설명을 요청한다.

## 3. 실제 추가한 관측 경로

- PR #1328의 정확한 V head/check-runs/Fast Gate·Admin run/jobs를 GET으로 직접 읽는 고정 endpoint만 추가했다.
  2026-09-10T09:26:43Z 이후 작성자 self-check에서 head=V, draft=true, autoMerge=null, 11 completed/success를 관측했다.
  UI/smoke의 docs-only skip과 실제 unit/server/Admin E2E 실행은 job steps로 구분한다.
  이는 W-2의 접근 제한을 보완한다. reviewer가 직접 호출하기 전 외부 확인으로 부르지 않는다.
- runner execPath 관측은 npm run test:unit에 child-only NODE_OPTIONS preload를 붙인 별도 진단이다.
  temp preload는 원 runner 진입 시 process.execPath/argv[1]/cwd만 출력한다.
  2026-09-10T09:26:43.520Z 실제 runner 프로세스가 C:\nvm4w\nodejs\node.exe,
  H:\Project\ai-chat-hub\scripts\run-unit-tests.mjs,
  H:\Project\ai-chat-hub을 보고했다. query runtime execPath와 일치했다.
  exit1이며 이것은 계측 없는 원 시험 출력 또는 suite PASS가 아니다.
  spawn을 가로채지 않았고 runner raw SHA e6af763f362e6a31a838d7e5fc9a7c7d5dbbe42d8bceede1da6c9fba24986e76은 전후 동일했다.
  부모 환경·저장소·설치에는 쓰지 않았고 임시 child 환경만 사용했다.

## 4. 그대로인 범위

runner 구현, 전체 Windows suite PASS, 현재 배포 인증, actor 귀속, 전 설치 파일 integrity,
Prisma/운영 DB, OI-F4 closure, S2 activation, 새 승인·병합은 이번 대상이 아니다.
기존 미검증 항목과 잔여는 그대로 표시한다.
1차 확인의 W-1 정정과 W-3 helper hash 병기는 이미 후속 기록에 존재하며 최초 원문을 덮어쓰지 않는다.
이번 별도 확인도 원하는 판정 유도가 아니라 남은 정보성 경고의 대상·근거·효과를 명확히 하는 것이다.
