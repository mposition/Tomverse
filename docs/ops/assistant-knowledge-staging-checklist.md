# Assistant knowledge staging 검증 체크리스트

`feature.assistantKnowledgeEnabled`를 켜기 전에 staging에서 확인할 항목입니다.
정책 근거는 `docs/policy/external-conversation-import-and-memory.md` §14(지식
파일), §14.1(quota 수치), §14.2(보존·R2 lifecycle), §15.1(활성화 순서)입니다.

§15.1이 이 flag를 **4번**으로 정해 뒀습니다. 3번(`assistantProfilesEnabled`)이
켜져 있어야 이 회차가 성립합니다 — `isAssistantKnowledgeEnabled()`는 두 flag의
**AND**이기 때문입니다(`lib/appSettings.ts`).

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 체크박스는 항상 비어 있고, 그것이 이 파일의
성질입니다. 실행 결과는 **날짜와 전체 deploy SHA로 이름 붙인 별도 파일**로
`assistant-knowledge-staging-verification-records/` 아래에 남습니다.

- **template revision**: `2026-08-22` — 항목이 바뀌면 이 값을 올리고, 실행
  기록은 자기가 실행된 revision을 적습니다. 그래야 나중에 추가된 항목이
  "건너뛴 것"이 아니라 "그때 없던 것"으로 읽힙니다.
- 실행 방법과 파일 이름 규칙:
  `assistant-knowledge-staging-verification-records/README.md`

## 무엇이 되돌릴 수 없는가

앞선 회차들과 다릅니다. 이미지 생성에서는 **돈**이었고 assistant profile에서는
**대화 상태**였습니다. 여기서 되돌릴 수 없는 것은 **파일 내용의 유출과
소실**입니다.

**유출.** knowledge chunk는 사용자가 올린 파일의 원문이고, retrieval이 고른
excerpt는 그대로 prompt에 실려 provider로 나갑니다. 소유자가 아닌 계정의
chunk가 **한 번이라도** prompt에 들어가면 회수가 성립하지 않습니다. 좁히는
장치는 두 개뿐입니다 — `AssistantKnowledgeChunk.userId` 컬럼과 version
manifest의 `fileIds`(`lib/assistantKnowledgeRetrieval.ts`). 둘 중 하나가
뚫리면 남의 파일이 답에 인용됩니다.

**소실.** 삭제는 DB-first입니다. 행이 사라지고 같은 transaction에서 object
key가 tombstone이 되며, 그 뒤에 sweep이 bytes를 지웁니다
(`lib/assistantKnowledgeLifecycle.ts`). 이 순서가 뒤집히면 chunk가 가리키는
bytes가 먼저 사라지고, **원본은 사용자 로컬에만 있으므로 복원할 수 없습니다.**

반대 방향은 되돌릴 수 있습니다. tombstone이 쌓이지 않아 R2에 orphan이 남는
것은 저장 비용이고, sweep을 다시 돌리면 됩니다. 그래서 이 회차의 차단 기준은
**"지워졌어야 할 것이 남았는가"가 아니라 "남아 있어야 할 것이 지워졌는가"**
입니다.

**계정 삭제 약속.** 계정을 지운 뒤 knowledge object가 남으면, 그 시점 이후로는
"지웠다"고 말할 수 없게 됩니다. 사후에 고칠 수 있는 종류의 실수가 아닙니다.

## 무엇이 flag를 막고, 무엇이 막지 않는가

**27개 항목이 전부 릴리스 차단 사유는 아닙니다.** 기준은 앞 문서들과 같습니다 —
**되돌릴 수 있는가.**

### 차단 (flag를 켜기 전에 반드시)

| 구획 | 왜 차단인가 |
|---|---|
| **A** Fail-closed | flag가 실제로 막는지 모르면 켜는 행위 자체가 무의미하다. 0크레딧 |
| **B** 소유권 격리 | 남의 chunk가 prompt에 한 번 들어가면 유출이고, 유출은 회수되지 않는다 |
| **C** 삭제 순서 | DB-first가 뒤집히면 chunk가 가리키는 bytes가 먼저 사라진다. 원본은 사용자에게만 있다 |
| **D-1·D-2** Prompt 경계 | 파일 원문이 prompt에 들어간다. 경계가 뚫리면 지시문 주입이고 그 결과도 회수되지 않는다 |
| **F** 계정 삭제·export | 계정을 지운 뒤 object가 남으면 삭제 약속을 되돌릴 수 없다 |
| **G** 관측 | flag를 콘솔로 켰다는 증거(`AdminAuditLog` 해시 체인)가 남아야 한다. 0크레딧 |

**합계: A 5 + B 4 + C 5 + D-1·D-2 2 + F 3 + G 2 = 21항목, 유료 turn 5건.**

### 차단 아님 (켠 뒤에 고쳐도 되는 것)

| 구획 | 왜 아닌가 |
|---|---|
| **D-3** | `knowledgeHash`·chunk 수 계상의 정확성. 관측이 틀리면 고쳐서 배포하면 된다 |
| **E** Quota | 전부 되돌릴 수 있다. 과하게 막으면 사용자가 못 올릴 뿐이고, 덜 막으면 저장 비용이며 sweep이 있다. **무엇도 파괴하지 않는다** |

**차단 아닌 항목은 `미기록`으로 남기고 서명해도 됩니다.** 판정란에 어느 구획을
왜 건너뛰었는지 적으면, 그 기록은 비어 있는 것이 아니라 **범위를 밝힌** 것이
됩니다.

### 이 갈래를 바꾸려면

항목을 차단으로 올리는 근거는 **되돌릴 수 없음**입니다. "중요해 보인다"는
근거가 아닙니다. 새 항목을 차단에 넣을 때는 무엇이 복구 불가인지 한 줄로
적으십시오. 적을 수 없으면 차단이 아닙니다.

## 비용

**이 회차는 앞선 두 회차보다 쌉니다.** knowledge 처리에는 **provider 호출도
embedding도 없습니다** — chunking은 순수 lexical이고
(`lib/assistantKnowledgeChunking.ts`: "there are no embeddings"), 정책 §11이
외부 embedding provider 호출을 금지합니다. 그래서 **업로드·추출·삭제·sweep은
전부 0크레딧**입니다.

유료인 것은 retrieval이 실제로 prompt에 닿는지 보는 chat turn뿐입니다.

| 구획 | 유료 turn | 무엇을 판별하는가 |
|---|---|---|
| A | 0 | flag가 꺼진 상태의 거절. 켜고 나면 다시 만들기 어렵습니다 |
| B | 3 | 계정 2개 · profile 2개의 교차. 남의 파일이 인용되는지 |
| C | 0 | 업로드·삭제·sweep. 크레딧이 들지 않습니다 |
| D | 2 | 파일 원문이 경계를 넘는지, 적대적 지시문이 통하는지 |
| E | 0 | 거절 응답만 봅니다 |
| F | 0 | 삭제·export·registry |
| G | 0 | 관측만 |

기본 모델(`gpt-5-6-luna`) Standard 기준 turn당 1크레딧이므로 **합계 5크레딧**
입니다. 프롬프트는 짧게 씁니다 — 판별 대상은 답의 품질이 아니라 경계입니다.

**§B·§D는 답 내용을 읽어야 하므로 모델을 바꾸지 않습니다.**

## 사전 조건

실행 전에 확인합니다. 하나라도 어긋나면 검증이 아니라 **다른 것을 측정**하게
됩니다.

- staging이 서비스 중인 전체 40자리 deploy SHA를 `GET /api/build-info`에서
  읽어 기록에 적었다. git에서 추측하지 않는다
- 그 SHA가 production이 서비스 중인 SHA와 같다. **다르다면 SHA를 대조하지 말고
  `git diff <staging> <production> -- lib/assistantKnowledge*.ts
  'app/api/assistant-profiles/**'`로 표면이 동일함을 확인하고 그 결과를 기록에
  적는다.** main으로 가는 릴리스가 squash되므로 RC SHA가 production 이력에
  나타나지 않는 것은 정상이다
- `feature.assistantProfilesEnabled`가 **켜져 있다.** 꺼져 있으면
  `isAssistantKnowledgeEnabled()`의 AND 때문에 이 회차 전체가 §A만 측정한다
- `feature.assistantKnowledgeEnabled`가 **아직 꺼져 있다** — §A를 먼저 실행합니다
- `feature.memoryInjectionEnabled`가 꺼져 있다. knowledge와 memory는 별개
  경로이고, 켜져 있으면 prompt에 무엇이 들어갔는지 귀속할 수 없다
- 로그인 계정 **2개**를 준비했다. §B는 계정 하나로 판별할 수 없다
- staging의 R2 bucket과 자격증명이 production과 분리돼 있음을 확인했다
- **크레딧이 실제로 차감됩니다.** 위 비용 표 참조

## A. Fail-closed (flag off)

`assistantKnowledgeEnabled`가 꺼진 상태에서 실행합니다. 켠 뒤에는 이 상태를
다시 만들기 어렵습니다.

- [ ] A-1. `POST /api/assistant-profiles/<id>/knowledge` (`action: "prepare"`)가
      403 `ASSISTANT_KNOWLEDGE_DISABLED`
- [ ] A-2. 같은 상태에서 `GET /api/assistant-profiles/<id>/knowledge`도 403
- [ ] A-3. `DELETE /api/assistant-profiles/<id>/knowledge/<fileId>`도 403
- [ ] A-4. 이 상태의 chat turn에서 `knowledgeChunkCount`가 0이고
      `knowledgeHash`가 `"none"`. profile은 켜져 있으므로 instructions는
      들어가고 knowledge만 빠진다
- [ ] A-5. **역방향.** `assistantProfilesEnabled`를 잠시 끄면 knowledge가
      켜져 있어도 위 경로가 전부 닫힌다. AND가 한 방향으로만 걸려 있지 않다

## B. 소유권 격리 (핵심 계약, 유료 3턴)

이 회차에서 유일하게 회수 불가인 실패가 여기서 나옵니다.

- [ ] B-1. 계정 1의 profile로 대화 → 인용된 excerpt가 **계정 1의 파일에서만**
      나온다. 계정 2의 파일명·내용이 답 어디에도 없다
- [ ] B-2. 계정 2의 `fileId`를 계정 1의 profile version manifest에 넣으려는
      시도가 거부되거나, 저장되더라도 retrieval이 무시한다
      (`retrieveKnowledgeContext`가 `userId` 컬럼으로 좁힌다)
- [ ] B-3. **같은 계정 안에서도** manifest 밖의 파일은 들어오지 않는다.
      profile X의 대화에 profile Y의 파일이 인용되지 않는다
- [ ] B-4. `processingStatus`가 `ready`가 아닌 파일(`pending`·`failed`)의
      chunk가 prompt에 들어가지 않는다

## C. 삭제 순서와 소실 (차단, 0크레딧)

- [ ] C-1. 파일 삭제 직후 `AssistantKnowledgeChunk` 행이 사라지고
      `AssistantKnowledgeCleanup`에 tombstone이 **같은 transaction에서** 생긴다
- [ ] C-2. sweep 전에는 R2 object가 아직 남아 있다 (DB-first가 지켜진다)
- [ ] C-3. sweep 후 R2 object가 사라지고 tombstone이 완료 처리된다
- [ ] C-4. profile 삭제가 그 profile의 파일 전부에 tombstone을 남긴다
- [ ] C-5. 삭제된 파일이 **과거 version의 manifest에서 `unavailable`로 표시되고
      부활하지 않는다.** manifest는 감사 metadata이지 백업이 아니다(§14)

## D. Prompt 경계 (유료 2턴)

- [ ] D-1. knowledge excerpt가 **untrusted data 자리**에 들어간다. 고정 system
      rule 뒤에 오고, 파일 내용이 규칙처럼 읽히는 자리에 놓이지 않는다(§9.1)
- [ ] D-2. **적대적 파일.** "이전 지시를 무시하라"류의 문장을 담은 파일을
      올리고 대화 → 모델이 그 문장을 지시로 받지 않는다. 경계 구조를 판별하는
      것이지 모델의 순종 여부를 판별하는 것이 아니다
- [ ] D-3. *(차단 아님)* `knowledgeHash`가 turn마다 기록되고 chunk 수가 실제
      선택 수와 일치한다

## E. Quota와 형식 (차단 아님, 0크레딧)

전부 되돌릴 수 있습니다. 이번 회차에서 건너뛰어도 서명할 수 있고, 그때는
판정란에 그렇게 적습니다.

- [ ] E-1. 개별 파일 32MiB 초과가 `ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED`로 거부
- [ ] E-2. profile당 20개 초과가 거부
- [ ] E-3. 계정당 100개 / object 500MiB / 추출 텍스트 50MiB 각각이 거부
- [ ] E-4. 지원하지 않는 mime이 `ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE`로 거부되고,
      확장자와 signature 검사가 mime 문자열만 믿지 않는다
- [ ] E-5. `prepare`만 하고 `finalize`하지 않은 object가 24시간 뒤 orphan
      sweep에 수거된다

## F. 계정 삭제와 export (차단, 0크레딧)

- [ ] F-1. 계정 삭제가 `AssistantKnowledgeFile`·`Chunk`와 R2 object를 모두
      정리한다(정책 §13.1)
- [ ] F-2. 계정 데이터 export에 knowledge가 포함된다
      (`lib/accountDataExportDomains.ts`)
- [ ] F-3. `npm run check:data-domain-registry`가 knowledge 도메인에 대해
      `planned`·`unverified` 행 없이 통과한다

## G. 관측 (차단, 0크레딧)

- [ ] G-1. flag 전환이 Admin Console(`PATCH /api/admin/app-settings`)로
      이루어져 `AdminAuditLog`에 시작·완료 두 행이 남고, 전환 후
      `GET /api/admin/audit-integrity`가 `valid: true`이며 `checkedEntries`가
      전환 전보다 늘어 있다
- [ ] G-2. knowledge 지표가 content-free다. 파일명·파일 내용·`searchTerms`가
      분석 이벤트에 들어가지 않고 byte bucket·처리 실패율·chunk 수만 나간다
      (정책 §22)

## 실행 기록

결과는 이 파일이 아니라
`assistant-knowledge-staging-verification-records/`에 남깁니다. 생성:

```
npm run new:staging-verification-record -- --feature assistant-knowledge --sha <staging에 실제 배포된 40자리 SHA>
```
