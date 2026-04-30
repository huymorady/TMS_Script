# TMS CAT Tool Userscript — 모듈별 레퍼런스 (v0.7.48)

대상 파일: `cat-tool-chat.user.js`. 라인 번호는 ±10줄 오차 가능 (편집 후 표류).
상위 문서: [architecture-overview.md](architecture-overview.md). 이슈는 [known-issues.md](known-issues.md).

각 섹션 항목 형식:
- **목적** — 한두 줄
- **주요 entry point** — 함수/객체
- **데이터 구조** — LS 키, in-memory state
- **의존** — 호출하는 § / 호출당하는 §
- **주의사항** — race 가드, fail-closed, 버전 anchor

---

## §1 상수 & 설정 (L48–197)

**목적.** 전 글로벌 상수의 단일 소스. `LS_KEYS`(스키마 키), `SCRIPT_VERSION`(banner/진단 단일 출처), IDB 백업 설정, `CATEGORY_CATALOG`(V3.1 0–21).

**주요 entry point.**
- `LS_KEYS` — 스키마 키 dict
- `CURRENT_SCHEMA_VERSION = 1`, `SCHEMA_MIGRATIONS = {}` (infra만)
- `BACKUP_DB_NAME`, `BACKUP_SLOT_COUNT = 5`, `OVERRIDE_BACKUP_THRESHOLD = 10`, `SESSION_BACKUP_THRESHOLD = 30`
- `CATEGORY_CATALOG` (frozen `[{id, name}]`, 22개)
- `DEFAULT_PROMPT`, `BATCH_PHASE_FRAME`(§9 참조)

**의존.** Pure constants. §2 이상 모든 § 참조.

**주의사항.**
- v0.7.7 #10: 스키마 마이그레이션 placeholder. 키 변경 시 step 등록 + `CURRENT_SCHEMA_VERSION` bump 필수
- v0.7.7 #12: ring 5 슬롯 round-robin (modulo)
- v0.7.38 #D12: 카테고리 0–21 V3.1 spec 고정. 변경 시 LS 마이그 필요
- v0.7.43: phase 슬롯 키 하드코드 `phase12 / phase3 / phase45`

---

## §2 유틸리티 (L198–360)

**목적.** DOM 헬퍼, LS 접근(손상 격리 포함), 로그 레벨 게이팅, 마스킹, URL 파라미터, 스키마 가드, 모달 confirm.

**주요 entry point.**
- `$(sel, root?)`, `$$(sel, root?)`
- `lsGet(key, def)`, `lsSet(key, val)` — boolean 반환 (v0.7.21 #B2~)
- `dverbose / dinfo / dwarn / derror` — `LOG_RANK` 게이팅
- `maskSensitive(value, {headChars, force})` — djb2 32-bit 해시 + 프리뷰
- `getUrlParams()` — `projectId/fileId/languageId/page/pageSize` 등
- `parseRequiredInt(raw, name)` — 엄격 파싱 `/^-?\d+$/`
- `ensureSchemaVersion()` — 마이그 게이트 (현재 no-op)
- `twConfirm({title, message, ...})`, `twChooseRestoreScope({slot, counts})`
- `escapeHtml`, `normalizeId`

**데이터 구조.**
- `LOG_RANK` (정수 0–4)
- 손상 격리 키: `__tms_corrupted_${key}_${ts}`

**의존.** 모든 §의 fundamental utilities.

**주의사항.**
- v0.7.21 #B4: `parseRequiredInt`로 느슨한 문자열 거부
- v0.7.23 #C2-P1-15: 손상 JSON은 quarantine 키로 격리 + activity log + toast
- v0.7.7 #13: `maskSensitive` djb2 (식별용, 보안용 아님). LOG_RANK≥4면 마스킹 우회
- v0.7.26 #C5-P1-18 → v0.7.36 #D10-P2: 디버그 surface는 `tms_workflow_debug_surface === 'on'` opt-in 게이트

---

## §3 Activity ring (L361–462)

**목적.** in-memory + LS 동기화 감사 로그. 200건 ring buffer. 디버그 surface opt-in.

**주요 entry point.**
- `logActivity(category, message, meta)`
- `getActivityLog()` (얕은 복사)
- `clearActivityLog()`
- 내부: `_activityRing`, `_persistActivityDebounced()` (250ms)

**데이터 구조.**
- `LS_KEYS.ACTIVITY_LOG: Array<{t, cat, msg, meta?}>`
- `ACTIVITY_RING_CAP = 200` (newest-first unshift)
- cat enum: `error|warn|info|cleanup|config|misc`

**의존.** 호출자: §15 (배치 GC), §12 (override GC), §7 (세션 prune), §8 (백업 트리거), §20 (설정 패널), 위험 작업 전체.

**주의사항.**
- 디버그 surface opt-in (`window.tmsActivity`만 게이트 뒤). `getItem === 'on'` 정확 일치
- 250ms debounce → 크래시 시 미flush 메모리 손실

---

## §4 API 래퍼 (L567–693)

**목적.** TMS 서버 API 래퍼. CSRF, content-type 검증, 에러 마스킹, 로그인 redirect 감지, double-encoded JSON task 결과 파싱.

**주요 entry point.**
- `apiJson(url, options)` — fetch wrapper
- `fetchSegmentDetail(stringId)` — stale 응답 감지 (segId vs stringId)
- `callPrefixPromptTran(projectId, stringId, prefixPrompt, model)` → taskId
- `parseTaskProgress(rawResult)` — `{TOTAL, SUCCESS, FAILURE, PROCESS}`
- `pollTask(taskId, {onProgress, timeout, ...})`
- `fetchSavedResultSnapshot(storageStringId)` — `fetchOk` 플래그 (v0.7.33)
- `fetchBatchNotes(expectedIds)` — 100개 chunk

**주의사항.**
- v0.7.22 #C1-P0-2: 응답 segId 검증 (cross-response 차단)
- v0.7.7 #13: 에러 본문 djb2 마스킹
- content-type 체크로 JSON vs HTML(login redirect) 조기 분기
- task 결과는 double-encoded JSON

---

## §5 Batch compact workflow helpers (L736–1405)

**목적.** 배치 응답 정규화, ID coverage, placeholder/printf/Unity rich text/BBCode 토큰 패턴, hanja/TB 검증.

**주요 entry point.**
- `normalizeSegmentListResponse(listData)` → `{segments, meta}` (data.items[] / data.results[] / data[] 자동 감지)
- `analyzeIdCoverage(expectedIds, actualIds)` → `{ok, missing, extra, duplicates}`
- `TOKEN_PATTERN` (RegExp 단일)
- `extractAllPlaceholders(text)` → Set
- `extractOrderedPlaceholders(text)` → Array (순서·중복 보존)
- `findUnmatchedPlaceholders(src, dst)`
- 검증: `checkPlaceholderOrder`, `checkHanjaCount`, `checkTbMatch`(caseSensitive/minLen)

**주의사항.**
- v0.7.25 #C4-P2-22: `i/f` width 추가
- v0.7.31 #D5-P1-12: `u/x/X/o/c/p/g/e` + `ld/lld/lu/llu` 추가
- v0.7.31 #D5-P1-13: ordered Array 반환 (`%s %s` 중복 보존)
- v0.7.31 #D5-P1-16: 보호 토큰(BBCode 속성, HTML href) 제거 후 hanja 검사 → false positive 차단
- v0.7.25 #C4-P2-24: `\p{Script=Han}/u`로 CJK Extensions A-G 커버

---

## §6 textarea 탐색 & 값 주입 (L1406–1495)

**목적.** TMS Naive UI에서 stringId의 textarea 찾고, native setter 우회로 Vue/React reactivity 트리거.

**주요 entry point.**
- `findStringItemByStringId(stringId)` — `data-key="stringItem{ID}"`
- `extractStringIdFromItem(item)` — pattern match + last-digits fallback
- `findTranslationTextarea(stringId)` — explicit → active → focused fallback
- `findTranslationTextareaStrict(stringId)` — explicit only (apply/adopt 안전 경로)
- `injectTextareaValue(textarea, value)` — `Object.getOwnPropertyDescriptor` setter + `input/change/n-input` 이벤트

**주의사항.**
- v0.7.32 #D6-P2-9: 채팅 apply/adopt에서 strict 강제 → 다른 셀 자동 쓰기 사고 차단
- placeholder `请输入译文` 하드코드 (i18n 위험)
- triple event dispatch (Vue Naive UI 호환)

---

## §7 세션 관리 (L1496–1977)

**목적.** stringId 단위 세션(메시지/system/source/import 메타) CRUD + 30일 TTL 자동 정리.

**주요 entry point.**
- `loadSessions()`, `saveSessions(sessions)` — 타입 가드 (object only)
- `getSession(stringId)`, `setSession(stringId, session)`
- `clearSession(stringId)`, `clearAllSessions()`
- `pruneExpiredSessions()` (modal open 시 호출)
- `getSessionStats()`, `getWorkspaceStats()` — 집계

**데이터 구조.**
- 세션: `{messages: [{role:'user'|'ai', content}], system?, source?: 'manual'|'batch_import', importedFromRunId?, importedAt?, updated}`
- TTL: 30일

**주의사항.**
- v0.7.23 #C2-P1-13: 세션 쓰기마다 카운터 bump → threshold 30회마다 IDB backup
- v0.7.23 #C2-P1-28: load 시 object 가드 (Array면 `{}` 폴백, 그러나 silent)
- TTL은 modal open 시에만 prune

---

## §8 IndexedDB ring 백업 (L2098–2442)

**목적.** LS 손실(quota/수동 삭제/유저스크립트 충돌) 대비 5-슬롯 IDB ring buffer.

**주요 entry point.**
- `openBackupDb()` — lazy singleton
- `writeBackupSlot(snapshot)` — round-robin via `BACKUP_NEXT_SLOT`
- `readAllBackupSlots()`, `getLatestBackupSnapshot()`
- `buildBackupSnapshot(trigger)` — sessions/overrides/runs (raw·promptLog·.raw 제외)
- `triggerBackupAsync(reason)` — threshold 체크 후 write
- `maybeRestoreFromBackup()` — LS 비어 있고 IDB에 있으면 prompt
- `restoreFromBackupSlot(slot, scope)` — scope 부분 복원 (v0.7.24)

**데이터 구조.**
- IDB: `tms-workflow-backup` v1, store `snapshots`, keyPath `slot`
- snapshot: `{slot, savedAt(ISO), schemaVersion, trigger, sessions, overrides, runs}`
- trigger: `manual|override-threshold|run-complete|restore-init`

**주의사항.**
- v0.7.30 #D4-P1-5: import/restore 원자성 (`_priorSnapshot`/`_rollbackImport`), UI 슬롯 복원은 `await createBackupNow`로 사전 백업 보장
- v0.7.24 #C3-P1-14: 부분 복원 다이얼로그 + scope param

---

## §9 시스템 프롬프트 (L2444–2763)

**목적.** chat 시스템 프롬프트, 카테고리 가이드라인(0–21), Phase 슬롯(3), Frame, verbose log toggle.

**주요 entry point.**
- `loadPrompts()`, `savePrompts(prompts)`
- `getActivePrompt()`, `getActivePromptId()`, `setActivePromptId(id)` (v0.7.48 단일화)
- `getSelectedModel()`, `setSelectedModel(model)`
- `loadCategoryGuidelines()`, `saveCategoryGuidelines(map)`, `getCategoryGuidelineContent(id)`
- `loadCategoryGuidelinesEnabled()`, `saveCategoryGuidelinesEnabled(bool)`
- `loadVerbosePromptLogEnabled()`, `saveVerbosePromptLogEnabled(bool)`
- `loadBatchPhasePrompts()`, `setBatchPhasePrompt(slot, content)`, `resetBatchPhasePrompt(slot)`
- `BATCH_PHASE_FRAME` (const) — role + 5 안전 규칙
- `BATCH_PHASE_PROMPT_DEFAULTS` — slot별 시드 텍스트
- `extractCategoryChecklist(content)` — `### ✅ 체크리스트` 섹션 추출 (v0.7.46)

**주의사항.**
- v0.7.38 #D12: 카테고리 슬롯 (id 0 = 공통, 필수)
- v0.7.40: 글로벌 enable toggle
- v0.7.42: verbose prompt log opt-in (debug용, 1MB cap, phase당 최근 3건)
- v0.7.43: phase 슬롯 폴백 (비면 `getWorkflowBasePrompt()` → chat 프롬프트)
- v0.7.44: Frame 하드코드 (변경 시 리딜리버리 필요)
- v0.7.48: chat/batch 분리 API 제거 → 단일 active prompt

---

## §10 / §10b / §10c 활성 세그먼트 (L2765–2909)

**목적.** TMS DOM에서 active 세그먼트 위치, stringId 추출, 채팅·배치 통합 상태 조회.

**주요 entry point.**
- `findActiveStringItem()` — `.active` → focused textarea ancestor → top-most visible
- `extractStringIdFromItem(item)` — `stringItem(\d+)` + `(\d+)$` fallback
- `getCurrentStringId(verbose)`
- `getSegmentWorkState(stringId)` →
  ```
  {id, chat: {hasSession, messageCount, lastTranslation, updatedAt},
       batch: {runId, hasPhase3, phase3Text, groupId, hasRevision, revisionText, changed, reasons},
       finalCandidate, status: 'fresh'|'chat_only'|'batch_only'|'both'}
  ```

**주의사항.**
- finalCandidate 우선순위: phase45 revision (t≠null) → phase3 → chat AI message
- 스크롤 fallback (`rect.top < window.innerHeight/2`) 가정 깨지면 fragile

---

## §11 applied-from-batch 추적 (L2910–2984)

**목적.** 배치 자동 적용 추적(djb2 해시 + runId). 사용자 수동 변경 시 drift 감지. orphan GC.

**주요 entry point.**
- `hashTextShort(s)` — djb2 32-bit
- `loadAppliedFromBatch()`, `saveAppliedFromBatch()`
- `recordAppliedFromBatch(stringId, runId, phase, text)`
- `getAppliedFromBatch(stringId)`, `clearAppliedFromBatch(stringId)`
- `clearAppliedFromBatchByRunId(runId)`
- `pruneAppliedFromBatchOrphans(allowedRunIds)` (v0.7.37)

**주의사항.**
- v0.7.36 #D10-P2: run 삭제 시 applied 자동 정리
- v0.7.37 #D11-P3: skipGc 경로용 별도 prune 헬퍼
- 해시 collision 가능 (4B 분의 1) — 보조 검증 없음

---

## §12 리뷰 override (L2985–3139)

**목적.** (runId, stringId) 키 사용자 override 저장. 임계마다 IDB 백업 트리거. orphan GC.

**주요 entry point.**
- `loadReviewOverrides()`, `saveReviewOverrides(map)` (boolean 반환)
- `getReviewOverride(runId, stringId)`, `setReviewOverride(runId, stringId, text)`
- `clearReviewOverride(runId, stringId)`, `clearOverridesForRun(runId)`
- `countReviewOverridesForRun(runId)` — phase re-run 가드용
- `gcOrphanReviewOverrides()` → `{removedRunIds, removedItems, totalItemsRemoved, runIdsKept}`
- `nullifyDanglingImportedFromRunId(runId)`

**데이터 구조.**
- `{[runId]: {[stringId]: {text, updatedAt} | string(legacy)}}`
- 카운터 `OVERRIDE_WRITE_COUNTER`, threshold 10

**주의사항.**
- v0.7.7 #12: 카운터 기반 백업 트리거
- v0.7.21 #B2: `saveReviewOverrides` boolean 반환
- v0.7.32 #D6-P2-11: GC 시 dangling override + importedFromRunId 정리
- 레거시 string→object on read (in-place 마이그 없음)

---

## §13 batch → chat 시드 (L3236–3319)

**목적.** 배치 결과(Phase 3 또는 4+5) + 형제 세그먼트(최대 5) + TB + 글자수로 채팅 시드.

**주요 entry point.**
- `importBatchResultToChat(stringId, run, options = {phase: 'auto'})`

**주의사항.**
- auto: phase45.validation.ok이면 phase45, 아니면 phase3
- v0.7.8 #3: 같은 gid 형제 5개 reference (revision changed 시 revision, 아니면 phase3)
- system 메시지에 runId 클릭 가능 태그 (review jump)

---

## §14a / §14b 컨텍스트 & 프롬프트 조립 (L3321–3393)

**목적.** segment → readable 텍스트 (§14a). system + seed + context + history + user → 최종 prefix_prompt (§14b).

**주요 entry point.**
- `buildSegmentContext(segment)` — `[원문] [글자수 제한] [용어집] [Context ID]`
- `buildPrefixPrompt(systemPrompt, segmentContext, history, userMessage, sessionSystem)`

**주의사항.**
- v0.3.3: workflow 모드(`[WORKFLOW_MODE]` / `CURRENT_PHASE` 포함)는 OUTPUT_RULE 추가 안 함

---

## §15 Batch workflow state + prompt builders (L3394–4005)

**목적.** 배치 run 객체 lifecycle, phase 실행기, prompt builder, GC, attempt_id, lease.

**주요 entry point.**
- `loadBatchRuns()`, `saveBatchRuns(runs, {skipGc})`
- `getActiveBatchRunId()`, `setActiveBatchRunId(runId)`
- `makeBatchRunId(params)` — `yyyyMMddHHmmssMMM-p{pid}-f{fid}-l{lid}-{rand4}`
- `makeAttemptId()` — phase별 echo check
- `persistBatchRun()`, `persistBatchRunDebounced()`
- `createBatchRunBase()`, `ensureBatchRun()`
- `setBatchStatus(status)`, `appendBatchLog(message, type)`
- `fetchCurrentPageSegments(run)`
- `onBatchCollect()`, `onRunBatchPhase(phase)` (~200줄), `onBatchRefetchResult()`, `onBatchReset()`
- `getWorkflowBasePrompt(phaseTag)` — slot → chat 폴백
- `getActiveCategories()` — Phase1+2 결과 파싱
- `buildActiveCategoryGuidelinesBlock(activeIds, {checklistOnly})` — Phase 3/4+5 주입 (v0.7.46 checklistOnly)
- `withBatchLock(fn)` — 전역 mutex
- `refreshCategoryTokenMeter()` — 토큰 미터 (v0.7.47)

**데이터 구조.**
```
run = {
  runId, projectId, fileId, languageId, page, pageSize, model, scope: 'current_page',
  status: 'idle'|'segment_fetching'|'phase{12|3|45}_{running|ready}'|'stale',
  segments, notesByStringId, storageStringId, initialStorageRaw, tbSummary,
  phase12: {raw, parsed, validation} | null,
  phase3:  {raw, parsed: {translations: [{id, t, gid}]}, validation} | null,
  phase45: {raw, parsed: {revisions:    [{id, t|null, r, gid}]}, validation} | null,
  validations, logs: [{at, type, message}], lastExpectedPhase, lastError,
  activeCategoryIds, createdAt, updatedAt,
  promptLog?: [...]  // verbose toggle ON 시 phase당 최근 3건
}
```

**주의사항.**
- `BATCH_RUNS_LIMIT = 10` GC (active 항상 유지)
- v0.7.18 #4: persist 실패(quota) → throw / toast
- v0.7.33 #D7: attempt_id echo 검증
- v0.7.34 #D8: cross-tab lease + active hijack 방지
- v0.7.37 #D11: refetch/collect fail-closed + beforeunload lease 해제 + applied GC on overwrite
- v0.7.38 #D12: activeCategoryIds 추출
- v0.7.40: 카테고리 enable toggle 반영
- v0.7.42: verbose prompt log
- v0.7.43/44: phase 슬롯 + Frame
- v0.7.46: Phase 4+5는 체크리스트만 주입 (`checklistOnly:true`)

---

## §16 모달 UI (L4006–5393)

**목적.** 모달 HTML 템플릿 + CSS. 4 메인 탭(채팅/배치/검토/로그). 탭 전환 인프라.

**주요 entry point.**
- `createModal()` (factory)
- `modalEl` (cached)
- `setMainTab(tabName)`
- 컨텐츠 렌더러: `renderChatHistory()`, `renderBatchRun()`, `renderReviewTable()`, `renderLogOutput()`

**주의사항.**
- 모든 탭이 DOM에 존재(display:none 토글)
- 헤더에 `tw-seg-info` (좁은 화면 overflow 위험)

---

## §17 이벤트 핸들러 (L5394–8066)

**목적.** `attachHandlers(el)`로 모달 모든 버튼/입력/탭 리스너 등록.

**주요 entry point (대표).**
- 채팅: `onSend`, `onResetSession`, `onAdoptTranslation`, `onChatMessageAction`
- 배치: `onBatchCollect`, `onRunBatchPhase`, `onBatchRefetchResult`, `onBatchReset`
- 검토: `applyBatchTranslationsByIds`, `onReviewOverrideGc`, `onToggleFailedOnly`
- 토글: 메인탭, compact mode, prompt log toggle, settings

**주의사항.**
- compact mode + prompt log toggle 패턴 중복 (DRY 후보)
- review apply 핸들러 3종 패턴 중복

---

## §18 모달 Show/Hide + 자동 감지 (L8067–8259)

**목적.** showModal/hideModal, segment 자동 감지(0.5s polling, epoch 가드), `loadSegmentInfo` race 가드.

**주요 entry point.**
- `showModal()` — schema 체크 → IDB restore prompt → session prune → batch sync → render
- `hideModal()`
- `loadSegmentInfo(stringId)` — token+epoch race 가드
- `startSegmentWatcher()`, `stopSegmentWatcher()`

**주의사항.**
- v0.7.22 #C1-P1-7: token+stringId stale 가드
- v0.7.29 #D3-P1-7: `currentSegment = null` 진입 초기화
- watcher 폴링 500ms 하드코드

---

## §19 채팅 흐름 (L8260–8646)

**목적.** 채팅 메시지 렌더, snapshot 가드 send, 인라인 액션, adopt.

**주요 entry point.**
- `renderChatHistory()` — batch_import source면 seed system 메시지 + runId 태그
- `appendMessage(role, content)`, `updateProgressMessage()`, `updateAdoptButton()`
- `onSend()` — snapshot stringId/segment, API, result fetch, session save
- `onResetSession()`, `onAdoptTranslation()`
- `onChatMessageAction(e)` — 인라인 apply / override / copy

**주의사항.**
- v0.7.18 #1: requestStringId/Segment snapshot (watcher 변경에도 안전)
- v0.7.22 #C1-P1-10: setSession 전 reload (수동 편집 보호)
- v0.7.29 #D3-P1-7: `currentSegment` null 후 onSend에서 segId vs requestStringId 재확인
- v0.7.32 #D6-P2-9: adopt/apply는 strict textarea 탐색

---

## §20 설정 패널 (L8647–10138)

**목적.** 3-탭 overlay: 시스템 프롬프트 / 카테고리 가이드라인 / 워크스페이스(세션·run·override·IDB·activity·danger zone).

**주요 entry point.**
- `showSettingsPanel()` (overlay 생성 + handler attach)
- `refreshSystemPrompts()`, `refreshPhasePromptSlots()`, `refreshCategoryGuidelines()`, `refreshWorkspaceUi()`
- `refreshCategoryTokenMeter()` (v0.7.47)
- 카테고리: search, single-expand 카드 그리드, inline editor (400ms debounce save)
- 워크스페이스: 세션 prune/clear, run GC, override GC, IDB 슬롯, backup/restore, export/import, danger zone (factory reset)

**주의사항.**
- v0.7.40: enable toggle UI
- v0.7.42: verbose prompt log toggle + 설명 toast
- v0.7.43: phase 슬롯 preview 버튼
- v0.7.47: 토큰 미터 (Phase 1+2 / 3 / 4+5 셀, 30k warn / 60k danger)
- v0.7.48: 단일 💬 배지 (chat/batch 분리 폐기)

---

## §21 단축키 + 디버그 surface (L10139–10250)

**목적.** Alt+Z 토글, `window.tmsWorkflow` 안정 API, `window.tmsActivity`/`tmsLog` 디버그 surface (opt-in).

**주요 entry point.**
- 글로벌 keydown 리스너 — Alt+Z (`key === 'z'|'Z'|'Ω'`)
- `window.tmsWorkflow.open() / close() / version` — 항상 노출
- 디버그 surface 게이트 (`tms_workflow_debug_surface === 'on'`)에서만 노출:
  - `window.tmsWorkflow.getCurrentStringId()` 등
  - `window.tmsActivity.get()`, `window.tmsActivity.clear()`
  - `window.tmsLog(level)`
- 콘솔 banner — `[TMS Workflow v${SCRIPT_VERSION}]`

**주의사항.**
- v0.7.26 #C5-P1-18 → v0.7.36 #D10-P2: opt-out → opt-in 전환
- INPUT 포커스 시 차단, TEXTAREA는 허용
- showModal 실패 시 `alert()` (toast 아닌 점 주의)
