# 생성 산출물 작업공간 — 전략·범위 검토

- 검토일: 2026-09-15
- 대상: 사용자 첨부 「생성 산출물을 작업 대상으로 — 결정 기록 v0.1」, 별칭 IDEA-A2.
- 결론: **수정 후 작업 후보로 채택.** 제한형 미리보기부터 분리하고, 계보·재입력·명세 기반
  수정·원문 대조는 각각의 권한/수명주기/비용 계약을 확인한 뒤 확장합니다.
- 상태: 자문 목록 등록. 제품 정책 승인, 구현 착수, 유료 평가, 운영 변경의 승인이 아닙니다.
- 목록: [통합 작업 목록 J](./tomverse-product-idea-backlog.md#j-생성-산출물-작업공간--idea-a2-초안-보정).

## 1. 조사 기준과 한계

코드 분석 전 작업 트리·브랜치·upstream을 확인하고 origin을 fetch했습니다. 기존 checkout은
미커밋 자료가 있는 detached HEAD여서 덮어쓰거나 자동 stash하지 않았습니다. 최신 develop의
별도 worktree에서 생성/조회/정리 코드와 관련 정책을 읽었습니다.

- develop: `3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6`
- main: `938816f2bcf56a2a289758f6bbb6353ee93ce1c6`
- 표적 비교에서 생성 도구·저장 서비스·다운로드 route·파일 카드·generated-artifacts 정책은
  두 브랜치 사이에 차이가 없습니다. 전체 Prisma schema에는 다른 변경이 있으므로 전체
  플랫폼/데이터 모델이 같다고 확대하지 않습니다.
- `smart-explore` 구조 검색은 최신 별도 폴더 접근 제한으로 사용할 수 없어 `rg`와 표적
  파일 읽기로 보완했습니다. 관련 두 정책(generated-artifacts, user-attachment-persistence)은 전문을 읽었습니다.
- production 배포/flag·사용량·실제 브라우저 미리보기·성능·과금 결과는 확인하지 않았습니다.
  “운영 중”이라는 초안 표현을 이 조사만으로 독립 확인한 사실로 바꾸지 않습니다.

## 2. 코드가 뒷받침하는 문제와 보정할 주장

| 초안의 주장 | 확인·판단 |
| --- | --- |
| 생성 파일은 다운로드 후 끝나고 다시 돌아올 수 없음 | 자동 재입력 경로가 없다는 문제는 맞습니다. 다만 기존 입력이 지원하는 형식은 수동 다운로드→재첨부가 가능하므로 절대적 불가로 설명하지 않습니다. |
| 버전 기능이 전혀 없음 | 정책 §9와 collector는 다른 명세를 새 파일로 만들고 같은 명세 재호출을 `unchanged`로 처리합니다. 없는 것은 turn을 넘는 계보·버전 선택·지속되는 명세/멱등성 식별입니다. |
| MessageArtifact에 명세/부모/버전 컬럼 없음 | schema에서 확인했습니다. 현재 메시지/대화/소유자와 ordinal, 형식·파일명·상태·모델·objectKey·createdAt 등을 저장합니다. |
| SVG 외 미리보기 없음 | 현재 GeneratedArtifactCard는 SVG만 안전한 img/Blob 방식으로 표시합니다. PDF·Office 관련 라이브러리가 설치되어 있다는 사실은 파일 카드 미리보기 구현을 뜻하지 않습니다. |
| 기존 도구/저장소 재사용 가능 | 생성·저장·다운로드·정리 primitive는 재사용 가능합니다. batch 입력은 서버의 요청별 첨부 map이며 생성 artifact를 직접 읽는 입력 계약은 없습니다. |
| 미리보기가 가장 싸고 ROI가 가장 큼 | 작은 텍스트 미리보기를 먼저 검토할 근거는 있으나, 사용량·이탈·PDF/Office 비용·실기기 결과를 측정하지 않아 최상 ROI/기간은 미확정입니다. |

주요 근거:
[MessageArtifact 모델](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/prisma/schema.prisma#L501),
[collector와 turn 내부 hash](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/generatedArtifactTool.ts#L356),
[SVG 카드](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/components/chat/GeneratedArtifactCard.tsx#L182),
[생성 정책 §9](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/docs/policy/generated-artifacts.md#L328).

## 3. D1~D6 검토 의견

### D1 — 형식·생성 엔진을 늘리지 않기: 채택, 입력 계약은 별도

새 형식, 임의 코드 실행, 범용 파일 라이브러리, 무제한 생성으로 확장하지 않는 방향은
타당합니다. 다만 “새 도구 없음”을 문자 그대로 금지하면 읽기/수정 입력 경로도 만들 수
없습니다. **새 생성 능력은 늘리지 않고, 필요한 읽기·수정 입력 스키마/서버 action은 별도
설계 가능**으로 고칩니다. 기존 실제 파일 생성 확인·엄격 명세·요청 형식·비공개 storage
정책을 유지하고, 모델의 “파일을 만들었다”는 문장을 성공 증거로 쓰지 않습니다.

### D2 — 미리보기: 우선 채택, PDF와 Office의 선행 조건 보정

- 첫 단위는 텍스트·코드·구조화 텍스트/표의 제한형 읽기 전용 표시입니다. HTML/XML/JS는
  소스로 보여주고 실행하지 않습니다. Markdown도 외부 이미지·폰트·URL 자동 요청을
  기본 차단하며 기존 renderer를 사용한다는 것만으로 이 조건이 충족됐다고 보지 않습니다.
- PDF는 기존 다운로드가 `Content-Disposition: attachment`이고, 초안은 object/iframe도
  금지하므로 “브라우저 내장 뷰어”만으로 구현 계약이 정해지지 않습니다. 안전한 정적 표시
  방식·페이지/메모리/시간 한도를 먼저 확인하고, PDF 세부 검증이 커지면 텍스트부터 내보냅니다.
- Office는 별도 P3입니다. 변환 작업의 격리·시간/메모리/동시성 한도, 외부 리소스 요청
  차단, 임시 파일·파생 이미지 삭제가 필요합니다. 원본 다운로드와 분리하고 근사 미리보기라는
  사실을 표시합니다. 저장된 파생 결과가 생기면 보존·export·삭제 정책도 검토합니다.
- 기존 GET은 다운로드 rate limit을 소비합니다. 모든 카드의 자동 미리보기와 다운로드가
  같은 파일을 중복 fetch하면 실제 다운로드를 막을 수 있으므로 명시적 열기/지연 로딩과
  제한된 동시성을 먼저 검토합니다. 권한을 넘는 공유 캐시·상한 상향으로 해결하지 않습니다.
- 요청자가 명시적으로 미리보기를 열었는데 실패하면 “미리보기 불가, 다운로드 가능”을
  안내합니다. 장식용 SVG의 조용한 실패를 전체 사용자 작업의 실패 표시로 복사하지 않습니다.
  잠금·권한 상실을 알게 되면 화면의 기존 내용/Blob도 정리하되 이미 전달된 파일을 회수할
  수 있다고 약속하지 않습니다.
- 결정론적 미리보기에 별도 사용자 크레딧을 부과하지 않는 방향을 권장합니다. 다만 회사의
  변환 원가는 0이 아니며 자동 유료 모델 fallback은 넣지 않습니다. 새 정책의 승인은 별개입니다.

근거: [다운로드 GET](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/app/api/artifacts/%5BartifactId%5D/route.ts#L48),
[카드의 다운로드/미리보기 fetch](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/components/chat/GeneratedArtifactCard.tsx#L150).

### D3 — 불변 버전: 채택, 상한 면제와 전체 계보 삭제는 미채택

부모/기준 artifact와 불변 새 행을 연결하고 `(messageId, ordinal)`을 유지하는 방향은
좋습니다. 초기에는 같은 사용자·같은 대화 안으로 제한하고, 특정 기준 버전을 선택하게
합니다. 동시 수정은 기준 버전 불일치를 알리거나 명시적인 분기로 처리하며 조용한 덮어쓰기는
하지 않습니다. 실패한 수정이 마지막 성공 버전을 가리거나 지워서도 안 됩니다.

그러나 현재 3개는 **한 turn의 top-level 작업/출력 상한**이고 평생 수정 횟수 상한이 아닙니다.
새 turn은 다시 생성할 수 있으므로 “버전을 세면 3번 수정 뒤 막힘”이라는 전제는 성립하지
않습니다. 버전 수를 논리적 파일 개수와 구분하는 것은 가능하지만, 모든 재생성을 실행 상한에서
빼는 것은 무제한 반복의 통로가 됩니다. MVP에서는 현재 상한을 유지하고 별도 예산이 필요할
때만 정책 승인을 요청합니다. 기존 collector는 성공·실패 기록을 모두 상한 판단에 포함합니다.

이미지 Target/Generation은 논리 단위와 attempt 분리의 참고일 뿐 그대로 복사할 계약이
아닙니다. Generation의 실행 상태는 저장됩니다. “모든 상태를 유도한다”로 일반화하지 않습니다.

삭제 역시 “어느 버전이든 삭제하면 전체 계보 삭제”를 기본값으로 정하지 않습니다. 현재
모델별 이력 초기화는 해당 assistant 메시지의 파일만 정리합니다. 다른 모델의 파생 버전까지
연쇄 삭제하면 기존 삭제 범위를 넓혀 데이터가 소실될 수 있습니다. 개별 버전·전체 계보·
모델 이력·대화/계정 삭제의 의미를 구분한 뒤 object별 tombstone을 재사용해야 합니다.

근거: [turn 상한](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/generatedArtifactTool.ts#L627),
[정책 §13의 상한 의미](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/docs/policy/generated-artifacts.md#L531),
[모델 메시지별 정리](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/generatedArtifactStorage.ts#L284).

### D4 — 요청별 불투명 handle: 채택, 권한 자체와 구분

art_1은 모델에게 storage key/URL/경로를 주지 않는 서버 map의 참조로 사용합니다.
handle을 안다는 사실만으로 읽기를 허용하지 않고, 주체·대화·요청·특정 artifact 버전·허용
작업에 결속해야 합니다. 기존 읽기 권한·잠금·준비 완료 상태와 삭제 여부도 확인합니다.
읽어 온 생성물은 신뢰하지 않는 자료이며 내부 명령/권한 지시로 승격하지 않습니다.

“모든 오류 404, 잠금만 423”는 현재 API의 정확한 설명이 아닙니다. 로그인 401, rate limit,
서버 장애 응답은 별도로 존재합니다. **비소유자에게 리소스 존재를 숨기고 소유권 확인 후
잠금을 안내**하는 정보 노출 원칙을 유지하되 모든 오류를 무조건 404로 바꾸지 않습니다.

### D5 — 검증 명세 영속화: 별도 승인 유지, 명세만으로 재현은 불충분

부분 수정을 위해 검증된 명세를 저장하는 방향은 합리적이지만, schema/renderer 버전과
정규화·출처를 함께 설계해야 합니다. batch는 명세 외에 실제 템플릿·데이터 bytes를 읽으며
att_1 같은 요청별 handle은 다음 요청에 재사용할 수 없습니다. 입력의 안정적인 버전 식별,
hash·권한·삭제 후 가용성 또는 별도 승인된 입력 snapshot이 필요합니다. 이를 결정하지 않고
원문을 몰래 복제하거나 입력이 삭제된 뒤에도 완전 재현 가능하다고 약속하지 않습니다.

승인 범위는 명세 내용, 사용자 원문/개인정보, 로그 배제, 통합 export, 계정/대화/모델 이력
삭제, retention입니다. **domain registry 검토는 D5에만 필요한 것이 아닙니다.** B의 계보,
저장형 미리보기와 D의 출처 연결도 데이터 추가 여부에 따라 검토해야 합니다.

현재 통합 계정 export는 MessageArtifact의 메타데이터를 내보내며 파일 bytes와 objectKey는
포함하지 않습니다. 따라서 “export에 이미 포함”이라는 문구로 새 명세/바이너리 범위까지
승인됐다고 보지 않습니다. 명세가 없는 과거 산출물은 미리보기/재입력 가능 범위만 제공하고
추정한 명세를 원래 명세처럼 백필하지 않습니다. 부분 수정의 결과도 D3대로 새 버전입니다.

근거: [batch 명세와 첨부 map](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/generatedArtifactTool.ts#L759),
[batch rendering 입력](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/generatedArtifactTool.ts#L818),
[계정 export의 artifact 범위](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/accountDataExport.ts#L746).

### D6 — 생성물과 원문 대조: 채택, 의미와 Agent 의존성 보정

1. **인용 일치**: 지정한 원문에서 해당 인용 문자열이 확인되는지 검사합니다. 기존
   exactQuoteMatchRate와 연결 가능한 범주이며 사실성·누락 없는 전체 검토를 뜻하지 않습니다.
2. **주장 지지 여부**: 인용이 주장에 적절한 근거인지 별도로 판단합니다. 의미적 평가와
   과장/모순/근거 부족 시료가 필요하며 문자열 일치율을 이 평가 점수로 재사용하지 않습니다.

원문·산출물의 버전과 인용 위치를 고정해야 재검토가 가능합니다. 파싱 실패, OCR 부재,
삭제/잠금, 원문 자체 없음은 평가 불가/범위 제한으로 나타내고 0점·검증 완료로 꾸미지 않습니다.
대화에서 생성한 문서라면 사용자가 지정한 메시지를 출처로 삼을 수 있지만 AI 답변은 독립적인
사실 증거가 아닙니다. 외부 문서·사용자 진술·AI 생성물을 구분합니다.

작은 인용 대조 또는 승인된 단일 의미 검토는 범용 Agent 없이도 설계할 수 있습니다.
REVIEW-AGENT-01은 여러 항목을 장기 실행·재접속·재개할 때 연결하는 선택적 기반이며,
전체 Agent가 끝날 때까지 모든 원문 대조를 막는 의존성은 제거합니다. 기존 Review는
다중 답변 비교이므로 단일 산출물 검사를 그 API에 억지로 끼워 넣지도 않습니다.

근거: [exactQuoteMatchRate의 명시적 의미](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/sourceGrounding.ts#L1).

## 4. Agent·기존 Artifacts와의 경계

- CHAT-ART-01은 기존 생성/카드/다운로드를 Auto Chat에 통합하는 작업으로 유지합니다.
  IDEA-A2의 계보·Office 렌더링·명세 저장을 Chat GA의 새로운 선행 조건으로 추가하지 않습니다.
- “버전 1개 = Agent 청구 단위 1개”는 자동 성립하지 않습니다. 현 정책 §11은 일반 파일
  생성에 별도 크레딧을 매기지 않고 Chat 과금을 따릅니다. 파일 버전은 결과를 식별하는
  방식이고, 청구 단위는 사전에 승인된 이용 가능한 결과의 정의입니다.
- 유료 Agent 작업에서 제공하는 산출물이라면 CREDIT-CAP-01/AGENT-BILL-01과 연결해
  완료·저장·취소 경합, 재개 시 재과금 금지, 실패 원가를 검증합니다. 일반 Chat 과금과
  별도 Agent 가격을 같은 실행에 중복 부과하지 않습니다.
- 현재 collector는 assistant 메시지와 artifact 행을 함께 저장하며 미저장 종료 경로에서
  파일을 정리합니다. background Agent가 브라우저 연결 종료와 무관하게 결과를 보존하려면
  이 수명주기를 별도로 설계해야 합니다. 기존 스트림 collector를 그대로 감싸는 것으로
  durable task 결과가 완성되지는 않습니다.
- 공개 공유·검색 색인·Memory 주입은 이번 제안에 포함하지 않습니다. 기존 공유에서
  생성 파일을 제외하는 정책을 미리보기나 출처 연결로 우회하지 않습니다.

근거: [수명주기](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/docs/policy/generated-artifacts.md#L294),
[별도 파일 크레딧 없음](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/docs/policy/generated-artifacts.md#L503),
[앞선 Agent 과금 검토](./tomverse-agent-partial-billing-review-2026-09-15.md).

## 5. 목록상 순위와 완료 확인

등록 순서는 **ART-PREVIEW-01(P2) → ART-VERSION-01(P2)**입니다. 이후
ART-PREVIEW-02(Office), ART-EDIT-01(D5 승인 조건), ART-GROUND-01은 각 P3로 분리합니다.
Office 미리보기는 계보 완료를 반드시 기다리는 직렬 의존성이 아니며, 텍스트/기존 파일의
직접 재입력도 Memory나 Review Agent 활성화가 필요하지 않습니다.

기존 안전 대응·이어가기 문맥·Chat 핵심 품질의 P1보다 앞당길 실측 근거는 아직 없습니다.
제한형 미리보기는 기존 카드 통합과 작게 병행할 수 있지만, 같은 파일을 두 작업이 동시에
고치거나 새 플랫폼 전체를 만들어야 기존 통합이 끝나는 구조는 피합니다.

향후 착수 시 검증 후보는 아래 **8개 구획, 합성/무과금 검증부터**입니다. 이번에는 실행하지
않았습니다. 차단 범위는 정보 유출·데이터 소실 등 복구 불가 경계이며, UI/충실도/성능의
개별 지원 범위는 측정 후 정합니다. 실제 모델 호출은 판별할 항목·횟수·예산을 따로 승인받습니다.

1. **권한·삭제**: 비소유자, 타 대화/버전 handle, 만료 요청, 잠금·삭제 경합에서 정보가 새지 않음.
2. **미리보기 격리**: 악성 HTML/XML/Markdown/SVG/PDF·외부 리소스 시료가 실행/외부 요청을 만들지 않음.
3. **자원·복구**: 한도 초과/파싱 실패/모바일 메모리/동시 fetch·rate limit에서 다운로드·재시도 경로 유지.
4. **계보·동시성**: 두 수정의 충돌, retry 중복, 마지막 성공 버전 유지, 기존 turn 상한 유지.
5. **데이터 수명주기**: 모델 이력 초기화·단일 버전·전체 계보·대화/계정 삭제와 파생 preview/spec/object 정리.
6. **명세 재생성**: D5 승인 후 renderer/schema/입력 버전, 과거 명세 없는 파일, 삭제된 입력을 정직하게 처리.
7. **근거 의미**: 정확한 인용이나 잘못된 주장, 근거 부족/상충, 원문 부재/버전 변경을 서로 구분.
8. **과금 경계**: 일반 Chat/무모델 미리보기/유료 Agent를 구분하고 완료·재개·저장 실패의 중복 청구 방지.

시료·정답지·집계/기록 초안은 에이전트가 준비합니다. 사용자가 할 일은 필요한 실기기
관측, 승인된 유료 결과 판단, 최종 정책 선택과 서명으로 한정합니다.

이번 변경은 자문 Markdown 두 파일뿐입니다. 제품 코드·정식 정책·DB·운영 flag는 변경하지
않았고, commit/push·유료 호출도 하지 않았습니다.
