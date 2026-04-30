# TMS CAT Tool Userscript — 알려진 이슈 / 개선 후보 (v0.7.48 기준)

서브에이전트 코드 리뷰(2026-04 시점)로 식별한 이슈 카탈로그. 향후 패치 우선순위 기준 자료.
관련 문서: [architecture-overview.md](architecture-overview.md), [section-reference.md](section-reference.md).

운영 원칙:
- 실제 패치 시 본 표의 행을 issue 트래커 또는 commit 메시지에 인용한다.
- 패치 완료 시 본 문서에서 행을 제거(또는 "✅ {commit hash}" 표시)한다.
- 신규 발견 항목은 동일 포맷으로 추가하고 라인 번호는 발견 시점 기준으로 적는다.
- 라인 번호는 ±10줄 표류 가능 — `git blame` / grep으로 재확인 후 수정한다.

---

## High severity (구조·디자인 큰 변경 필요)

| § | 라인 | 분류 | 내용 | 권장 조치 |
|---|---|---|---|---|
| §9 | 2540–2600 | 유지보수 | `BATCH_PHASE_FRAME` + `BATCH_PHASE_PROMPT_DEFAULTS`가 코드 하드코드. V3.1 spec 변경 시 재배포 필요 | JSON 외부 설정으로 분리 (서버 또는 LS 폴백). 마이그 step 동반 |
| §15 | 3550–3570 | 모놀리스 | `onRunBatchPhase`가 ~200줄 단일 함수 (수집+검증+API+poll+parse+에러). 단위 테스트 어렵다 | phase별 sub-함수로 분해 (`collectSegments`, `runPhase12`, `runPhase3`, `runPhase45`, `parseResult`) |
| §20 | 8750–8820 | 가시성 | 프롬프트 리스트/에디터 HTML이 서브에이전트 뷰에서 잘림 — 실제 구현 전체 검증 필요 | 전체 HTML 구조 문서화 + 컴포넌트 테스트 |

---

## Medium severity (안전성·정합성 잠재 위험)

| § | 라인 | 분류 | 내용 | 권장 조치 |
|---|---|---|---|---|
| §1 | 89 | 아키텍처 | `SCHEMA_MIGRATIONS`가 비어 있고 step 등록 강제 메커니즘 없음 | pre-commit 체크: `CURRENT_SCHEMA_VERSION` bump 시 step 추가 강제 |
| §2 | 239–254 | 격리 | 손상 LS 항목이 `__tms_corrupted_*`로 영구 격리 → 손상 반복 시 quota 압박 | N일 경과 quarantine 키 자동 정리 |
| §4 | 640–670 | 취약성 | `fetchBatchNotes` 100건 chunk가 매직 넘버. adaptive batching 없음 | 502 응답 모니터 + 이진 탐색으로 chunk 사이즈 결정 |
| §5 | 749–790 | 디자인 | `TOKEN_PATTERN` 단일 모놀리식 정규식. 신규 토큰 추가 시 전체 회귀 위험 | 서브 패턴 배열로 컴포저블 리팩터 |
| §5 | 1203–1211 | hanja 검증 | `\p{Script=Han}/u`가 의도와 달리 Hiragana/Katakana/Hangul 포함 가능 — 테스트 부족 | Han Extensions A-G 경계 explicit test, Hiragana/Katakana/Hangul 제외 의도 확인 |
| §6 | 1428 | i18n | placeholder `请输入译文` 하드코드. TMS 다국어 UI 시 깨짐 | data attribute 기반 탐색 (예: `data-tms-lang-input`) |
| §8 | 2115 | 복원 | IDB 사용 불가가 reject promise로 영구 캐시. 폴백/재시도 없음 | LS-only 폴백 또는 사용자 경고; 주기적 health check |
| §9 | 2490–2510 | 마이그 | 카테고리 ID 검증: 미래 ID(예: 99) silently drop. 버전 패스 없음 | snapshot에 `CATEGORY_ID_SET` 버전 저장, load 시 검증, 업그레이드 절차 문서화 |
| §15 | 3560–3590 | race | API 호출 후 phase 상태 재확인. 네트워크 지연 시 stale 결과 가능 | explicit 재시도 루프; timeout/retry 한도 문서화 |
| §21 | 10147 | 키 감지 | Alt+Z `key==='z'/'Z'/'Ω'` — 일부 레이아웃 미지원 가능 | `e.code === 'KeyZ'` (layout-agnostic)로 전환 |

---

## Low severity (DRY · 가독성 · 작은 UX)

### §1 / §2 / §3 (인프라)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| §1 L104 | 매직 넘버 | `SESSION_BACKUP_THRESHOLD=30` 근거 미문서화 | 문서화 또는 settings 노출 |
| §2 L227–235 | 에러 | `parseRequiredInt` 에러에 param 이름 누락 | 메시지에 이름 포함 |
| §2 L299–339 | 디자인 | `twConfirm`이 child input의 Enter도 닫음 | 가드 추가 또는 문서화 |
| §3 L401 | 성능 | `JSON.parse(JSON.stringify(meta))` 매번 호출 | type 분기 후 selective copy |
| §3 L430 | 게이트 | `debugSurface === 'on'` 정확 일치 — 오타 무음 비활성 | 값 오타 시 toast 경고 |

### §4 / §5 (API · 검증)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| §4 L616 | 정규화 | `normalizeId`가 비-string 반환 시 비교 불안정 | post-normalize 타입 assert |
| §4 L656–677 | 에러 처리 | `fetchOk` 플래그 — 상위 호출자 미체크 가능 | lint 또는 assert |
| §5 L856–867 | 검증 | placeholder count만 체크 — 중복 토큰 순서 보장 부족 | dedicated 중복 토큰 순서 테스트 |

### §6 / §7 (DOM · 세션)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| §6 L1412 | 타입 | `data-key` 정규식이 string 반환 — caller가 `normalizeId` 호출 전제 | internal 화 또는 type assert |
| §6 L1433 | 안전 | `findTranslationTextarea` fallback이 nested editor에서 오선택 가능 | DOM tree depth 우선 또는 data 속성 |
| §7 L1502 | 로깅 | 손상 SESSIONS silently `{}` — 토스트/log 없음 | logActivity warn 추가 |
| §7 L1526 | 설정 | `SESSION_TTL_DAYS` 하드코드 | settings 튜닝 노출 |
| §7 L1521–1540 | edge | 시스템 시계 역행 시 TTL 음수 | age<0 가드 |
| §7 L1567 | 에러 | `getWorkspaceStats` 부분 실패가 silently null | per-call try-catch + error flag |

### §8 (IDB 백업)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| L2130–2131 | 캐싱 | reject promise 영구 캐시 → IDB 회복 시 백업 영구 불가 | 주기 health check로 reset |
| L2165 | 취약성 | 수동 transaction handler — error path 누락 위험 | Promise wrap + timeout |
| L2183 | 정렬 | `getLatestBackupSnapshot`가 `savedAt` 문자열 정렬 | ISO assert + timestamp fallback |
| L2214 | 아카이브 | `_stripRunForBackup`가 segments/promptLog 강제 제외 | `includeRaw` 옵션 (default false) |

### §9 (시스템 프롬프트)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| L2460–2462 | 침묵 | `loadPrompts` 손상 시 silent 복구 | logActivity warn |
| L2547 | 강제 변환 | `loadCategoryGuidelinesEnabled`가 `!!enabled` — 비-boolean LS 값 truthy 위험 | explicit boolean check |

### §10/10b/10c (활성 세그먼트)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| L2776 | 휴리스틱 | scroll fallback이 grid layout 가정 깨짐 | `rect.left` 기반 grid fallback |
| L2790 | 견고성 | 마지막 자릿수 fallback `(\d+)$` — 위험 | stringItem 매칭만 허용 |
| L2900 | 명확성 | finalCandidate 우선순위 불투명 (`t===null` = "keep phase3" 암묵) | explicit `status` 플래그 |

### §11 / §12 (applied · override)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| §11 L2916–2920 | 충돌 | djb2 collision (4B 분의 1) — 보조 검증 없음 | text length 보조 필드 |
| §11 L2947–2955 | 스키마 | 레거시 in-place 마이그 없음 — LS 영구 inflated | one-time 마이그 스크립트 |
| §11 L2969–2977 | 성능 | `pruneOrphans`: Array → Set O(n) | 계약상 Set 강제 + assert |
| §11 L2982 | 모호 | rid=null이 legacy인지 실제값인지 구분 불가 | migration flag/version 필드 |
| §12 L3007 | 스키마 | §11과 동일 (in-place 미마이그) | 동일 one-time 스크립트 |
| §12 L3087–3100 | 쿼리 | `gcOrphanOverrides`가 `BATCH_RUNS` 키와 cross-check 없음 | GC 전 fetch + 검증 |
| §12 L3095–3110 | 디자인 | activeRunId가 stale이면 GC가 그 override 보존 | 계약 문서화: activeRunId∈BATCH_RUNS or null |
| §12 L3037–3050 | 가드 | `countReviewOverridesForRun` re-run 가드 — 의도 모호 | clarify: phase45 in-progress 시만 |

### §13 / §14 / §15 (조립 · 워크플로우)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| §13 L3241–3245 | 에러 | `importBatchResultToChat` 결과 없으면 throw | `allowFallback=true` 옵션 |
| §14a L3345 | 라벨 | context ID 라벨 누락 | `[Context ID]` prefix |
| §14b L3377–3384 | 감지 | workflow 모드 substring 검색 — fragile | explicit `{isWorkflowMode}` 플래그 |
| §15 L3503–3525 | GC | `BATCH_RUNS_LIMIT=10` 매직 넘버 | settings 노출 + GC trigger 토스트 |
| §15 L3503 | GC | `skipGc`가 restore/import 한정 — 직접 save에서 일관성 부족 | 계약 문서화 + assert |
| §15 L3535 | 랜덤 | `makeBatchRunId` rand4가 random<0.001 시 4자 미만 (padEnd 보정) — off-by-one 위험 | post-slice length assert |
| §15 L3628 | 검증 | Phase 1+2 추출 `activeCategoryIds`가 `CATEGORY_ID_SET` 미검증 | filter로 검증 |

### §16 / §17 (UI · 핸들러)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| §16 L4020 | 반응형 | `tw-seg-info` 헤더가 모바일 미고려 | breakpoint + collapsible |
| §16 L4045–4100 | 성능 | 모든 탭 미리 렌더 | review 탭 lazy / virtual scroll |
| §17 L5450–5520 | DRY | compact mode + prompt log toggle 패턴 중복 | `toggleLsFlag(key, on, off)` 헬퍼 |
| §17 L5479–5485 | DRY | applySelected/All/Edited 패턴 중복 | `applyBatchAndRender(filterFn)` |

### §18 / §19 (Show/Hide · 채팅)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| §18 L8088 | 타입 | watcher token 무한 증가 — overflow 비현실적이지만 가능 | BigInt 또는 overflow assert |
| §18 L8110 | 폴링 | 500ms 하드코드 | settings 노출 |
| §18 L8135–8145 | 성능 | 모달 open마다 schema/IDB/prune 모두 실행 | 캐시 전략 (per-session/per-day) |
| §18 L8160–8180 | XSS 위험 | inline 템플릿 — escapeHtml 누락 가능 | `renderSegmentContext` 함수로 집중 |
| §19 L8310–8320 | race | runId 태그 삽입이 "시드됨" 텍스트 검색 의존 | DOM 노드 직접 append |
| §19 L8380–8410 | 렌더 | onSend 도중 모달 닫히면 detached DOM 갱신 | `modalEl.contains(progressMsg)` 체크 |
| §19 L8430–8440 | 로직 | `requestSegment.id` 누락 시 normalizeId undefined → 모호 에러 | explicit null check |
| §19 L8450 | 상태 | `getSession(currentStringId)`가 다른 탭의 수동 편집을 가져올 수 있음 | requestStringId snapshot 사용 + 주석 |
| §19 L8510–8540 | 에러 | `fetchOk` 미체크 시 raw='' silent 처리 | fetchOk 체크 후 throw |

### §20 / §21 (설정 · 단축키)
| 라인 | 분류 | 내용 | 권장 |
|---|---|---|---|
| §20 L8900–8950 | 동기화 | 카테고리 enable 토글이 LS 손상 시 재동기 없음 | save 후 LS 값과 checkbox 일치 확인 |
| §20 L8995–9005 | race | single-expand 카드 빠른 클릭 race | debounce 또는 expand lock |
| §20 L9100–9150 | UX | 카테고리 텍스트에리어 400ms debounce — 사용자 이탈 시 손실 | "unsaved *" 인디케이터 + tab close flush |
| §20 L9200–9250 | 성능 | 워크스페이스 stats 매 탭 전환마다 재계산 | 캐시 + 변경 시만 무효화 |
| §20 L9300+ | 신뢰 | "사전 백업 자동" 문구 — 실제 코드 미확인 | reset 전 명시적 backup flush + 토스트 확인 |
| §21 L10165–10175 | 문서 | "정책 C" 언급, 정책 A/B 미가시 | 모든 정책 문서화 |
| §21 L10185 | UX | `showModal` 실패 시 `alert()` | toast / corner 노티 |
| §21 L10212–10220 | 캐싱 | `tms_workflow_debug_surface` 다중 try-catch 반복 조회 | top-level 캐시 |

---

## 패치 시 체크리스트 (제안)

1. 본 문서에서 대상 행 제거 또는 ✅ 표시 + commit hash 기재
2. 라인 번호 수정 (가능하면 grep으로 anchor 재확인)
3. `tests/`에 회귀 테스트 추가 (특히 race · validation · 마이그 영역)
4. 마이그 동반 변경은 `CURRENT_SCHEMA_VERSION` bump + `SCHEMA_MIGRATIONS` step
5. 주석에 `v0.7.x` prefix로 변경 anchor 남기기 (다음 minor 까지 유지)
