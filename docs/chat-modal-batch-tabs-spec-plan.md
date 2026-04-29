# TMS Chat Modal Batch Tabs Spec and Plan

Status: draft
Owner: local Tampermonkey workflow
Base files: `cat-tool-chat.user.js`, `test_v31.js`

## 1. 목표

기존 `Alt+Z` chat 모달 안에 탭 전환 UI를 추가해서, 단일 세그먼트 채팅 흐름과 다중 세그먼트 compact workflow를 같은 진입점에서 사용할 수 있게 만든다.

핵심 목표는 다음과 같다.

- 콘솔 붙여넣기 없이 50개 단위 다중 세그먼트 테스트를 실행한다.
- 기존 단일 세그먼트 chat 기능은 그대로 유지한다.
- Phase 1+2, Phase 3, Phase 4+5 결과를 모달 안에서 확인한다.
- 실제 세그먼트 적용은 검증 전까지 자동화하지 않는다.
- Bedrock timeout, stale result, storage string 오염 같은 실패 상태를 UI에서 명확히 보여준다.

## 2. 범위

이번 1차 구현 범위는 "실행과 검토를 편하게 만드는 UI"다.

포함한다.

- chat 모달 상단에 주 탭 추가
- 현재 페이지 세그먼트 수집
- 备注 일괄 조회
- compact Phase 1+2 실행
- compact Phase 3 실행
- compact Phase 4+5 실행
- JSON 파싱 및 검증
- 결과 검토 테이블
- raw JSON/log 보기
- localStorage 기반 실행 상태 저장

제외한다.

- 실제 번역 결과를 50개 세그먼트에 자동 저장
- 선택 세그먼트 일괄 저장
- 전체 파일 페이지네이션 처리
- category 0-21 세부 프롬프트 자동 선택
- 모달 밖 별도 대시보드

## 3. 현재 확인된 사실

콘솔 하네스 기준으로 compact workflow는 50개 세그먼트에서 통과했다.

- Phase 1+2: 50개 ID coverage OK
- Phase 3: 50개 번역, `gid` 일치 OK
- placeholder 보존 OK
- 한자 잔존 검증 OK
- verbose JSON은 Bedrock read timeout 위험이 높음
- compact JSON은 2-6회 poll 안에 안정적으로 완료되는 편

주의해야 할 점도 확인됐다.

- `task_results`의 `SUCCESS`는 작업 완료만 의미하며, 실제 결과는 storage string의 `active_result.result`를 다시 읽어야 한다.
- storage string에 기존 결과가 있으면 stale 판별이 꼬일 수 있다.
- `prefix_prompt_tran`은 결과를 지정한 `string_id_list` 대상 번역 칸에 저장하므로 scratch/storage string 오염이 발생한다.
- Phase 4+5는 품질 개선 단계지만, 과수정 가능성이 있으므로 자동 적용하면 안 된다.

## 4. 사용자 경험 구조

기존 chat 모달의 큰 틀은 유지한다.

상단 구조:

```text
[TMS Chat] [segment info] [settings] [close]
[채팅] [배치 실행] [결과 검토] [JSON/로그]
```

탭 역할:

- `채팅`: 현재 단일 세그먼트 대화, 기존 기능 유지
- `배치 실행`: 세그먼트 수집, Phase 실행, 진행 상태 표시
- `결과 검토`: Phase 3/4+5 결과를 세그먼트별로 비교
- `JSON/로그`: compact JSON, validation 결과, API 로그 확인

초기 기본 탭은 `채팅`이다. 사용자가 명시적으로 `배치 실행` 탭을 누르기 전에는 다중 세그먼트 API 호출을 하지 않는다.

## 5. 상태 모델

localStorage에 batch run 상태를 저장한다. Vue SPA remount나 새로고침으로 console/window 상태가 사라지는 문제를 피하기 위함이다.

권장 key:

```js
tms_workflow_batch_runs_v1
tms_workflow_active_batch_run_v1
```

`batchRun` 구조:

```json
{
  "runId": "20260424-153000-file26230",
  "projectId": 77,
  "fileId": 26230,
  "languageId": 27,
  "page": 1,
  "pageSize": 50,
  "model": "claude-sonnet-4-6",
  "scope": "current_page",
  "status": "idle",
  "segments": [],
  "notesByStringId": {},
  "storageStringId": null,
  "phase12": null,
  "phase3": null,
  "phase45": null,
  "validations": {},
  "logs": [],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

상태값:

- `idle`: 아직 실행 전
- `collecting`: 세그먼트와 备注 수집 중
- `ready`: 수집 완료
- `phase12_running`: Phase 1+2 실행 중
- `phase12_ready`: Phase 1+2 검증 완료
- `phase3_running`: Phase 3 실행 중
- `phase3_ready`: Phase 3 검증 완료
- `phase45_running`: Phase 4+5 실행 중
- `phase45_ready`: Phase 4+5 검증 완료
- `reviewing`: 사용자가 결과 확인 중
- `apply_ready`: 수동 적용 가능 상태
- `failed`: 오류 발생
- `stale`: 저장 결과가 기대 phase와 맞지 않음

## 6. 워크플로우

기본 흐름:

1. 사용자가 `Alt+Z`로 chat 모달을 연다.
2. `배치 실행` 탭을 선택한다.
3. 스크립트가 현재 URL에서 `projectId`, `fileId`, `languageId`, `page`, `pageSize`를 읽는다.
4. 사용자가 `현재 페이지 수집` 버튼을 누른다.
5. `/api/translate/strings/`로 현재 페이지 세그먼트를 수집한다.
6. 수집된 ID 중 storage string을 고른다.
7. `/api/translate/string_notes/`로 备注를 일괄 수집한다.
8. 사용자가 `Phase 1+2 실행`을 누른다.
9. compact Phase 1+2 JSON을 storage string에 저장하고 다시 읽는다.
10. 파싱 및 ID coverage 검증을 통과하면 `Phase 3 실행`을 활성화한다.
11. Phase 3 JSON을 storage string에 저장하고 다시 읽는다.
12. 번역 수, ID, `gid`, placeholder, 빈 번역, 한자 잔존을 검증한다.
13. 사용자가 원하면 `Phase 4+5 실행`을 누른다.
14. Phase 4+5 JSON을 storage string에 저장하고 다시 읽는다.
15. revision 구조와 변경 사유를 검증한다.
16. `결과 검토` 탭에서 최종 후보를 확인한다.

자동 진행은 v1에서 금지한다. 각 Phase는 사용자가 버튼으로 실행한다. 이유는 비용과 오염 위험, 그리고 Phase 4+5 과수정 위험 때문이다.

## 7. API 계약

세그먼트 수집:

```text
GET /api/translate/strings/?project={projectId}&target_language={languageId}&file={fileId}&page={page}&page_size={pageSize}
```

응답 형태는 `data.items[]`, `data[]`, `data.results[]`를 모두 허용한다.

备注 조회:

```text
GET /api/translate/string_notes/?strings={id1}&strings={id2}
```

LLM 실행:

```text
POST /api/translate/prefix_prompt_tran/
```

요청 body:

```json
{
  "language_id_list": [27],
  "string_id_list": [5840062],
  "prefix_prompt": "...",
  "is_associated": true,
  "model": "claude-sonnet-4-6"
}
```

작업 폴링:

```text
GET task result endpoint from prefix_prompt_tran response
```

결과 조회:

```text
GET /api/translate/strings/?id={storageStringId}&project={projectId}&target_language={languageId}&file={fileId}
```

실제 결과 위치:

```text
data[0].active_result.result
```

정리 API:

```text
POST /api/translate/result_clear/
```

정리 API는 v1에서 자동 호출하지 않는다. UI에는 `storageStringId 오염됨` 경고와 수동 정리 안내만 표시한다.

## 8. compact JSON 계약

Phase 1+2:

```json
{
  "phase": "1+2",
  "cats": [1, 2, 11, 13],
  "note_schema": {"col8": "placeholder_zh", "col9": "placeholder_en"},
  "groups": [
    {"gid": "G1", "ids": [5840062], "cats": [13], "tone": "festive_title", "rules": ["use_tb_terms"]}
  ],
  "global_rules": ["preserve_value_tokens", "use_tb_terms"]
}
```

Phase 3:

```json
{
  "phase": "3",
  "translations": [
    {"id": 5840062, "gid": "G1", "t": "장인의 선물"}
  ]
}
```

Phase 4+5:

```json
{
  "phase": "4+5",
  "revisions": [
    {"id": 5840062, "gid": "G1", "t": null, "r": []}
  ]
}
```

Phase 4+5의 `t:null`은 Phase 3 번역 유지다. `t`가 문자열이면 수정 번역이며, `r`에는 짧은 reason code가 최소 1개 있어야 한다.

## 9. 검증 게이트

Phase 1+2 검증:

- 모든 Allowed ID가 정확히 한 번 포함되어야 한다.
- Allowed ID 밖의 ID가 없어야 한다.
- 중복 ID가 없어야 한다.
- `groups[].gid`가 비어 있으면 안 된다.
- `groups[].rules`는 배열이어야 한다.

Phase 3 검증:

- `translations.length`가 세그먼트 수와 같아야 한다.
- 모든 Allowed ID가 정확히 한 번 포함되어야 한다.
- `gid`가 Phase 1+2 결과와 일치해야 한다.
- `t`는 빈 문자열이면 안 된다.
- 원문의 `{value1}` 같은 placeholder가 번역문에 그대로 있어야 한다.
- 번역문에 중국어 한자가 남으면 경고 또는 실패로 처리한다.

Phase 4+5 검증:

- 모든 revision ID는 Allowed ID 안에 있어야 한다.
- `gid`가 Phase 1+2 결과와 일치해야 한다.
- `t:null`이면 유지로 처리한다.
- `t`가 문자열이면 `r`은 비어 있으면 안 된다.
- Phase 3보다 품질이 나빠 보이는 과수정은 자동 적용하지 않고 검토 플래그를 붙인다.

저장 결과 검증:

- JSON code fence는 제거 후 파싱한다.
- `Read timeout on endpoint URL`은 `BEDROCK_READ_TIMEOUT`으로 분류한다.
- phase가 기대값과 다르면 stale result로 분류한다.
- 저장 결과 길이가 0이면 empty result로 분류한다.

## 10. 실패 처리

Bedrock timeout:

- 상태를 `failed`로 변경한다.
- storage string에 timeout 문자열이 저장됐음을 표시한다.
- 같은 입력으로 즉시 재시도하지 말고, compact prompt나 범위를 조정하라고 안내한다.

Stale result:

- 상태를 `stale`로 변경한다.
- 기존 storage string 결과 미리보기를 표시한다.
- 사용자가 storage string 정리 후 재시도하도록 안내한다.

Polling timeout:

- 상태를 `failed`로 변경하되 run state는 유지한다.
- 사용자가 `결과 다시 읽기`를 누르면 active result만 재조회한다.

SPA remount 또는 새로고침:

- active run key를 읽어 마지막 상태를 복구한다.
- running 상태에서 복구된 경우 자동으로 API를 재호출하지 않는다.
- 사용자가 `결과 다시 읽기`를 눌러 이어간다.

备注 조회 실패:

- v1에서는 실패로 중단한다.
- 이후 버전에서만 "备注 없이 진행" 선택지를 추가한다.

## 11. UI 상세

`배치 실행` 탭 구성:

- 현재 파일 정보: projectId, fileId, languageId, page, pageSize
- 수집 범위: 현재 페이지
- 모델 선택
- storage string ID 표시
- `현재 페이지 수집`
- `Phase 1+2 실행`
- `Phase 3 실행`
- `Phase 4+5 실행`
- phase별 상태 배지
- 검증 요약
- storage string 오염 경고

`결과 검토` 탭 구성:

- ID
- group
- 원문 미리보기
- Phase 3 번역
- Phase 4+5 수정 번역
- 최종 후보
- flags
- 복사 버튼

v1의 결과 검토 탭은 copy 중심이다. 실제 TMS 저장은 별도 테스트 후 붙인다.

`JSON/로그` 탭 구성:

- Phase 1+2 raw JSON
- Phase 3 raw JSON
- Phase 4+5 raw JSON
- validation object
- API timeline log
- 마지막 오류 상세

## 12. 구현 계획

Stage 0: 문서 확정

- 이 문서를 기준으로 v1 범위를 확정한다.
- 자동 적용 제외 원칙을 유지한다.

Stage 1: batch helper 이식

- `test_v31.js`의 검증 함수와 JSON 파서만 `cat-tool-chat.user.js`로 옮긴다.
- UI 없이 helper 단위로만 붙인다.
- 기존 chat send/adopt 동작은 건드리지 않는다.

Stage 2: modal tab shell 추가

- chat 모달 header 아래에 main tab bar를 추가한다.
- 기본 탭은 `채팅`으로 둔다.
- 기존 `.tw-chat-panel`은 chat tab content로 감싼다.
- settings overlay의 내부 tab 패턴을 참고하되, main tab 상태와 settings tab 상태는 분리한다.

Stage 3: batch collect UI

- `배치 실행` 탭에 파일 정보와 수집 버튼을 추가한다.
- 현재 페이지 세그먼트와 备注를 수집한다.
- storage string 자동 선택 결과를 보여준다.
- localStorage에 run state를 저장한다.

Stage 4: phase runner UI

- Phase 1+2, Phase 3, Phase 4+5 버튼을 순차 활성화한다.
- 각 Phase는 `prefix_prompt_tran`, polling, active result refetch를 같은 runner로 처리한다.
- compact JSON parse와 validation을 통과해야 다음 버튼을 연다.

Stage 5: review/log UI

- `결과 검토` 탭에 세그먼트별 최종 후보를 표시한다.
- Phase 4+5에서 `t:null`이면 Phase 3 번역을 최종 후보로 표시한다.
- `JSON/로그` 탭에 raw와 validation 결과를 표시한다.

Stage 6: 적용 기능 별도 설계

- 자동 저장 API를 별도 테스트한다.
- textarea injection 방식과 API save 방식을 비교한다.
- 저장 실패/부분 성공/되돌리기 정책을 따로 문서화한 뒤 구현한다.

## 13. 테스트 계획

정적 테스트:

```powershell
node --check .\cat-tool-chat.user.js
```

브라우저 테스트:

- TMS 파일 `fileId=26230`에서 모달 열기
- `채팅` 탭 기존 단일 세그먼트 동작 확인
- `배치 실행` 탭에서 50개 수집 확인
- Phase 1+2 실행 후 ID coverage OK 확인
- Phase 3 실행 후 50개 번역 검증 OK 확인
- Phase 4+5 실행 후 revision 구조 확인
- 새로고침 후 active run 복구 확인
- storage string 기존 결과가 있을 때 stale warning 확인

안전 테스트:

- Phase 실행 중 닫기 후 다시 열기
- storage string active result가 빈 값일 때 실행
- storage string active result가 기존 JSON일 때 실행
- Bedrock timeout 문자열이 저장됐을 때 오류 분류
- placeholder가 누락된 가짜 결과를 넣었을 때 validation fail

## 14. 남은 결정 사항

- 실제 적용은 textarea injection으로 할지, TMS 저장 API로 할지 결정해야 한다.
- 전체 파일이 100개 이상일 때 pagination을 v2에서 처리할지, v1에서 바로 처리할지 정해야 한다.
- category 0-21 세부 프롬프트를 어디서 읽고 어떻게 compact rules에 반영할지 정해야 한다.
- storage string을 첫 번째 세그먼트로 계속 쓸지, 사용자가 별도 선택하게 할지 정해야 한다.
- Phase 4+5가 과수정하지 않도록 reason code와 conservative prompt를 더 강화해야 한다.

## 15. v1 완료 기준

v1은 다음 조건을 만족하면 완료로 본다.

- 기존 chat 탭 기능이 깨지지 않는다.
- batch tab에서 현재 페이지 50개 수집이 가능하다.
- Phase 1+2 compact JSON이 UI에서 실행되고 검증된다.
- Phase 3 compact JSON이 UI에서 실행되고 검증된다.
- Phase 4+5 compact JSON이 UI에서 실행되고 검토된다.
- 결과 검토 탭에서 최종 후보를 사람이 확인할 수 있다.
- 어떤 단계도 다중 세그먼트에 자동 저장하지 않는다.
- 실패 상태가 silent fail로 묻히지 않고 UI에 표시된다.

