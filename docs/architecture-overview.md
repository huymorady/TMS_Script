# TMS CAT Tool Userscript — 아키텍처 개요 (v0.7.48 기준)

대상 파일: `cat-tool-chat.user.js` (단일 IIFE, ≈10,200 라인).
관련 문서:
- 모듈별 상세: [section-reference.md](section-reference.md)
- 알려진 이슈 / 개선 후보: [known-issues.md](known-issues.md)
- 배치 탭 v1 스펙: [chat-modal-batch-tabs-spec-plan.md](chat-modal-batch-tabs-spec-plan.md)

---

## 1. 전체 그림

스크립트는 TMS Naive UI 위에 **모달 1개**(Alt+Z 토글)를 띄워서 두 가지 흐름을 제공한다.

| 흐름 | 단위 | 진입 | 결과 적용 |
|---|---|---|---|
| **채팅** | 단일 세그먼트 | 모달 `채팅` 탭 | 사용자 명시 채택(`번역 채택` / 인라인 `✓ 셀로 적용`) |
| **배치** | 현재 페이지 (≤50개) | 모달 `배치 실행` 탭 | 검토 후 사용자 명시 적용 (자동 저장 없음) |

두 흐름 모두 TMS의 `prefix_prompt_tran` API를 통해 LLM 호출 → 결과를 `storage string`의 `active_result`에서 다시 읽는 stateless 구조다.

---

## 2. 모듈 ToC (코드 §1–§21 매핑)

| § | 영역 | 라인 | 핵심 책임 |
|---|---|---|---|
| §1 | 상수 & 설정 | L48 | `LS_KEYS`, `SCRIPT_VERSION`, IDB 백업 설정, `CATEGORY_CATALOG`(0–21) |
| §2 | 유틸리티 | L198 | DOM 헬퍼, `lsGet/Set` (손상 시 격리), 로깅, URL params, `twConfirm` |
| §3 | Activity ring | L361 | 200건 ring buffer 감사 로그 + LS 동기화 + 디버그 surface 게이트 |
| §4 | API 래퍼 | L567 | `apiJson`, `callPrefixPromptTran`, `pollTask`, stale 응답 가드 |
| §5 | Batch helpers | L736 | 응답 정규화, ID coverage, `TOKEN_PATTERN`, placeholder/한자 검증 |
| §6 | textarea 탐색·주입 | L1406 | `findTranslationTextarea(Strict)`, native setter + Vue 이벤트 |
| §7 | 세션 관리 | L1496 | 세션 CRUD, 30일 TTL 자동 정리 |
| §8 | IndexedDB ring 백업 | L2098 | 5-슬롯 round-robin, threshold/phase45 trigger, 복원 |
| §9 | 시스템 프롬프트 | L2444 | chat 프롬프트, Phase 슬롯 3종, Frame, 카테고리 가이드라인 |
| §10/10b/10c | 활성 세그먼트 | L2765 | DOM 기반 ID 추출, 채팅·배치 통합 상태 |
| §11 | applied-from-batch | L2910 | 배치 자동 적용 추적(djb2 해시), drift 감지 |
| §12 | 리뷰 override | L2985 | (runId, stringId) 키 override + 백업 카운터 |
| §13 | batch → chat 시드 | L3236 | 배치 결과 + 형제 세그먼트 + TB 용어로 채팅 시드 |
| §14a/14b | 컨텍스트·프롬프트 조립 | L3321/L3354 | 세그먼트 메타 → 텍스트, 최종 prefix_prompt 생성 |
| §15 | Batch workflow state | L3394 | run 객체 lifecycle, Phase 1+2 / 3 / 4+5 실행기 |
| §16 | 모달 UI | L4006 | HTML 템플릿 + CSS, 4개 메인 탭 |
| §17 | 이벤트 핸들러 | L5394 | `attachHandlers` — 버튼/탭/입력 전부 |
| §18 | Show/Hide + 자동 감지 | L8067 | `showModal`, `loadSegmentInfo`(token+epoch), 0.5s polling watcher |
| §19 | 채팅 흐름 | L8260 | `onSend` (snapshot 가드), 인라인 액션, `onAdoptTranslation` |
| §20 | 설정 패널 | L8647 | 3-tab overlay: 시스템 프롬프트 / 카테고리 / 워크스페이스 |
| §21 | 단축키 + 디버그 surface | L10139 | Alt+Z, `window.tmsWorkflow`, 디버그 게이트 |

---

## 3. 데이터 플로우 — 풀 배치 사이클

happy path 한 번을 함수 체인으로 따라가면:

### 3.1 수집
1. `onBatchCollect()` (§17/§15)
2. → `createBatchRunBase()` → `persistBatchRun()`  (§15, status=`idle`)
3. → `fetchCurrentPageSegments(run)` (§15) → `normalizeSegmentListResponse` (§5)
4. → `fetchBatchNotes(expectedIds)` (§4, 100개 단위 chunking)

### 3.2 Phase 1+2 / 3 / 4+5 실행
모든 phase는 같은 `onRunBatchPhase(phase)` (§15) 골격:
1. `setBatchStatus('phaseXX_running')` → persist
2. base prompt 결정: `loadBatchPhasePrompts()` (§9) → 비면 `getActivePrompt()`(§9) 폴백
3. Frame 결합: `BATCH_PHASE_FRAME` (§9, 하드코드 5 안전 규칙)
4. 카테고리 주입: phase3/4+5만 — `getActiveCategories()`(§15) + `loadCategoryGuidelines()`(§9), `CATEGORY_GUIDELINES_ENABLED`가 ON일 때
5. attempt_id 생성 (§15) — LLM이 echo back해야 stale 응답 차단
6. `callPrefixPromptTran()` (§4) → `pollTask()` (§4)
7. `fetchSavedResultSnapshot()` (§4) — `fetchOk` 플래그 동반
8. JSON 추출·검증 (§5) — placeholder count/order, hanja, TB
9. `run.phaseXX = {raw, parsed, validation}` → `persistBatchRun()` (§15)
10. Phase 1+2 완료 시: `activeCategoryIds` 추출 → run에 저장
11. Phase 4+5 완료 시: backup trigger (§8)

### 3.3 검토 → 적용
1. `renderReviewTable()` (§17/§20) — phase3 + phase45 revision + override + applied 배지 통합
2. 사용자 인라인 편집 → `setReviewOverride(runId, stringId, text)` (§12) → 카운터 bump → 임계 도달 시 `triggerBackupAsync()` (§8)
3. `applyBatchTranslationsByIds()` (§17) →
   - `findStringItemByStringId` (§6) → `findTranslationTextarea` (§6)
   - `injectTextareaValue` (§6, native setter + input/change/n-input dispatch)
   - `recordAppliedFromBatch` (§11) — djb2 해시 + runId 기록

### 3.4 채팅 통합 (선택)
1. 리뷰 row → `importBatchResultToChat()` (§13) — 형제 세그먼트(최대 5) + TB + 글자수 system 메시지로 시드
2. 사용자 대화: `onSend()` (§19) — 진입 시 stringId/segment **snapshot 가드** (v0.7.18)
3. 적용: `onAdoptTranslation()` (§19) → `findTranslationTextareaStrict` (§6, fallback 금지)
4. 채택 시 `clearAppliedFromBatch` (§11) — 채팅이 소유권 가져감
5. 옵션: `✓ override 굳히기` → `setReviewOverride` (§12)

---

## 4. 상태·영속화 맵

### 4.1 LS_KEYS 전체 인덱스

| LS Key | 소유 § | Write 진입 | Read 진입 | Lifetime | IDB 백업 | 마이그레이션 |
|---|---|---|---|---|---|---|
| `SYSTEM_PROMPTS` | §9 | savePrompts | loadPrompts, getActivePrompt | 영구 | ✓ | 없음 |
| `ACTIVE_PROMPT_ID` | §9 | setActivePromptId | getActivePromptId | 영구 | ✓ | v0.7.48: chat/batch 분리 → 단일화 |
| `SESSIONS` | §7 | setSession, prune | loadSessions, getSession | 30일 TTL | ✓ | 없음 |
| `MODEL` | §9 | setSelectedModel | getSelectedModel | 영구 | ✓ | 없음 |
| `MODAL_POS` / `MODAL_SIZE` | §17 | drag/resize | showModal | 영구 | ✗ | 없음 |
| `BATCH_RUNS` | §15 | saveBatchRuns(+GC) | loadBatchRuns | run당, 10개 GC | ✓ (segments/promptLog/.raw 제외) | 없음 |
| `ACTIVE_BATCH_RUN` | §15 | setActiveBatchRunId | getActiveBatchRunId | 단일 ref | ✓ | 없음 |
| `APPLIED_FROM_BATCH` | §11 | recordAppliedFromBatch, prune | getAppliedFromBatch, review render | 영구 (TTL 없음) | ✗ | 레거시 string→object on read |
| `REVIEW_OVERRIDES` | §12 | setReviewOverride, GC | loadReviewOverrides, getReviewOverride | 영구 (orphan 가능) | ✓ | 레거시 string→object on read |
| `COMPACT_MODE` | §17 | toggle | settings init | 영구 | ✗ | 없음 |
| `SCHEMA_VERSION` | §2/§8 | ensureSchemaVersion | ensureSchemaVersion | 단일 정수 | ✓ | infra만 (현재 step 0개) |
| `BACKUP_NEXT_SLOT` | §8 | _nextBackupSlot | _nextBackupSlot | ring index | ✗ | 없음 |
| `OVERRIDE_WRITE_COUNTER` | §8/§12 | bump | bump | 누적 카운터 | ✓ | 없음 |
| `SESSION_WRITE_COUNTER` | §8/§7 | bump | bump | 누적 카운터 | ✓ | 없음 |
| `ACTIVITY_LOG` | §3 | logActivity | getActivityLog | ring 200건 | ✗ | 없음 |
| `CATEGORY_GUIDELINES` | §9 | saveCategoryGuidelines | loadCategoryGuidelines | id 0–21 | ✓ | id 화이트리스트 필터 |
| `CATEGORY_GUIDELINES_ENABLED` | §9 | save | load | 글로벌 toggle | ✓ | 없음 |
| `VERBOSE_PROMPT_LOG_ENABLED` | §9 | save | load | 글로벌 toggle (debug) | ✗ | 없음 |
| `BATCH_PHASE_PROMPTS` | §9/§15 | setBatchPhasePrompt, reset | loadBatchPhasePrompts | 슬롯 3개 | ✓ | 없음 (키 하드코드) |

### 4.2 백업 커버리지 비대칭

- IDB ring 백업 대상: 사용자 데이터(세션/프롬프트/카테고리/배치 결과/override)
- **백업 미포함**: `APPLIED_FROM_BATCH`, `COMPACT_MODE`, `ACTIVITY_LOG`, `VERBOSE_PROMPT_LOG_ENABLED`, `BACKUP_NEXT_SLOT`
  - Rationale: applied는 derived, compact/log/verbose는 cosmetic·debug, BACKUP_NEXT_SLOT은 operational

### 4.3 GC / Orphan 패턴

| 트리거 | 동작 | 잔여 위험 |
|---|---|---|
| `pruneExpiredSessions()` (modal open) | 30일 경과 세션 삭제 | 모달 안 열면 누적 |
| `saveBatchRuns(skipGc=false)` | createdAt/updatedAt 기준 상위 10개 + active 유지 | 8/D11에서 일부 경로는 `skipGc=true` |
| `gcOrphanReviewOverrides()` | run 없는 override 정리 | TTL 없음 → 명시 호출 필요 |
| `clearAppliedFromBatchByRunId()` (run 삭제 시) | 자동 호출 | restore/import의 skipGc 경로는 `pruneAppliedFromBatchOrphans()` 별도 |
| `nullifyDanglingImportedFromRunId()` | session.importedFromRunId 정리 | 자동 (v0.7.32) |

### 4.4 동시성·정합성 가드 (도입 시점)

| 가드 | 위치 | 도입 |
|---|---|---|
| 세그먼트 watcher epoch | §18 | v0.7.22 |
| `loadSegmentInfo` token 가드 | §18 | v0.7.22 (#C1-P1-7) |
| `onSend` snapshot (requestStringId/Segment) | §19 | v0.7.18 → v0.7.29 currentSegment null 초기화 |
| 세션 reload-before-push | §19 | v0.7.22 (#C1-P1-10) |
| API 응답 segId 검증 | §4 | v0.7.22 (#C1-P0-2) |
| `findTranslationTextareaStrict` (apply/adopt 강제) | §6 | v0.7.32 (#D6-P2-9) |
| Batch op 전역 mutex `withBatchLock` | §15 | v0.7.29 (#D3-P1-3) |
| `_priorSnapshot`/`_rollbackImport` 원자성 | §15 | v0.7.30 (#D4-P1-5) |
| `previousRaw` snapshot (in-memory 오인 차단) | §15 | v0.7.28 (#D2-P0-2) |
| Cross-tab batch lease | §15 | v0.7.34 (#D8) |
| `attempt_id` echo | §15/§4 | v0.7.33 (#D7) |
| Phase1 refetch/collect fail-closed | §15 | v0.7.37 (#D11) |
| LS 손상 격리 (`__tms_corrupted_*`) | §2 | v0.7.23 (#C2-P1-15) |
| Debug surface opt-in | §3/§21 | v0.7.26 → v0.7.36 |

---

## 5. 안전 모델 (적용=수동 원칙)

전체 인프라(검증·snapshot·override·lease·attempt_id·카테고리·Phase Frame)는 한 가지 원칙을 지키기 위해 만들어져 있다.

> **다중 세그먼트 자동 저장은 어떤 단계도 수행하지 않는다.**

(spec [chat-modal-batch-tabs-spec-plan.md](chat-modal-batch-tabs-spec-plan.md) §15 v1 완료 기준 7번)

검토(`결과 검토` 탭)에서 사용자가 명시 클릭한 세그먼트만 textarea로 주입한다. Stage 6(자동 적용)은 별도 설계 후 구현 예정으로, 현재 미착수.

---

## 6. 관련 외부 의존

- TMS API 엔드포인트: `/api/translate/projects/{projectId}/prefix_prompt_tran/`, `/api/translate/strings/`, `/api/translate/string_notes/`, task polling
- TMS DOM 가정: `.string-item[data-key="stringItem{ID}"]`, 번역 textarea placeholder = `请输入译文`
- 브라우저 API: `localStorage`, `IndexedDB`, `fetch`
- Vue Naive UI: `.n-input` wrapper에 추가 이벤트 dispatch

---

## 7. 버전 주석 정책 (v0.7.15~)

- `v0.7.x`: 변경 맥락이 살아있는 동안 inline 유지
- `v0.6.x`: prefix 제거, git blame으로 추적
- 누적 변경은 `git log --oneline`으로 확인

```text
git --no-pager log --oneline -30
```
