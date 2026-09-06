# Memory eval vNext 계약 결정 승인 기록 — 2026-09-06

이 문서는 승인된 결정문의 bytes를 바꾸지 않고 사람의 승인을 별도로 보존하는
authoritative approval receipt다. 아래 SHA-256은 오직 명시된 결정문 한 파일에만
귀속되며, 다른 초안·결정문·승인 기록을 승인한 것으로 읽지 않는다.

## 1. 승인 기록

```yaml
decision: yes
approvedBy: "@mposition"
approvedAt: "2026-09-06"
approvedDocument: ".github/audits/memory-eval-vnext-contract-decision-2026-09-05.md"
approvedDocumentSha256: "355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da"
externalConfirmationReview: "CONFIRMED"
repositoryBasis: "6263ecdcc1e69585498c19c0a294fef5202f5218"
commitRole: "decision approval commit A"
```

`decision: yes`는 승인된 결정문의 D1–D5와 §12 「서명 시 수용하는 잔여」 전체를
수용한다는 뜻이다. 외부 확인 검토는 P1 세 건의 closure와 warning 다섯 건의
disposition을 확인했고 수정 회귀가 없다고 판정했다.

## 2. 승인 대상 bytes와 commit A

승인 대상은
`.github/audits/memory-eval-vnext-contract-decision-2026-09-05.md`의 정확한 bytes이며,
그 SHA-256은
`355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da`다.
결정문 §13의 서명 칸은 승인 당시에도 비어 있었고 그대로 둔다. 그 칸을 채우면
승인된 bytes와 SHA-256이 바뀌므로, 승인 사실은 이 별도 receipt에만 기록한다.

승인된 결정문과 이 receipt를 처음 함께 기록하는 commit이 decision approval의
**commit A**다. 이후 S2가 쓰는 `approvalCommit`은 이 commit A의 40자 Git SHA를
참조해야 한다. 위 `repositoryBasis`는 승인된 결정문의 저장소 내용 기준이며 commit A의
SHA가 아니다.

## 3. 허용 범위

이 승인이 허용하는 것은 D1–D5를 약화하지 않는 **S1–S5 하위 명세 문서 작성**뿐이다.
commit A 자체는 S1–S5 계약 작성이나 구현 단계가 아니다.

다음은 승인하지 않는다.

- scorer 또는 ledger 구현
- succ-9 purpose 전환이나 activation
- dataset·manifest·register 변경
- holdout 작성·봉인·개봉
- v9 prompt 작성 또는 활성화
- 예산·dispatch·provider 호출
- pair 승인
- release gate 변경
- `memoryExtractionEnabled` 변경
- `memoryInjectionEnabled` 변경

S5는 작성 권한이 원칙상 열렸더라도 결정문 §7.1과 §9의 순서를 따른다. **S1–S4가
승인되고, scorer가 동결되며, holdout이 seal되기 전에는 S5를 시작하지 않는다.**

이 receipt는 위 범위 밖의 행위를 묵시적으로 허용하지 않는다. 각 구현·전환·실행·
활성화는 결정문이 요구하는 별도 검토와 사람 승인을 받아야 한다.
