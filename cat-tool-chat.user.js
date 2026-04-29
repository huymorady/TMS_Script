// ==UserScript==
// @name         TMS CAT Tool - 대화형 번역 워크플로우
// @namespace    https://github.com/huymorady/TMS_Script
// @version      0.7.10
// @description  Alt+Z로 대화형 AI 번역 워크플로우 모달 오픈 (TMS의 prefix_prompt_tran API 활용)
// @match        https://tms.skyunion.net/*
// @updateURL    https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-chat.user.js
// @downloadURL  https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-chat.user.js
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ========================================================================
    // 상수 & 설정
    // ========================================================================
    const LS_KEYS = {
        SYSTEM_PROMPTS: 'tms_workflow_system_prompts_v1',
        ACTIVE_PROMPT_ID: 'tms_workflow_active_prompt_v1', // legacy: v0.4.0 마이그레이션 폴백용. 신규 코드는 CHAT/BATCH ID를 사용.
        CHAT_ACTIVE_PROMPT_ID: 'tms_workflow_chat_active_prompt_v1',
        BATCH_ACTIVE_PROMPT_ID: 'tms_workflow_batch_active_prompt_v1',
        PROMPT_LOCK_LINKED: 'tms_workflow_prompt_lock_v1',
        SESSIONS: 'tms_workflow_sessions_v1',
        MODEL: 'tms_workflow_model_v1',
        MODAL_POS: 'tms_workflow_modal_pos_v1',
        MODAL_SIZE: 'tms_workflow_modal_size_v1',
        BATCH_RUNS: 'tms_workflow_batch_runs_v1',
        ACTIVE_BATCH_RUN: 'tms_workflow_active_batch_run_v1',
        APPLIED_FROM_BATCH: 'tms_workflow_applied_from_batch_v1', // v0.6.0 L3: textarea가 배치에서 자동 적용된 세그먼트 추적
        REVIEW_OVERRIDES: 'tms_workflow_review_overrides_v1', // v0.6.2: 사용자가 리뷰 탭에서 직접 수정한 최종 후보 (run+id 키)
        COMPACT_MODE: 'tms_workflow_compact_mode_v1', // v0.7.6 (#4): 배치 패널 컴팩트 모드 (stepper + 카드 접기)
        SCHEMA_VERSION: 'tms_workflow_schema_version', // v0.7.7 (#10): LS 스키마 버전 가드 (정수). 향후 마이그레이션 분기점.
        BACKUP_NEXT_SLOT: 'tms_workflow_backup_next_slot', // v0.7.7 (#12): IDB ring 안의 다음 쓸 slot 인덱스 (0..N-1)
        OVERRIDE_WRITE_COUNTER: 'tms_workflow_override_write_counter', // v0.7.7 (#12): override 쓰기 누적 카운터 (threshold마다 backup trigger)
    };

    // v0.7.7 (#10): 현재 스키마 버전. 신규 LS key/필드를 추가하거나 기존 구조를 변경할 때 +1.
    // 마이그레이션 step은 SCHEMA_MIGRATIONS에 등록한다 (현재는 비어 있음 — infra만 도입).
    const CURRENT_SCHEMA_VERSION = 1;
    const SCHEMA_MIGRATIONS = {
        // 예: 2: function migrateTo2() { /* mutate LS keys */ },
    };

    // v0.7.7 (#12): IndexedDB ring 백업 설정. LS 손실(quota/수동 삭제/다른 유저스크립트 충돌) 시 복구용.
    // 대상: REVIEW_OVERRIDES 전체 + BATCH_RUNS (raw 제외) + SESSIONS 전체. raw segments/raw LLM 응답은 백업하지 않음 (크기 이유).
    // trigger: override 수정 누적 OVERRIDE_BACKUP_THRESHOLD회 또는 phase45 완료.
    const BACKUP_DB_NAME = 'tms-workflow-backup';
    const BACKUP_DB_VERSION = 1;
    const BACKUP_STORE = 'snapshots';
    const BACKUP_SLOT_COUNT = 5;
    const OVERRIDE_BACKUP_THRESHOLD = 10;

    const DEFAULT_PROMPT = {
        id: 'default',
        name: '기본',
        content: '',
    };

    const MODELS = ['claude-sonnet-4-6', 'gpt-5.2-chat', 'deepseek-v3'];

    // 세션 관리 설정
    const SESSION_TTL_DAYS = 30;        // 30일 지난 세션은 자동 삭제
    const SESSION_CHECK_INTERVAL = 500; // ms, 세그먼트 변경 감지 폴링 주기
    const BATCH_DEFAULT_PAGE_SIZE = 50;
    // localStorage quota 보호용: 최근 N개 run만 보관. activeRunId는 잘리지 않음.
    const BATCH_RUNS_LIMIT = 10;
    // appendBatchLog 핫패스에서 LS쓰기를 묶어 처리하기 위한 디바운스 간격 (ms).
    const BATCH_LOG_PERSIST_DEBOUNCE_MS = 400;
    const BATCH_POLL_INTERVAL_MS = 5000;
    const BATCH_MAX_POLL_ATTEMPTS = 90;
    const BATCH_RESULT_RETRY_INTERVAL_MS = 2000;
    const BATCH_RESULT_RETRY_ATTEMPTS = 30;
    // BATCH_STATUS_LABELS: 실제 사용되는 batchRun.status값 모음.
    // - idle / collecting / ready: 초기~수집 단계
    // - phase12_ready / phase3_ready / phase45_ready: 각 Phase 완료 단계 (검증 ok=true)
    // - failed / stale: 오류행 혹은 저장본 불일치
    const BATCH_STATUS_LABELS = {
        idle: '대기 중',
        collecting: '수집 중',
        ready: '수집 완료',
        phase12_running: 'Phase 1+2 실행 중',
        phase12_ready: 'Phase 1+2 완료',
        phase3_running: 'Phase 3 실행 중',
        phase3_ready: 'Phase 3 완료',
        phase45_running: 'Phase 4+5 실행 중',
        phase45_ready: 'Phase 4+5 완료',
        failed: '오류',
        stale: '저장본 불일치',
    };

    // 번역 입력창 셀렉터 후보 (TMS UI에 맞게 여러 패턴 시도)
    // 현재 포커스 된 textarea를 "번역 입력창"으로 간주하는 정책
    const TRANSLATION_TEXTAREA_HINTS = [
        'textarea[placeholder*="翻译"]',
        'textarea[placeholder*="translation" i]',
        'textarea.translation-input',
        '.cat-tool-translation textarea',
        'tr.active textarea',
        'tr.selected textarea',
    ];

    // 출력 강제 규칙 (LLM이 설명 붙이는 것 방지)
    const OUTPUT_RULE = `
=== 필수 출력 규칙 ===
- 오직 한국어 번역문만 출력하세요.
- 설명, 해설, 주석, 마크다운(**, *, #, etc.), 한자 병기, 괄호 설명을 일체 금지합니다.
- 코드펜스(\`\`\`), 양끝 따옴표 감싸기, '번역:' / '번역 결과:' 같은 라벨도 출력하지 마세요.
- 원문에 있던 플레이스홀더(%s, {0}, \\n 등)와 태그는 그대로 유지하세요.`.trim();

    // ========================================================================
    // 유틸리티
    // ========================================================================
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function getCsrfToken() {
        const m = document.cookie.match(/csrftoken=([^;]+)/);
        return m ? m[1] : null;
    }

    function getUrlParams() {
        // URL hash: #/translating?projectId=237&fileId=26179&languageId=27&...
        const hashQuery = location.hash.split('?')[1] || '';
        const p = new URLSearchParams(hashQuery);
        return {
            projectId: p.get('projectId'),
            fileId: p.get('fileId'),
            languageId: p.get('languageId'),
            projectName: p.get('projectName'),
            fileName: p.get('fileName'),
            page: p.get('page') || '1',
            pageSize: p.get('pageSize') || p.get('page_size') || String(BATCH_DEFAULT_PAGE_SIZE),
        };
    }

    function parseRequiredInt(value, label) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) {
            throw new Error(`${label} 값을 URL에서 확인하지 못했습니다.`);
        }
        return n;
    }

    function lsGet(key, def = null) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
        catch { return def; }
    }
    function lsSet(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); }
        catch (e) { console.error('[TMS Workflow] localStorage write failed', e); }
    }

    // v0.7.7 (#10): LS 스키마 버전 가드.
    // - 저장된 버전이 없으면(=신규 설치 또는 v0.7.6 이전) CURRENT로 도장만 찍는다.
    // - 저장 버전 < CURRENT: SCHEMA_MIGRATIONS의 step을 순서대로 실행 후 도장 갱신.
    // - 저장 버전 > CURRENT: 다운그레이드 시나리오. 스키마 변경 없이 경고만 남긴다 (데이터 보존 우선).
    function ensureSchemaVersion() {
        let stored;
        try { stored = lsGet(LS_KEYS.SCHEMA_VERSION, null); } catch { stored = null; }
        if (stored == null) {
            lsSet(LS_KEYS.SCHEMA_VERSION, CURRENT_SCHEMA_VERSION);
            return { migrated: false, from: null, to: CURRENT_SCHEMA_VERSION };
        }
        const from = Number(stored);
        if (!Number.isInteger(from) || from < 0) {
            console.warn('[TMS Workflow] schema version invalid, resetting to current', stored);
            lsSet(LS_KEYS.SCHEMA_VERSION, CURRENT_SCHEMA_VERSION);
            return { migrated: false, from: null, to: CURRENT_SCHEMA_VERSION };
        }
        if (from > CURRENT_SCHEMA_VERSION) {
            console.warn(`[TMS Workflow] stored schema (v${from}) is newer than this script (v${CURRENT_SCHEMA_VERSION}). 데이터 변경 없이 진행합니다.`);
            return { migrated: false, from, to: from, downgrade: true };
        }
        if (from === CURRENT_SCHEMA_VERSION) {
            return { migrated: false, from, to: from };
        }
        // from < CURRENT: 마이그레이션 실행
        let cur = from;
        while (cur < CURRENT_SCHEMA_VERSION) {
            const next = cur + 1;
            const step = SCHEMA_MIGRATIONS[next];
            if (typeof step !== 'function') {
                console.warn(`[TMS Workflow] migration step v${next} 없음 — 스키마 도장만 갱신합니다.`);
                cur = next;
                continue;
            }
            try {
                step();
                cur = next;
            } catch (e) {
                console.error(`[TMS Workflow] migration v${cur}→v${next} 실패`, e);
                // 실패 시 도장 갱신 중단 → 다음 실행에서 재시도
                lsSet(LS_KEYS.SCHEMA_VERSION, cur);
                return { migrated: true, from, to: cur, error: e };
            }
        }
        lsSet(LS_KEYS.SCHEMA_VERSION, cur);
        return { migrated: true, from, to: cur };
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function toast(msg, type = 'info', ms = 3000) {
        // 기존 API Logger의 catToast 재사용 가능하면 사용
        if (window.catToast && typeof window.catToast[type] === 'function') {
            window.catToast[type](msg);
            return;
        }
        // 폴백: 간단한 자체 토스트 (v0.6.7 D2: 색상은 모달의 design token과 동일)
        const PALETTE = { error: '#e74c3c', success: '#27ae60', warn: '#fbbf24', info: '#3498db' };
        const bg = PALETTE[type] || PALETTE.info;
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = `
            position:fixed; top:20px; right:20px; z-index:999999;
            padding:10px 16px; border-radius:6px; color:#fff;
            font-size:13px; font-family:system-ui;
            background:${bg};
            box-shadow:0 4px 12px rgba(0,0,0,0.2);
        `;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), ms);
    }

    // v0.7.5: 로그 레벨 가드 — localStorage 'tms_workflow_log_level' (silent/error/warn/info/verbose)
    // 기본은 'warn' — info/verbose 는 디버깅 시에만. dverbose/dinfo/dwarn/derror 헬퍼로 wrap.
    const LOG_LEVEL_RANK = { silent: 0, error: 1, warn: 2, info: 3, verbose: 4 };
    const LOG_TAG = '[TMS-WF]';
    function getLogRank() {
        let lvl = 'warn';
        try {
            const stored = localStorage.getItem('tms_workflow_log_level');
            if (stored && LOG_LEVEL_RANK[stored] != null) lvl = stored;
        } catch {}
        return LOG_LEVEL_RANK[lvl];
    }
    let LOG_RANK = getLogRank();
    function dverbose(...args) { if (LOG_RANK >= 4) console.log(LOG_TAG, ...args); }
    function dinfo(...args) { if (LOG_RANK >= 3) console.log(LOG_TAG, ...args); }
    function dwarn(...args) { if (LOG_RANK >= 2) console.warn(LOG_TAG, ...args); }
    function derror(...args) { if (LOG_RANK >= 1) console.error(LOG_TAG, ...args); }

    // v0.7.7 (#13): 민감 데이터 마스킹.
    // 에러 메시지가 toast/배치 로그/스크린샷으로 새어나갈 때 응답 본문을 그대로 노출하지 않는다.
    // - 기본: { length, hash, head: 첫 N자 } 요약 문자열 반환
    // - verbose 모드(LOG_RANK >= 4): 원문 그대로 반환 (디버깅용)
    // hash는 의존성 없이 빠른 djb2 32bit hex (식별/대조용, 보안용 아님)
    function maskSensitive(value, { headChars = 80, force = false } = {}) {
        if (value == null) return '<null>';
        const s = typeof value === 'string' ? value : (() => {
            try { return JSON.stringify(value); } catch { return String(value); }
        })();
        if (!force && LOG_RANK >= 4) return s; // verbose: 그대로
        const len = s.length;
        let h = 5381;
        for (let i = 0; i < len; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        const hex = (h >>> 0).toString(16).padStart(8, '0');
        const head = s.slice(0, headChars).replace(/\s+/g, ' ').trim();
        const ellipsis = len > headChars ? '…' : '';
        return `len=${len} hash=${hex} head="${head}${ellipsis}"`;
    }
    // 사용자가 콘솔에서 즉시 토글 — window.tmsLog('verbose') / 'silent' 등
    try {
        window.tmsLog = function (level) {
            if (level && LOG_LEVEL_RANK[level] != null) {
                try { localStorage.setItem('tms_workflow_log_level', level); } catch {}
                LOG_RANK = LOG_LEVEL_RANK[level];
                console.log(LOG_TAG, `log level → ${level}`);
            } else {
                console.log(LOG_TAG, `current level rank=${LOG_RANK}, choices: silent/error/warn/info/verbose`);
            }
        };
    } catch {}

    // v0.7.5: 자체 confirm 모달 — 브라우저 confirm()을 대체. Promise<boolean> 반환.
    // \n 줄바꿈 보존 + 모달 톤 일관성 + Esc/Enter 단축키.
    function twConfirm({ title = '확인', message = '', confirmLabel = '확인', cancelLabel = '취소', danger = false } = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'tw-confirm-overlay';
            const dialog = document.createElement('div');
            dialog.className = 'tw-confirm-dialog' + (danger ? ' tw-confirm-danger' : '');
            const titleEl = document.createElement('div');
            titleEl.className = 'tw-confirm-title';
            titleEl.textContent = title;
            const msgEl = document.createElement('div');
            msgEl.className = 'tw-confirm-message';
            msgEl.textContent = message;
            const btns = document.createElement('div');
            btns.className = 'tw-confirm-buttons';
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'tw-btn tw-btn-ghost tw-confirm-cancel';
            cancelBtn.textContent = cancelLabel;
            const okBtn = document.createElement('button');
            okBtn.className = 'tw-btn ' + (danger ? 'tw-btn-danger' : 'tw-btn-primary') + ' tw-confirm-ok';
            okBtn.textContent = confirmLabel;
            btns.append(cancelBtn, okBtn);
            dialog.append(titleEl, msgEl, btns);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            const cleanup = (val) => {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                resolve(val);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); cleanup(false); }
                else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); cleanup(true); }
            };
            document.addEventListener('keydown', onKey, true);
            cancelBtn.addEventListener('click', () => cleanup(false));
            okBtn.addEventListener('click', () => cleanup(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
            setTimeout(() => okBtn.focus(), 0);
        });
    }

    // ========================================================================
    // API 래퍼
    // ========================================================================
    async function apiJson(url, options = {}) {
        const csrf = getCsrfToken();
        const res = await fetch(url, {
            credentials: 'same-origin',
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': csrf,
                'X-Requested-With': 'XMLHttpRequest',
                ...(options.headers || {}),
            },
        });

        // 컨텐츠 타입 먼저 검사. HTML 에러페이지/로그인 리다이렉트는 res.json()에서
        // SyntaxError로 터져 원인 파악이 어렵다. 명시적 메시지로 교체.
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        const isJson = contentType.includes('application/json') || contentType.includes('+json');
        if (!isJson) {
            const text = await res.text().catch(() => '');
            // v0.7.7 (#13): 응답 본문은 maskSensitive로 요약. verbose 모드에서만 원문 노출.
            const looksLikeLogin = /<form[^>]*login|<title[^>]*\bsign\s*in|csrf|\u767b\u5f55|\ub85c\uadf8\uc778/i.test(text);
            const hint = looksLikeLogin ? ' (로그인 세션 만료 가능성)' : '';
            const summary = maskSensitive(text);
            throw new Error(`API 응답이 JSON이 아닙니다 [${res.status}] content-type=${contentType || 'none'}${hint}: ${summary}`);
        }

        let data;
        try {
            data = await res.json();
        } catch (error) {
            // v0.7.7 (#13): 파서 에러 메시지에는 인덱스 등 위치 힌트가 들어 있어 보통 안전하지만 길이 제한.
            throw new Error(`API JSON 파싱 실패 [${res.status}]: ${maskSensitive(error.message, { headChars: 120 })}`);
        }
        if (!res.ok || data.result === false) {
            // v0.7.7 (#13): server message 자체도 마스킹 (에러 본문에 ID/path 노출 가능)
            const rawMsg = data && (data.message || data.error || data.detail);
            const msgPart = rawMsg ? ` ${maskSensitive(String(rawMsg), { headChars: 160 })}` : '';
            throw new Error(`API 오류: ${res.status}${msgPart}`);
        }
        return data;
    }

    async function fetchSegmentDetail(stringId) {
        const { projectId, fileId, languageId } = getUrlParams();
        const url = `/api/translate/strings/?id=${stringId}&project=${projectId}&target_language=${languageId}&file=${fileId}`;
        const data = await apiJson(url);
        return data.data?.[0] || null;
    }

    async function callPrefixPromptTran(projectId, stringId, prefixPrompt, model) {
        const languageId = parseRequiredInt(getUrlParams().languageId, 'languageId');
        const data = await apiJson(
            `/api/translate/projects/${projectId}/prefix_prompt_tran/`,
            {
                method: 'POST',
                body: JSON.stringify({
                    language_id_list: [languageId],
                    string_id_list: [parseInt(stringId, 10)],
                    prefix_prompt: prefixPrompt,
                    is_associated: true,
                    model,
                }),
            }
        );
        return data.data.task_id;
    }

    // task_results.result 필드는 이중 인코딩된 JSON 문자열. {TOTAL, SUCCESS, FAILURE, PROCESS} 구조.
    // PROCESS는 실시간 완료 카운터(2026-04-23 레퍼런스 확정). STARTED 시점에도 그값이 채워져 온다.
    function parseTaskProgress(rawResult) {
        if (!rawResult || typeof rawResult !== 'string') return null;
        try {
            const parsed = JSON.parse(rawResult);
            if (parsed == null || typeof parsed !== 'object') return null;
            const total = Number(parsed.TOTAL);
            const processed = Number(parsed.PROCESS);
            if (!Number.isFinite(total) || total <= 0) return null;
            const safeProcessed = Number.isFinite(processed) ? Math.max(0, processed) : 0;
            const percent = Math.min(100, Math.round((safeProcessed / total) * 100));
            return {
                processed: safeProcessed,
                total,
                percent,
                success: Number.isFinite(Number(parsed.SUCCESS)) ? Number(parsed.SUCCESS) : null,
                failure: Number.isFinite(Number(parsed.FAILURE)) ? Number(parsed.FAILURE) : null,
            };
        } catch (_e) {
            return null;
        }
    }

    function formatTaskProgress(progress) {
        if (!progress) return '';
        return `${progress.processed}/${progress.total} (${progress.percent}%)`;
    }

    async function pollTask(taskId, { maxAttempts = 20, interval = 5000, onProgress } = {}) {
        for (let i = 0; i < maxAttempts; i++) {
            await sleep(interval);
            const data = await apiJson(`/api/translate/task_results/${taskId}/`);
            const status = data.data.status;
            const progress = parseTaskProgress(data.data.result);
            if (onProgress) onProgress(i + 1, status, progress);
            if (status === 'SUCCESS') return data.data;
            if (status === 'FAILURE') throw new Error(`작업 실패: ${data.data.traceback || '알 수 없음'}`);
        }
        const totalSec = Math.round((maxAttempts * interval) / 1000);
        throw new Error(`폴링 시간 초과 (${totalSec}초, ${maxAttempts}회 시도)`);
    }

    async function fetchActiveResult(stringId) {
        const seg = await fetchSegmentDetail(stringId);
        return seg?.active_result?.result || '';
    }

    // chat 단건 결과 보수적 사니타이즈.
    // 실측된 LLM 오염 패턴 (레퍼런스 주의사항 #1):
    //   - 코드펜스 감싸기: \`\`\`...\`\`\` 또는 \`\`\`lang\n...\n\`\`\`
    //   - 양끝 따옴표: " " “ ” ‘ ’ 「 」
    //   - 양끝 마크다운 볼드/이탈릭: ** ... **, * ... *, _ ... _
    //   - 첨머의 "번역:", "번역 결과:" 같은 라벨 한 줄
    // batch 결과(JSON 원본 등)에는 적용하지 않음. chat 단일 세그먼트 경로에서만 호출.
    function sanitizeChatTranslation(raw) {
        if (typeof raw !== 'string') return '';
        let s = raw.trim();
        if (!s) return s;
        // 1) 코드펜스 풀기 (양끝에 있을 때만)
        const fence = s.match(/^```(?:[\w-]+)?\s*\n?([\s\S]*?)\n?```$/);
        if (fence) s = fence[1].trim();
        // 2) 앞의 "번역(문|결과)?\s*[:：]\s*" 라벨 한 줄 제거 (레이블 뒤가 비었으면 다음 줄로 넓혀)
        s = s.replace(/^\s*번역(?:문|결과)?\s*[:：]\s*\n?/, '').trim();
        // 3) 양끝 마크다운 볼드/이탈릭/밑줄 (양쪽이 짝이 맞을 때만)
        const wraps = [
            ['**', '**'], ['*', '*'], ['__', '__'], ['_', '_'],
        ];
        for (let pass = 0; pass < 2; pass++) {
            for (const [open, close] of wraps) {
                if (s.length > open.length + close.length
                    && s.startsWith(open) && s.endsWith(close)) {
                    const inner = s.slice(open.length, -close.length);
                    // 내부에 같은 마커가 또 있으면 의미 있는 마크일 가능성 — 풀지 않음
                    if (!inner.includes(open)) s = inner.trim();
                }
            }
        }
        // 4) 양끝 따옴표 한 겨어만 제거 (짝 맞는 경우)
        const quotePairs = [
            ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'],
        ];
        for (const [open, close] of quotePairs) {
            if (s.length > 1 && s.startsWith(open) && s.endsWith(close)) {
                const inner = s.slice(open.length, -close.length);
                if (!inner.includes(open) && !inner.includes(close)) s = inner.trim();
            }
        }
        return s;
    }

    // ========================================================================
    // Batch compact workflow helpers
    // ========================================================================
    function normalizeSegmentListResponse(listData) {
        const payload = listData?.data;

        if (Array.isArray(payload)) {
            return {
                segments: payload,
                meta: { shape: 'data[]', count: payload.length },
            };
        }

        if (payload && typeof payload === 'object') {
            const items = Array.isArray(payload.items)
                ? payload.items
                : Array.isArray(payload.results)
                    ? payload.results
                    : [];
            return {
                segments: items,
                meta: {
                    shape: Array.isArray(payload.items)
                        ? 'data.items[]'
                        : Array.isArray(payload.results)
                            ? 'data.results[]'
                            : 'data{}',
                    count: payload.count ?? items.length,
                    page: payload.page,
                    totalPage: payload.total_page,
                },
            };
        }

        return {
            segments: [],
            meta: { shape: typeof payload, count: 0 },
        };
    }

    function normalizeId(id) {
        const n = Number(id);
        return Number.isFinite(n) ? n : id;
    }

    function analyzeIdCoverage(expectedIds, actualIds) {
        const expected = expectedIds.map(normalizeId);
        const actual = actualIds.map(normalizeId);
        const expectedSet = new Set(expected);
        const actualSet = new Set(actual);
        const seen = new Set();
        const duplicates = [];

        for (const id of actual) {
            if (seen.has(id) && !duplicates.includes(id)) duplicates.push(id);
            seen.add(id);
        }

        return {
            ok: expected.length === actual.length &&
                expected.every(id => actualSet.has(id)) &&
                actual.every(id => expectedSet.has(id)) &&
                duplicates.length === 0,
            missing: expected.filter(id => !actualSet.has(id)),
            extra: actual.filter(id => !expectedSet.has(id)),
            duplicates,
            expectedCount: expected.length,
            actualCount: actual.length,
        };
    }

    // === SHARED TOKEN PATTERN ===
    // 동일한 union을 cat-tool-shortcuts.user.js / cat-tool-tb.user.js와 공유한다.
    // 세 스크립트 중 하나라도 수정하면 나머지 두 곳도 함께 갱신한다.
    // 커버:
    //   - {value1}, {0}, {한글}, {value-1}, {user.name} 등 중괄호 플레이스홀더
    //   - %1$s, %2$d, %1$@ 등 위치적 printf
    //   - %@, %s, %d 등 단순 printf
    //   - \n, \r, \t 이스케이프 시퀀스
    //   - <br>, <color=...>, <b>, <size=N>, <sprite=N> 등 임의 HTML/Unity rich text 태그
    //   - [color=#...], [b], [url=...], [sprite] 등 임의 BBCode 태그
    const TOKEN_PATTERN = new RegExp(
        '\\{[^{}]+\\}'                  // 중괄호 플레이스홀더
        + '|%\\d+\\$[sd@]'              // 위치적 printf
        + '|%[@sd]'                       // 단순 printf
        + '|\\\\[nrt]'                  // \n \r \t 리터럴
        + '|</?[a-zA-Z][^>]*>'            // 임의 HTML/Unity rich text
        + '|\\[/?[a-zA-Z][^\\]]*\\]'   // 임의 BBCode
    , 'g');

    function extractPlaceholders(text) {
        return Array.from(new Set(String(text || '').match(TOKEN_PATTERN) || []));
    }

    function stripCodeFence(text) {
        // 모든 ```json/``` 펜스를 제거. LLM이 두 개 블록을 붙이거나 닫는 펜스를
        // 빠뜨려도 안전하게 본문을 노출시키기 위해 글로벌 치환을 사용.
        return String(text || '')
            .trim()
            .replace(/```(?:json)?\s*/gi, '')
            .replace(/```/g, '')
            .trim();
    }

    // 텍스트에서 첫 번째 균형 잡힌 JSON 객체/배열 substring을 추출.
    // 문자열 리터럴과 이스케이프를 인지하므로 본문 뒤에 자연어/추가 블록이
    // 붙어 있어도 첫 완전 객체만 반환한다. 못 찾으면 null.
    function extractFirstJsonValue(text) {
        const src = String(text || '');
        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            if (ch !== '{' && ch !== '[') continue;
            const open = ch;
            const close = ch === '{' ? '}' : ']';
            let depth = 0;
            let inString = false;
            let escape = false;
            for (let j = i; j < src.length; j++) {
                const c = src[j];
                if (escape) { escape = false; continue; }
                if (inString) {
                    if (c === '\\') escape = true;
                    else if (c === '"') inString = false;
                    continue;
                }
                if (c === '"') { inString = true; continue; }
                if (c === open) depth++;
                else if (c === close) {
                    depth--;
                    if (depth === 0) return src.slice(i, j + 1);
                }
            }
            // 여기서 시작한 블록이 닫히지 않으면 더 뒤를 봐도 의미 없음.
            return null;
        }
        return null;
    }

    function parseWorkflowJson(rawText, expectedPhase) {
        const cleaned = stripCodeFence(rawText);
        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch (firstError) {
            // 본문 뒤에 자연어가 붙은 경우(0.5.0 차단 패턴): 첫 균형 객체만 추출해 재시도.
            const candidate = extractFirstJsonValue(cleaned);
            if (!candidate || candidate === cleaned) throw firstError;
            try {
                parsed = JSON.parse(candidate);
            } catch {
                throw firstError;
            }
        }
        if (expectedPhase && parsed.phase !== expectedPhase) {
            throw new Error(`phase 불일치: 기대=${expectedPhase}, 실제=${parsed.phase}`);
        }
        return parsed;
    }

    function getJsonErrorContext(text, error) {
        const message = error?.message || '';
        const match = message.match(/position\s+(\d+)/i);
        if (!match) {
            return { message, position: null, before: '', after: '' };
        }

        const position = Number(match[1]);
        return {
            message,
            position,
            before: text.slice(Math.max(0, position - 140), position),
            after: text.slice(position, position + 140),
        };
    }

    function inspectSavedJson(rawText, expectedPhase) {
        // parseWorkflowJson이 내부에서 stripCodeFence를 다시 수행하므로 raw를 그대로 전달.
        // (이전 구현은 cleaned를 또 cleaning하는 중복이 있었다.)
        const cleaned = stripCodeFence(rawText);
        try {
            const parsed = parseWorkflowJson(rawText, expectedPhase);
            return { ok: true, cleaned, parsed };
        } catch (error) {
            return {
                ok: false,
                cleaned,
                error,
                context: getJsonErrorContext(cleaned, error),
            };
        }
    }

    function classifySavedResult(rawText) {
        const text = String(rawText || '');
        if (/Read timeout/i.test(text) && /bedrock-runtime/i.test(text)) {
            return {
                type: 'BEDROCK_READ_TIMEOUT',
                message: 'Bedrock 모델 호출이 TMS 백엔드의 대기 시간 안에 끝나지 않았습니다.',
            };
        }
        if (/endpoint URL/i.test(text) && /invoke/i.test(text)) {
            return {
                type: 'MODEL_ENDPOINT_ERROR',
                message: '모델 엔드포인트 호출 오류 문자열이 결과 칸에 저장되었습니다.',
            };
        }
        return null;
    }

    function makeWorkflowError(message, code) {
        const error = new Error(message);
        error.workflowCode = code;
        return error;
    }

    function validatePhase12Compact(phase12Compact, segmentSource) {
        const expectedIds = segmentSource.map(seg => normalizeId(seg.id));
        const groups = Array.isArray(phase12Compact?.groups) ? phase12Compact.groups : [];
        const groupedIds = groups.flatMap(group => Array.isArray(group.ids) ? group.ids.map(normalizeId) : []);
        const coverage = analyzeIdCoverage(expectedIds, groupedIds);
        const invalidGroups = groups
            .map((group, index) => ({ group, index }))
            .filter(({ group }) =>
                !group.gid ||
                !Array.isArray(group.ids) ||
                !Array.isArray(group.rules)
            )
            .map(({ group, index }) => ({ index, gid: group.gid || null }));

        return {
            ok: phase12Compact?.phase === '1+2' &&
                groups.length > 0 &&
                coverage.ok &&
                invalidGroups.length === 0,
            coverage,
            invalidGroups,
            groupsCount: groups.length,
        };
    }

    function buildExpectedGroupMap(phase12Compact) {
        const expectedGroupById = new Map();
        for (const group of (phase12Compact?.groups || [])) {
            for (const id of (group.ids || [])) {
                expectedGroupById.set(normalizeId(id), group.gid);
            }
        }
        return expectedGroupById;
    }

    // v0.6.6 (B3): warn-only 추가 검증 (char 길이, placeholder 순서, TB term 미사용)
    // - charLimitOver: segment.char_limit이 있을 때 final 길이가 limit 초과 (없으면 origin_string 길이 * 2.5 + 30 임시 cap)
    // - placeholderOrderMismatch: source/target placeholder 출현 순서가 다름
    // - tbTermsMissed: tbTerms Map에 source가 있지만 final이 target을 포함하지 않음
    function computeTranslationWarnings(items, sourceById, tbTerms) {
        const charLimitOver = [];
        const placeholderOrderMismatch = [];
        const tbTermsMissed = [];
        const tb = tbTerms instanceof Map ? tbTerms : null;

        for (const item of items) {
            if (typeof item.t !== 'string' || !item.t) continue;
            const id = normalizeId(item.id);
            const seg = sourceById.get(id);
            const src = seg?.origin_string || '';
            const finalText = item.t;

            // char limit
            const explicitLimit = Number(seg?.char_limit) || 0;
            const finalLen = Array.from(finalText).length;
            if (explicitLimit > 0) {
                if (finalLen > explicitLimit) charLimitOver.push({ id, length: finalLen, limit: explicitLimit, source: 'segment.char_limit' });
            } else if (src) {
                const srcLen = Array.from(src).length;
                const softLimit = Math.max(30, Math.ceil(srcLen * 2.5));
                if (finalLen > softLimit) charLimitOver.push({ id, length: finalLen, limit: softLimit, source: 'soft(2.5x+30)' });
            }

            // placeholder order
            const srcPh = extractPlaceholders(src);
            if (srcPh.length >= 2) {
                const finalPh = extractPlaceholders(finalText);
                const srcSeq = srcPh.filter(p => finalPh.includes(p));
                const finalSeq = finalPh.filter(p => srcPh.includes(p));
                const minLen = Math.min(srcSeq.length, finalSeq.length);
                let mismatched = false;
                for (let i = 0; i < minLen; i += 1) {
                    if (srcSeq[i] !== finalSeq[i]) { mismatched = true; break; }
                }
                if (mismatched) placeholderOrderMismatch.push({ id, expected: srcSeq, actual: finalSeq });
            }

            // tb terms
            if (tb && tb.size && src) {
                const missed = [];
                for (const [srcTerm, dstTerm] of tb) {
                    if (!srcTerm || !dstTerm) continue;
                    if (src.includes(srcTerm) && !finalText.includes(dstTerm)) {
                        missed.push({ src: srcTerm, expected: dstTerm });
                    }
                }
                if (missed.length) tbTermsMissed.push({ id, terms: missed });
            }
        }
        return { charLimitOver, placeholderOrderMismatch, tbTermsMissed };
    }

    function validatePhase3Compact(phase12Compact, phase3Compact, segmentSource, options = {}) {
        const expectedIds = segmentSource.map(seg => normalizeId(seg.id));
        const expectedGroupById = buildExpectedGroupMap(phase12Compact);
        const translations = Array.isArray(phase3Compact?.translations) ? phase3Compact.translations : [];
        const actualIds = translations.map(item => normalizeId(item.id));
        const coverage = analyzeIdCoverage(expectedIds, actualIds);

        const wrongGroups = translations
            .filter(item => expectedGroupById.get(normalizeId(item.id)) !== item.gid)
            .map(item => ({
                id: normalizeId(item.id),
                expected: expectedGroupById.get(normalizeId(item.id)),
                actual: item.gid,
            }));

        const sourceById = new Map(segmentSource.map(seg => [normalizeId(seg.id), seg]));
        const invalidTranslationType = translations
            .filter(item => typeof item.t !== 'string')
            .map(item => normalizeId(item.id));

        const emptyTranslations = translations
            .filter(item => typeof item.t === 'string' && !item.t.trim())
            .map(item => normalizeId(item.id));

        const missingPlaceholders = [];
        for (const item of translations) {
            const src = sourceById.get(normalizeId(item.id))?.origin_string || '';
            const placeholders = extractPlaceholders(src);
            const translated = typeof item.t === 'string' ? item.t : '';
            const missing = placeholders.filter(token => !translated.includes(token));
            if (missing.length) {
                missingPlaceholders.push({ id: normalizeId(item.id), missing });
            }
        }

        const hanjaLike = translations
            .filter(item => typeof item.t === 'string' && /[\u4e00-\u9fff]/.test(item.t))
            .map(item => normalizeId(item.id));

        // v0.6.6 (B3): warn-only 추가 검증 (ok에 영향 없음)
        const warnings = computeTranslationWarnings(translations, sourceById, options.tbTerms);

        return {
            ok: phase3Compact?.phase === '3' &&
                coverage.ok &&
                wrongGroups.length === 0 &&
                invalidTranslationType.length === 0 &&
                emptyTranslations.length === 0 &&
                missingPlaceholders.length === 0 &&
                hanjaLike.length === 0,
            coverage,
            wrongGroups,
            invalidTranslationType,
            emptyTranslations,
            missingPlaceholders,
            hanjaLike,
            warnings,
        };
    }

    function validatePhase45Compact(phase3Compact, phase45Compact, segmentSource, options = {}) {
        const translations = Array.isArray(phase3Compact?.translations) ? phase3Compact.translations : [];
        const expectedIds = translations.map(item => normalizeId(item.id));
        const phase3ById = new Map(translations.map(item => [normalizeId(item.id), item]));
        const revisions = Array.isArray(phase45Compact?.revisions) ? phase45Compact.revisions : [];
        const actualIds = revisions.map(item => normalizeId(item.id));
        const coverage = analyzeIdCoverage(expectedIds, actualIds);

        const wrongGroups = revisions
            .filter(item => phase3ById.get(normalizeId(item.id))?.gid !== item.gid)
            .map(item => ({
                id: normalizeId(item.id),
                expected: phase3ById.get(normalizeId(item.id))?.gid,
                actual: item.gid,
            }));

        const missingTField = revisions
            .filter(item => !Object.prototype.hasOwnProperty.call(item, 't'))
            .map(item => normalizeId(item.id));

        const invalidTType = revisions
            .filter(item => Object.prototype.hasOwnProperty.call(item, 't') && item.t !== null && typeof item.t !== 'string')
            .map(item => normalizeId(item.id));

        // v0.6.4: phase3와 동일한 텍스트가 들어온 revision은 사실상 no-op으로 간주 → reason 요구에서 제외
        const effectiveNoOpIds = new Set(
            revisions
                .filter(item => typeof item.t === 'string' && item.t === (phase3ById.get(normalizeId(item.id))?.t ?? null))
                .map(item => normalizeId(item.id))
        );

        const invalidReasons = revisions
            .filter(item => {
                if (!Array.isArray(item.r)) return true;
                if (typeof item.t === 'string' && item.r.length === 0 && !effectiveNoOpIds.has(normalizeId(item.id))) return true;
                return false;
            })
            .map(item => normalizeId(item.id));

        const finalTextById = new Map();
        const emptyFinals = [];
        for (const item of revisions) {
            const id = normalizeId(item.id);
            const phase3Text = phase3ById.get(id)?.t || '';
            const finalText = item.t === null ? phase3Text : (typeof item.t === 'string' ? item.t : '');
            finalTextById.set(id, finalText);
            if (!finalText.trim()) emptyFinals.push(id);
        }

        const sourceById = new Map(segmentSource.map(seg => [normalizeId(seg.id), seg]));
        const missingPlaceholders = [];
        for (const item of revisions) {
            const id = normalizeId(item.id);
            const src = sourceById.get(id)?.origin_string || '';
            const placeholders = extractPlaceholders(src);
            const finalText = finalTextById.get(id) || '';
            const missing = placeholders.filter(token => !finalText.includes(token));
            if (missing.length) {
                missingPlaceholders.push({ id, missing });
            }
        }

        const hanjaLike = revisions
            .filter(item => /[\u4e00-\u9fff]/.test(finalTextById.get(normalizeId(item.id)) || ''))
            .map(item => normalizeId(item.id));

        // v0.6.4: \uc0ac\uc2e4\uc0c1 no-op\uc744 \uc81c\uc678\ud55c \uc2e4\uc81c \ubcc0\uacbd \uac74\uc218
        const changedCount = revisions.filter(item => item.t !== null && !effectiveNoOpIds.has(normalizeId(item.id))).length;

        // v0.6.6 (B3): warn-only 추가 검증 (final 텍스트 기준)
        const warnInputs = revisions.map(item => ({ id: normalizeId(item.id), gid: item.gid, t: finalTextById.get(normalizeId(item.id)) || '' }));
        const warnings = computeTranslationWarnings(warnInputs, sourceById, options.tbTerms);

        return {
            ok: phase45Compact?.phase === '4+5' &&
                coverage.ok &&
                wrongGroups.length === 0 &&
                missingTField.length === 0 &&
                invalidTType.length === 0 &&
                invalidReasons.length === 0 &&
                emptyFinals.length === 0 &&
                missingPlaceholders.length === 0 &&
                hanjaLike.length === 0,
            coverage,
            wrongGroups,
            missingTField,
            invalidTType,
            invalidReasons,
            emptyFinals,
            missingPlaceholders,
            hanjaLike,
            changedCount,
            warnings,
        };
    }

    function extractVisibleTbTerms() {
        const terms = new Map();
        const spans = document.querySelectorAll('div.origin_string[data-type="origin_string"] span.vb[data-tooltip]');
        for (const span of spans) {
            const source = span.textContent?.trim();
            const target = span.getAttribute('data-tooltip')?.trim();
            if (source && target) terms.set(source, target);
        }
        return terms;
    }

    function extractBatchApiTerms(segments) {
        const terms = new Map();
        for (const seg of (segments || [])) {
            for (const term of (seg.match_terms || [])) {
                const source = term.trans?.['zh-Hans'] || term.trans?.zh || '';
                const target = term.trans?.ko || '';
                if (source && target) terms.set(source, target);
            }
        }
        return terms;
    }

    function buildBatchTbSummary(segments) {
        const merged = new Map();
        for (const [source, target] of extractBatchApiTerms(segments)) merged.set(source, target);
        for (const [source, target] of extractVisibleTbTerms()) merged.set(source, target);
        return Array.from(merged.entries())
            .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans'))
            .map(([source, target]) => ({ source, target }));
    }

    function formatBatchTbSummary(tbSummary) {
        if (!tbSummary?.length) return '';
        const lines = tbSummary.map(term => `- ${term.source} → ${term.target}`);
        return [
            '# 파일 전체 TB 용어',
            '아래 TB 용어는 현재 배치 전체에서 반드시 동일하게 적용하세요.',
            ...lines,
        ].join('\n');
    }

    // ========================================================================
    // 번역 입력창 탐색 & 값 주입 (SPA가 변경을 감지하도록)
    // ========================================================================

    // 현재 활성 세그먼트의 번역 입력 textarea 찾기
    // TMS Naive UI 구조에 맞춤 (v0.3.0)
    function findStringItemByStringId(stringId) {
        const targetId = normalizeId(stringId);
        return $$('.string-item')
            .find(item => normalizeId(extractStringIdFromItem(item)) === targetId) || null;
    }

    function findTranslationTextareaInItem(item) {
        if (!item) return null;
        const preferred = item.querySelector('textarea[placeholder="请输入译文"]');
        if (preferred && !preferred.readOnly && !preferred.disabled) return preferred;

        return [...item.querySelectorAll('textarea')]
            .find(ta => !ta.readOnly && !ta.disabled) || null;
    }

    function findTranslationTextareaForStringId(stringId) {
        const item = findStringItemByStringId(stringId);
        return findTranslationTextareaInItem(item);
    }

    function findTranslationTextarea(stringId) {
        if (stringId) {
            const explicitTextarea = findTranslationTextareaForStringId(stringId);
            if (explicitTextarea) {
                dverbose(`#${stringId} string-item에서 번역 textarea 발견`);
                return explicitTextarea;
            }
        }

        // 1순위: 활성 string-item 내부의 번역 textarea
        const activeItem = findActiveStringItem();
        if (activeItem) {
            // .info-row 안의 번역 textarea (우측 번역 패널)
            const ta = findTranslationTextareaInItem(activeItem);
            if (ta) {
                dverbose('활성 string-item에서 번역 textarea 발견');
                return ta;
            }
        }

        // 2순위: 현재 포커스된 textarea (사용자가 방금 클릭한 것)
        const focused = document.activeElement;
        if (focused && focused.tagName === 'TEXTAREA' &&
            !modalEl?.contains(focused) && !focused.readOnly && !focused.disabled) {
            dverbose('포커스된 textarea 사용');
            return focused;
        }

        dwarn('활성 번역 textarea를 찾지 못함');
        return null;
    }

    // textarea에 값 주입 + Vue/React가 변경 감지하도록 이벤트 디스패치
    function injectTextareaValue(textarea, value) {
        // React/Vue 공통: 네이티브 setter를 우회해서 값 주입
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSetter.call(textarea, value);

        // 변경 이벤트 연쇄 발생 (프레임워크가 반응하도록)
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));

        // Vue Naive UI를 위한 추가 처리: 해당 textarea를 감싸는 wrapper에도 이벤트
        const wrapper = textarea.closest('.n-input');
        if (wrapper) {
            wrapper.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // 포커스 이동 (사용자가 바로 편집할 수 있도록)
        textarea.focus();

        return true;
    }

    // ========================================================================
    // 세션 관리 (TTL 기반 자동 정리 + 수동 관리)
    // ========================================================================
    function loadSessions() {
        return lsGet(LS_KEYS.SESSIONS, {});
    }
    function saveSessions(sessions) {
        lsSet(LS_KEYS.SESSIONS, sessions);
    }
    function getSession(stringId) {
        const sessions = loadSessions();
        return sessions[stringId] || { messages: [], system: null, source: 'manual', importedFromRunId: null, importedAt: null, updated: Date.now() };
    }
    function setSession(stringId, session) {
        const sessions = loadSessions();
        session.updated = Date.now(); // 마지막 업데이트 시각 기록
        sessions[stringId] = session;
        saveSessions(sessions);
    }
    function clearSession(stringId) {
        const sessions = loadSessions();
        delete sessions[stringId];
        saveSessions(sessions);
    }

    // TTL 기반 자동 정리 (모달 열 때 호출)
    function pruneExpiredSessions() {
        const sessions = loadSessions();
        const now = Date.now();
        const ttlMs = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
        let removed = 0;
        for (const [id, session] of Object.entries(sessions)) {
            const updated = session.updated || 0;
            if (now - updated > ttlMs) {
                delete sessions[id];
                removed++;
            }
        }
        if (removed > 0) {
            saveSessions(sessions);
            dinfo(`${SESSION_TTL_DAYS}일 이상 된 세션 ${removed}개 자동 정리됨`);
        }
        return removed;
    }

    // 세션 통계 (설정 패널용)
    function getSessionStats() {
        const sessions = loadSessions();
        const ids = Object.keys(sessions);
        const json = JSON.stringify(sessions);
        const sizeKb = (new Blob([json]).size / 1024).toFixed(1);
        let oldestAge = 0;
        const now = Date.now();
        for (const s of Object.values(sessions)) {
            const age = now - (s.updated || 0);
            if (age > oldestAge) oldestAge = age;
        }
        const oldestDays = Math.floor(oldestAge / (24 * 60 * 60 * 1000));
        return {
            count: ids.length,
            sizeKb,
            oldestDays,
        };
    }

    // 모든 세션 삭제 (프롬프트는 유지)
    function clearAllSessions() {
        saveSessions({});
    }

    // v0.7.9: 워크스페이스 전체 통계 (sessions + prompts + runs + overrides + IDB slots + LS approx)
    // 설정 패널 "📊 저장 현황" 카드와 관리 섹션이 공유.
    function getWorkspaceStats() {
        const sessions = (() => { try { return loadSessions(); } catch { return {}; } })();
        const prompts = (() => { try { return loadPrompts(); } catch { return []; } })();
        const runs = (() => { try { return loadBatchRuns(); } catch { return {}; } })();
        const overrides = (() => { try { return loadReviewOverrides(); } catch { return {}; } })();

        const sessionCount = Object.keys(sessions).length;
        const promptCount = Array.isArray(prompts) ? prompts.length : 0;
        const runCount = Object.keys(runs).length;

        // override count + orphan
        let overrideCount = 0;
        let orphanOverrideRunCount = 0;
        let orphanOverrideEntryCount = 0;
        for (const [runId, bucket] of Object.entries(overrides)) {
            const n = Object.keys(bucket || {}).length;
            overrideCount += n;
            if (!runs[runId]) {
                orphanOverrideRunCount++;
                orphanOverrideEntryCount += n;
            }
        }

        // LS approx size (우리가 쓰는 키만)
        let lsBytes = 0;
        try {
            for (const k of Object.values(LS_KEYS)) {
                const v = localStorage.getItem(k);
                if (v != null) lsBytes += k.length + v.length;
            }
        } catch {}
        const lsKb = (lsBytes / 1024).toFixed(1);

        return {
            sessionCount, promptCount, runCount,
            overrideCount, orphanOverrideRunCount, orphanOverrideEntryCount,
            lsBytes, lsKb,
        };
    }

    // v0.7.9: override 관리 (수동 정리)
    function clearOverridesForRun(runId) {
        if (!runId) return 0;
        const all = loadReviewOverrides();
        const bucket = all[runId];
        const n = bucket ? Object.keys(bucket).length : 0;
        if (n > 0) {
            delete all[runId];
            saveReviewOverrides(all);
        }
        return n;
    }
    function pruneOrphanOverrides() {
        const all = loadReviewOverrides();
        const runs = loadBatchRuns();
        let removedRuns = 0, removedEntries = 0;
        for (const runId of Object.keys(all)) {
            if (!runs[runId]) {
                removedEntries += Object.keys(all[runId] || {}).length;
                delete all[runId];
                removedRuns++;
            }
        }
        if (removedRuns > 0) saveReviewOverrides(all);
        return { removedRuns, removedEntries };
    }

    // v0.7.10: Run-level GC. 정책 = (가장 최근 keepRecent개는 무조건 유지) AND (활성 run 보호) AND (보호 상태 보호) AND (maxAgeDays 초과만 삭제 후보).
    // dryRun=true면 candidates만 반환. dryRun=false면 실제 삭제 + 짝 override + dangling import 정리.
    function pruneOldRuns(opts = {}) {
        const {
            keepRecent = 10,
            maxAgeDays = 30,
            protectActive = true,
            protectStatuses = ['running', 'phase45_ready'],
            dryRun = true,
        } = opts;
        const runs = loadBatchRuns();
        const activeId = (() => { try { return getActiveBatchRunId && getActiveBatchRunId(); } catch { return null; } })();
        const protectSet = new Set(protectStatuses);
        const ageMs = Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const ts = (r) => {
            const v = r.updatedAt || r.createdAt || '';
            const t = Date.parse(v);
            return Number.isFinite(t) ? t : 0;
        };
        const sorted = Object.entries(runs).sort((a, b) => ts(b[1]) - ts(a[1]));
        const protectedByRecent = new Set(sorted.slice(0, Math.max(0, keepRecent)).map(([id]) => id));
        const candidates = [];
        for (const [id, r] of sorted) {
            if (protectedByRecent.has(id)) continue;
            if (protectActive && id === activeId) continue;
            if (protectSet.has(String(r.status || ''))) continue;
            const t = ts(r);
            if (t === 0) continue; // timestamp 미상은 보수적으로 보호
            if (now - t < ageMs) continue;
            candidates.push({
                id,
                status: String(r.status || '?'),
                ageDays: Math.floor((now - t) / (24 * 60 * 60 * 1000)),
            });
        }
        if (dryRun) {
            return { candidates, removed: 0, removedOverrideRuns: 0, nullifiedSessions: 0 };
        }
        let removedOverrideRuns = 0;
        let nullifiedSessions = 0;
        const remaining = { ...runs };
        for (const c of candidates) {
            delete remaining[c.id];
            try {
                const n = clearOverridesForRun(c.id);
                if (n > 0) removedOverrideRuns++;
            } catch {}
            try {
                nullifiedSessions += nullifyDanglingImportedFromRunId(c.id) || 0;
            } catch {}
        }
        if (candidates.length > 0) saveBatchRuns(remaining);
        return {
            candidates,
            removed: candidates.length,
            removedOverrideRuns,
            nullifiedSessions,
        };
    }

    // v0.7.10: import diff/preview. 백업 JSON과 현재 LS를 비교해 신규/덮어쓸/동일 카운트를 카테고리별로 계산.
    // sessions/batchRuns/overrides는 id-keyed 객체, prompts는 array(name keyed)로 가정.
    function diffImportPreview(data) {
        const out = {
            sessions: null, prompts: null, batchRuns: null, overrides: null,
        };
        const stableStringify = (v) => {
            try { return JSON.stringify(v); } catch { return String(v); }
        };
        const diffObj = (incoming, current) => {
            let added = 0, overwrite = 0, same = 0;
            const inc = incoming || {};
            const cur = current || {};
            for (const k of Object.keys(inc)) {
                if (!(k in cur)) { added++; continue; }
                if (stableStringify(inc[k]) === stableStringify(cur[k])) same++;
                else overwrite++;
            }
            return { added, overwrite, same, incoming: Object.keys(inc).length };
        };
        if (data && data.sessions) {
            try { out.sessions = diffObj(data.sessions, loadSessions()); }
            catch { out.sessions = diffObj(data.sessions, {}); }
        }
        if (data && data.batchRuns) {
            try { out.batchRuns = diffObj(data.batchRuns, loadBatchRuns()); }
            catch { out.batchRuns = diffObj(data.batchRuns, {}); }
        }
        if (data && data.overrides) {
            // override는 runId 단위가 아니라 stringId entry 단위로 카운트하는 게 의미가 있음
            const incoming = data.overrides || {};
            const current = (() => { try { return loadReviewOverrides(); } catch { return {}; } })();
            let added = 0, overwrite = 0, same = 0, total = 0;
            for (const runId of Object.keys(incoming)) {
                const incBucket = incoming[runId] || {};
                const curBucket = current[runId] || {};
                for (const stringId of Object.keys(incBucket)) {
                    total++;
                    if (!(stringId in curBucket)) { added++; continue; }
                    if (stableStringify(incBucket[stringId]) === stableStringify(curBucket[stringId])) same++;
                    else overwrite++;
                }
            }
            out.overrides = { added, overwrite, same, incoming: total };
        }
        if (data && Array.isArray(data.prompts)) {
            const cur = (() => { try { return loadPrompts(); } catch { return []; } })();
            const curMap = new Map((cur || []).map(p => [p && p.name, p]));
            let added = 0, overwrite = 0, same = 0;
            for (const p of data.prompts) {
                const name = p && p.name;
                if (!curMap.has(name)) { added++; continue; }
                if (stableStringify(p) === stableStringify(curMap.get(name))) same++;
                else overwrite++;
            }
            out.prompts = { added, overwrite, same, incoming: data.prompts.length };
        }
        return out;
    }

    // v0.7.8 (#4): BATCH_RUNS GC 시 SESSIONS의 dangling importedFromRunId nullify
    // - 세션 자체는 유지 (대화 이력 손실 방지). importedFromRunId만 null로 설정.
    // - source는 'batch_import' 그대로 둔다 (히스토리 흔적 보존).
    // 반환: nullify된 세션 개수
    function nullifyDanglingImportedFromRunId(runId) {
        if (!runId) return 0;
        const sessions = loadSessions();
        let count = 0;
        for (const id of Object.keys(sessions)) {
            const s = sessions[id];
            if (s && s.importedFromRunId === runId) {
                s.importedFromRunId = null;
                count++;
            }
        }
        if (count > 0) saveSessions(sessions);
        return count;
    }

    // Export: 세션만 / 프롬프트만 / 전체 선택 가능
    // v0.7.8 (#2): includeBatchRuns / includeOverrides 옵션 — 워크스페이스 통째로 백업 가능
    function exportSessionsJson(opts = {}) {
        const {
            includeSessions = true,
            includePrompts = false,
            includeBatchRuns = false,
            includeOverrides = false,
            stripRawSegments = true, // batch run의 무거운 raw 섹션 기본 제거
        } = opts;
        const data = {
            version: 3, // v0.7.8: workspace 필드 도입
            exported: new Date().toISOString(),
            schemaVersion: typeof CURRENT_SCHEMA_VERSION !== 'undefined' ? CURRENT_SCHEMA_VERSION : 1,
        };
        if (includeSessions) data.sessions = loadSessions();
        if (includePrompts) data.prompts = loadPrompts();
        if (includeOverrides) {
            try { data.overrides = loadReviewOverrides(); } catch { data.overrides = {}; }
        }
        if (includeBatchRuns) {
            try {
                const raw = loadBatchRuns();
                if (stripRawSegments && typeof _stripRunForBackup === 'function') {
                    const stripped = {};
                    for (const [id, r] of Object.entries(raw)) stripped[id] = _stripRunForBackup(r);
                    data.batchRuns = stripped;
                } else {
                    data.batchRuns = raw;
                }
            } catch { data.batchRuns = {}; }
        }
        return JSON.stringify(data, null, 2);
    }

    // Import: 세션과 프롬프트를 선택적으로 복원
    // 반환: { sessionsCount, promptsCount, overridesCount, batchRunsCount, hasSessions, hasPrompts, hasOverrides, hasBatchRuns }
    function importSessionsJson(jsonStr, opts = {}) {
        const {
            restoreSessions = true,
            restorePrompts = false,
            restoreOverrides = false,
            restoreBatchRuns = false,
            mergeSessions = false, // true면 기존 세션에 병합, false면 덮어쓰기
            mergeOverrides = false,
            mergeBatchRuns = false,
        } = opts;

        const data = JSON.parse(jsonStr);
        const hasSessions = !!data.sessions;
        const hasPrompts = !!data.prompts;
        const hasOverrides = !!data.overrides;
        const hasBatchRuns = !!data.batchRuns;
        if (!hasSessions && !hasPrompts && !hasOverrides && !hasBatchRuns) {
            throw new Error('잘못된 형식: sessions/prompts/overrides/batchRuns 중 하나도 없습니다.');
        }

        let sessionsCount = 0;
        let promptsCount = 0;
        let overridesCount = 0;
        let batchRunsCount = 0;

        if (restoreSessions && hasSessions) {
            if (mergeSessions) {
                const existing = loadSessions();
                saveSessions({ ...existing, ...data.sessions });
            } else {
                saveSessions(data.sessions);
            }
            sessionsCount = Object.keys(data.sessions).length;
        }

        if (restorePrompts && hasPrompts) {
            savePrompts(data.prompts);
            promptsCount = data.prompts.length;
        }

        if (restoreOverrides && hasOverrides) {
            if (mergeOverrides) {
                const existing = loadReviewOverrides();
                const merged = { ...existing };
                for (const [runId, bucket] of Object.entries(data.overrides)) {
                    merged[runId] = { ...(merged[runId] || {}), ...bucket };
                }
                saveReviewOverrides(merged);
            } else {
                saveReviewOverrides(data.overrides);
            }
            overridesCount = Object.values(data.overrides).reduce((sum, b) => sum + Object.keys(b || {}).length, 0);
        }

        if (restoreBatchRuns && hasBatchRuns) {
            if (mergeBatchRuns) {
                const existing = loadBatchRuns();
                saveBatchRuns({ ...existing, ...data.batchRuns });
            } else {
                saveBatchRuns(data.batchRuns);
            }
            batchRunsCount = Object.keys(data.batchRuns).length;
        }

        return {
            sessionsCount, promptsCount, overridesCount, batchRunsCount,
            hasSessions, hasPrompts, hasOverrides, hasBatchRuns,
        };
    }

    // ========================================================================
    // v0.7.7 (#12): IndexedDB ring 백업
    // - 5 slot ring buffer. nextSlot은 LS에 보관(IDB 실패 시에도 진행).
    // - snapshot 내용: sessions(전체) + overrides(전체) + runs(메타+parsed only, raw 제외)
    // - trigger: override 누적 N회, 또는 phase45 완료, 또는 수동.
    // - restore: LS의 sessions/runs/overrides가 모두 비어 있을 때만 prompt.
    // ========================================================================
    let _backupDbPromise = null;
    function openBackupDb() {
        if (_backupDbPromise) return _backupDbPromise;
        if (typeof indexedDB === 'undefined') {
            _backupDbPromise = Promise.reject(new Error('IndexedDB unavailable'));
            return _backupDbPromise;
        }
        _backupDbPromise = new Promise((resolve, reject) => {
            let req;
            try { req = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION); }
            catch (e) { reject(e); return; }
            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                if (!db.objectStoreNames.contains(BACKUP_STORE)) {
                    db.createObjectStore(BACKUP_STORE, { keyPath: 'slot' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IDB open failed'));
            req.onblocked = () => reject(new Error('IDB open blocked'));
        });
        return _backupDbPromise;
    }

    function _idbReq(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function writeBackupSlot(snapshot) {
        const db = await openBackupDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(BACKUP_STORE, 'readwrite');
            tx.oncomplete = () => resolve(snapshot.slot);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('tx aborted'));
            tx.objectStore(BACKUP_STORE).put(snapshot);
        });
    }

    async function readAllBackupSlots() {
        const db = await openBackupDb();
        const tx = db.transaction(BACKUP_STORE, 'readonly');
        const all = await _idbReq(tx.objectStore(BACKUP_STORE).getAll());
        return Array.isArray(all) ? all : [];
    }

    async function getLatestBackupSnapshot() {
        const all = await readAllBackupSlots().catch(() => []);
        if (!all.length) return null;
        all.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
        return all[0];
    }

    function _stripRunForBackup(run) {
        if (!run || typeof run !== 'object') return run;
        const out = { ...run };
        // raw segments: 무겁고 서버에서 다시 받을 수 있음 — 백업 제외
        delete out.segments;
        // phase raw text도 제외 (parsed 만 보존)
        for (const k of ['phase12', 'phase3', 'phase45']) {
            if (out[k] && typeof out[k] === 'object') {
                const phase = { ...out[k] };
                delete phase.raw;
                out[k] = phase;
            }
        }
        return out;
    }

    function buildBackupSnapshot(trigger = 'manual') {
        const sessions = (() => { try { return loadSessions(); } catch { return {}; } })();
        const overrides = (() => { try { return loadReviewOverrides(); } catch { return {}; } })();
        const runsRaw = (() => { try { return loadBatchRuns(); } catch { return {}; } })();
        const runs = {};
        for (const [id, r] of Object.entries(runsRaw)) {
            runs[id] = _stripRunForBackup(r);
        }
        return {
            // slot은 호출부에서 결정
            savedAt: new Date().toISOString(),
            schemaVersion: CURRENT_SCHEMA_VERSION,
            trigger: String(trigger),
            sessions,
            overrides,
            runs,
        };
    }

    function _nextBackupSlot() {
        const cur = Number(lsGet(LS_KEYS.BACKUP_NEXT_SLOT, 0)) || 0;
        const slot = ((cur % BACKUP_SLOT_COUNT) + BACKUP_SLOT_COUNT) % BACKUP_SLOT_COUNT;
        lsSet(LS_KEYS.BACKUP_NEXT_SLOT, (slot + 1) % BACKUP_SLOT_COUNT);
        return slot;
    }

    // fire-and-forget. 실패해도 운영에는 영향 없음 (LS가 source of truth).
    function triggerBackupAsync(trigger = 'manual') {
        try {
            const snap = buildBackupSnapshot(trigger);
            snap.slot = _nextBackupSlot();
            writeBackupSlot(snap)
                .then(() => dverbose(`backup slot ${snap.slot} 작성 (${trigger})`))
                .catch((e) => dwarn('IDB backup 실패', e));
        } catch (e) {
            dwarn('backup snapshot 빌드 실패', e);
        }
    }

    function _bumpOverrideWriteCounter() {
        const cur = Number(lsGet(LS_KEYS.OVERRIDE_WRITE_COUNTER, 0)) || 0;
        const next = cur + 1;
        if (next >= OVERRIDE_BACKUP_THRESHOLD) {
            lsSet(LS_KEYS.OVERRIDE_WRITE_COUNTER, 0);
            triggerBackupAsync('override-batch');
        } else {
            lsSet(LS_KEYS.OVERRIDE_WRITE_COUNTER, next);
        }
    }

    // v0.7.9: 특정 슬롯에서 강제 복원 (수동 트리거). 호출부에서 confirm 책임.
    // mode: 'overwrite' (기본 — LS 통째 교체) | 'merge' (슬롯이 가진 키만 덮어씀)
    async function restoreFromBackupSlot(slot, mode = 'overwrite') {
        const all = await readAllBackupSlots();
        const snap = all.find(s => s && s.slot === slot);
        if (!snap) throw new Error(`slot ${slot} 비어 있음`);
        if (mode === 'overwrite') {
            saveSessions(snap.sessions || {});
            saveReviewOverrides(snap.overrides || {});
            saveBatchRuns(snap.runs || {});
        } else {
            // merge: 슬롯이 가진 키만 덮어씀
            if (snap.sessions) saveSessions({ ...loadSessions(), ...snap.sessions });
            if (snap.overrides) {
                const cur = loadReviewOverrides();
                const merged = { ...cur };
                for (const [rid, b] of Object.entries(snap.overrides)) {
                    merged[rid] = { ...(merged[rid] || {}), ...b };
                }
                saveReviewOverrides(merged);
            }
            if (snap.runs) saveBatchRuns({ ...loadBatchRuns(), ...snap.runs });
        }
        return {
            sessions: Object.keys(snap.sessions || {}).length,
            overrides: Object.values(snap.overrides || {}).reduce((s, b) => s + Object.keys(b || {}).length, 0),
            runs: Object.keys(snap.runs || {}).length,
        };
    }

    // 모달 진입 시 호출. LS가 비어 있고 IDB에 백업이 있을 때만 사용자에게 복원 prompt.
    async function maybeRestoreFromBackup() {
        let sessions = {}, overrides = {}, runs = {};
        try { sessions = loadSessions(); } catch {}
        try { overrides = loadReviewOverrides(); } catch {}
        try { runs = loadBatchRuns(); } catch {}
        const lsEmpty = !Object.keys(sessions).length
            && !Object.keys(overrides).length
            && !Object.keys(runs).length;
        if (!lsEmpty) return false;
        const snap = await getLatestBackupSnapshot().catch(() => null);
        if (!snap) return false;
        const sCount = snap.sessions ? Object.keys(snap.sessions).length : 0;
        const oCount = snap.overrides ? Object.keys(snap.overrides).length : 0;
        const rCount = snap.runs ? Object.keys(snap.runs).length : 0;
        if (sCount + oCount + rCount === 0) return false;
        const ok = await twConfirm({
            title: 'IDB 백업 복원',
            message: `로컬 저장소가 비어 있는데 IDB에 백업이 남아 있습니다 (${snap.savedAt?.slice(0, 19) || '?'}, trigger=${snap.trigger}).\n`
                + `복원: 세션 ${sCount}개 / override ${oCount}개 / run ${rCount}개\n\n`
                + '복원하시겠습니까? (취소하면 빈 상태로 진행)',
        });
        if (!ok) return false;
        try {
            if (snap.sessions) saveSessions(snap.sessions);
            if (snap.overrides) saveReviewOverrides(snap.overrides);
            if (snap.runs) saveBatchRuns(snap.runs);
            toast(`IDB 백업 복원: 세션 ${sCount} / override ${oCount} / run ${rCount}`, 'success');
            return true;
        } catch (e) {
            derror('IDB 복원 실패', e);
            toast(`복원 실패: ${e.message}`, 'error');
            return false;
        }
    }

    // ========================================================================
    // 시스템 프롬프트 관리
    // ========================================================================
    function loadPrompts() {
        const prompts = lsGet(LS_KEYS.SYSTEM_PROMPTS);
        if (!prompts || !prompts.length) {
            lsSet(LS_KEYS.SYSTEM_PROMPTS, [DEFAULT_PROMPT]);
            return [DEFAULT_PROMPT];
        }
        return prompts;
    }
    function savePrompts(prompts) {
        lsSet(LS_KEYS.SYSTEM_PROMPTS, prompts);
    }

    // ----- 활성 프롬프트 ID: 채팅/배치 분리 (v0.4.0+) -----
    // 기존 단일 ACTIVE_PROMPT_ID에서 마이그레이션. 한 번만 실행하면 충분.
    function migrateActivePromptIdsIfNeeded() {
        const chatId = lsGet(LS_KEYS.CHAT_ACTIVE_PROMPT_ID, null);
        const batchId = lsGet(LS_KEYS.BATCH_ACTIVE_PROMPT_ID, null);
        if (chatId !== null && batchId !== null) return; // 이미 마이그레이션 완료

        const legacyId = lsGet(LS_KEYS.ACTIVE_PROMPT_ID, 'default');
        if (chatId === null) lsSet(LS_KEYS.CHAT_ACTIVE_PROMPT_ID, legacyId);
        if (batchId === null) lsSet(LS_KEYS.BATCH_ACTIVE_PROMPT_ID, legacyId);
    }
    migrateActivePromptIdsIfNeeded();

    function getChatActivePromptId() {
        return lsGet(LS_KEYS.CHAT_ACTIVE_PROMPT_ID, null)
            || lsGet(LS_KEYS.ACTIVE_PROMPT_ID, 'default');
    }
    function setChatActivePromptId(id) {
        lsSet(LS_KEYS.CHAT_ACTIVE_PROMPT_ID, id);
    }
    function getBatchActivePromptId() {
        return lsGet(LS_KEYS.BATCH_ACTIVE_PROMPT_ID, null)
            || lsGet(LS_KEYS.ACTIVE_PROMPT_ID, 'default');
    }
    function setBatchActivePromptId(id) {
        lsSet(LS_KEYS.BATCH_ACTIVE_PROMPT_ID, id);
    }
    function getChatActivePrompt() {
        const prompts = loadPrompts();
        const id = getChatActivePromptId();
        return prompts.find(p => p.id === id) || prompts[0];
    }
    function getBatchActivePrompt() {
        const prompts = loadPrompts();
        const id = getBatchActivePromptId();
        return prompts.find(p => p.id === id) || prompts[0];
    }

    // 잠금: ON이면 채팅/배치 활성 ID가 같이 움직임 (실시간 동기화)
    function getPromptLockLinked() {
        return !!lsGet(LS_KEYS.PROMPT_LOCK_LINKED, false);
    }
    function setPromptLockLinked(linked) {
        lsSet(LS_KEYS.PROMPT_LOCK_LINKED, !!linked);
    }

    function getSelectedModel() {
        return $('.tw-model-select', modalEl)?.value || lsGet(LS_KEYS.MODEL, MODELS[0]);
    }

    // ========================================================================
    // 활성 세그먼트 식별 (TMS Naive UI 기반, API Logger 독립)
    // ========================================================================
    function findActiveStringItem() {
        // 1순위: .string-item.active (포커스된 세그먼트)
        const active = document.querySelector('.string-item.active');
        if (active) return active;

        // 2순위: 포커스된 textarea의 조상 .string-item
        const focused = document.activeElement;
        if (focused && focused.tagName === 'TEXTAREA' && !modalEl?.contains(focused)) {
            const item = focused.closest('.string-item');
            if (item) return item;
        }

        // 3순위: 화면 상단에 보이는 첫 .string-item (스크롤 위치 기반)
        const items = document.querySelectorAll('.string-item');
        for (const item of items) {
            const rect = item.getBoundingClientRect();
            if (rect.top >= 0 && rect.top < window.innerHeight / 2) {
                return item;
            }
        }

        return null;
    }

    // string-item의 data-key 에서 API string_id 추출
    // 패턴: "{prefix}stringItem{string_id}" — 끝의 숫자가 API ID
    function extractStringIdFromItem(item) {
        if (!item) return null;
        const key = item.dataset?.key || '';
        // "stringItem" 토큰 뒤의 숫자 추출
        const m = key.match(/stringItem(\d+)/);
        if (m) return parseInt(m[1], 10);
        // 폴백: 마지막 숫자 덩어리
        const tail = key.match(/(\d+)$/);
        if (tail) return parseInt(tail[1], 10);
        return null;
    }

    // ========================================================================
    // 현재 세그먼트 ID 추출 (DOM만 사용, API Logger 불필요)
    // ========================================================================
    // 폴링으로 자주 호출되므로 로그는 verbose=false일 때 생략
    function getCurrentStringId(verbose = false) {
        const activeItem = findActiveStringItem();
        if (!activeItem) {
            if (verbose) dwarn('활성 .string-item을 찾지 못함');
            return null;
        }

        const stringId = extractStringIdFromItem(activeItem);
        if (stringId) {
            if (verbose) {
                dverbose(`활성 세그먼트 string_id: ${stringId} (DOM row#${activeItem.id})`);
            }
            return stringId;
        }

        if (verbose) {
            dwarn('data-key에서 string_id 추출 실패:', activeItem.dataset?.key);
        }
        return null;
    }

    // ========================================================================
    // 세그먼트 통합 상태 (채팅·배치 합쳐서 조회)
    // ========================================================================
    /**
     * 세그먼트 하나에 대해 채팅 세션과 배치 실행 결과를 통합 조회.
     * 읽기 전용. UI 표시 및 추후 크로스 액션의 기반.
     *
     * @param {number|string} stringId
     * @returns {{
     *   id: number|string,
     *   chat: {
     *     hasSession: boolean,
     *     messageCount: number,
     *     lastTranslation: string|null,
     *     updatedAt: number|null
     *   },
     *   batch: {
     *     runId: string|null,
     *     hasPhase3: boolean,
     *     phase3Text: string|null,
     *     groupId: string|null,
     *     hasRevision: boolean,
     *     revisionText: string|null,
     *     changed: boolean,
     *     reasons: string[]
     *   },
     *   finalCandidate: string|null,
     *   status: 'fresh'|'chat_only'|'batch_only'|'both'
     * }}
     */
    function getSegmentWorkState(stringId) {
        const id = normalizeId(stringId);

        // 채팅 세션 측
        const sessions = loadSessions();
        const session = sessions[id] || sessions[String(id)] || null;
        const messages = (session && Array.isArray(session.messages)) ? session.messages : [];
        const lastAi = [...messages].reverse().find(m => m.role === 'ai') || null;
        const chat = {
            hasSession: messages.length > 0,
            messageCount: messages.length,
            lastTranslation: lastAi?.content || null,
            updatedAt: session?.updated || null,
        };

        // 배치 측 (활성 런만 참조 — 일관성 유지)
        const run = batchRun || restoreActiveBatchRun();
        const phase3Item = run?.phase3?.parsed?.translations
            ?.find(t => normalizeId(t.id) === id) || null;
        const revisionItem = run?.phase45?.parsed?.revisions
            ?.find(r => normalizeId(r.id) === id) || null;

        const batch = {
            runId: run?.runId || null,
            hasPhase3: !!phase3Item,
            phase3Text: phase3Item?.t || null,
            groupId: phase3Item?.gid || revisionItem?.gid || null,
            hasRevision: !!revisionItem,
            // revisionItem.t === null 의미: Phase 3 그대로 사용 (변경 없음)
            revisionText: (revisionItem && revisionItem.t !== null && typeof revisionItem.t === 'string')
                ? revisionItem.t
                : null,
            changed: !!(revisionItem && revisionItem.t !== null && revisionItem.t !== undefined),
            reasons: Array.isArray(revisionItem?.r) ? revisionItem.r : [],
        };

        // 최종 후보: revision 수정문 → phase3 → 채팅 마지막 AI 답변 순
        const finalCandidate = batch.revisionText
            || batch.phase3Text
            || chat.lastTranslation
            || null;

        let status = 'fresh';
        if (chat.hasSession && (batch.hasPhase3 || batch.hasRevision)) status = 'both';
        else if (chat.hasSession) status = 'chat_only';
        else if (batch.hasPhase3 || batch.hasRevision) status = 'batch_only';

        return { id, chat, batch, finalCandidate, status };
    }

    // ========================================================================
    // v0.6.0 L3: applied-from-batch 추적 (textarea가 배치 자동 적용분인지 식별)
    // ========================================================================
    // 짧은 동기 해시 (djb2 32-bit). crypto.subtle은 비동기·과대 — 여기선 변경 감지만 하므로 충돌 무시 가능.
    function hashTextShort(s) {
        const str = String(s ?? '');
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }
    function loadAppliedFromBatch() {
        return lsGet(LS_KEYS.APPLIED_FROM_BATCH, {});
    }
    function saveAppliedFromBatch(map) {
        lsSet(LS_KEYS.APPLIED_FROM_BATCH, map);
    }
    function recordAppliedFromBatch(stringId, runId, phase, text) {
        const map = loadAppliedFromBatch();
        map[normalizeId(stringId)] = {
            runId: runId || null,
            appliedAt: new Date().toISOString(),
            phase: phase || 'phase3',
            hash: hashTextShort(text),
            text: String(text ?? ''),
        };
        saveAppliedFromBatch(map);
    }
    function clearAppliedFromBatch(stringId) {
        const map = loadAppliedFromBatch();
        if (map[normalizeId(stringId)] !== undefined) {
            delete map[normalizeId(stringId)];
            saveAppliedFromBatch(map);
        }
    }
    function getAppliedFromBatch(stringId) {
        const map = loadAppliedFromBatch();
        return map[normalizeId(stringId)] || null;
    }

    // ========================================================================
    // v0.6.2: 리뷰 탭 인라인 수정 override (run+id 키, phase 데이터는 불변 유지)
    // ========================================================================
    function loadReviewOverrides() {
        return lsGet(LS_KEYS.REVIEW_OVERRIDES, {});
    }
    function saveReviewOverrides(map) {
        lsSet(LS_KEYS.REVIEW_OVERRIDES, map);
    }
    function getReviewOverride(runId, stringId) {
        if (!runId) return null;
        const all = loadReviewOverrides();
        const bucket = all[runId];
        if (!bucket) return null;
        const v = bucket[normalizeId(stringId)];
        // v0.6.5: migration — 과거에는 string, 이제는 { text, updatedAt }
        if (typeof v === 'string') return v;
        if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
        return null;
    }
    function setReviewOverride(runId, stringId, text) {
        if (!runId) return;
        const all = loadReviewOverrides();
        const bucket = all[runId] || (all[runId] = {});
        bucket[normalizeId(stringId)] = { text: String(text ?? ''), updatedAt: Date.now() };
        saveReviewOverrides(all);
        try { _bumpOverrideWriteCounter(); } catch (e) { dwarn('backup counter bump 실패', e); }
    }
    function clearReviewOverride(runId, stringId) {
        if (!runId) return;
        const all = loadReviewOverrides();
        const bucket = all[runId];
        if (!bucket) return;
        delete bucket[normalizeId(stringId)];
        if (!Object.keys(bucket).length) delete all[runId];
        saveReviewOverrides(all);
        try { _bumpOverrideWriteCounter(); } catch (e) { dwarn('backup counter bump 실패', e); }
    }
    // v0.6.5: 활성 run의 override 개수 계산 (phase 재실행 가드용)
    function countReviewOverridesForRun(runId) {
        if (!runId) return 0;
        const bucket = loadReviewOverrides()[runId];
        return bucket ? Object.keys(bucket).length : 0;
    }

    // v0.6.6 (B1): 고아 override 정리 — 알려진 batch run 또는 활성 run 외 버킷 + 활성 run 내 phase3에 없는 ID 정리
    function gcOrphanReviewOverrides(options = {}) {
        const all = loadReviewOverrides();
        const allRunIds = Object.keys(all);
        if (!allRunIds.length) return { removedRunIds: [], removedItems: [], totalItemsRemoved: 0, runIdsKept: [] };

        const knownRuns = lsGet(LS_KEYS.BATCH_RUNS, {}) || {};
        const knownRunIds = new Set(Object.keys(knownRuns));
        const activeRunId = lsGet(LS_KEYS.ACTIVE_BATCH_RUN, null);
        if (activeRunId) knownRunIds.add(activeRunId);

        const removedRunIds = [];
        const removedItems = [];
        for (const runId of allRunIds) {
            const bucket = all[runId] || {};
            if (!knownRunIds.has(runId)) {
                removedRunIds.push(runId);
                for (const itemId of Object.keys(bucket)) removedItems.push({ runId, id: itemId });
                delete all[runId];
                continue;
            }
            // 활성 run의 경우 phase3에 더 이상 존재하지 않는 ID도 정리
            if (options.pruneMissingIds !== false && runId === activeRunId) {
                const run = knownRuns[runId];
                const phase3Ids = new Set((run?.phase3?.parsed?.translations || []).map(it => normalizeId(it.id)));
                if (phase3Ids.size === 0) continue; // phase3 없으면 정리 보류
                for (const itemId of Object.keys(bucket)) {
                    if (!phase3Ids.has(normalizeId(itemId))) {
                        removedItems.push({ runId, id: itemId });
                        delete bucket[itemId];
                    }
                }
                if (!Object.keys(bucket).length) delete all[runId];
            }
        }
        if (removedRunIds.length || removedItems.length) saveReviewOverrides(all);
        return {
            removedRunIds,
            removedItems,
            totalItemsRemoved: removedItems.length,
            runIdsKept: Object.keys(all),
        };
    }

    // v0.6.7 (C2): 같은 project/file/language 컨텍스트의 직전 run 후보 목록.
    // - currentRun을 제외하고 updatedAt 내림차순 정렬.
    // - phase3 결과가 있는 run만 비교 의미가 있으므로 그것만 노출.
    function findPriorRunsForCurrent(runs, currentRun) {
        if (!currentRun) return [];
        const list = Object.values(runs || {})
            .filter(r => r && r.runId && r.runId !== currentRun.runId)
            .filter(r =>
                String(r.projectId) === String(currentRun.projectId) &&
                String(r.fileId) === String(currentRun.fileId) &&
                String(r.languageId) === String(currentRun.languageId))
            .filter(r => Array.isArray(r.phase3?.parsed?.translations) && r.phase3.parsed.translations.length > 0)
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return list;
    }

    // v0.6.7 (C2): 두 run 사이의 phase3/phase45 final 텍스트 diff 행 빌드.
    // override는 의도적으로 무시 — "LLM 결과 자체"의 drift만 보기 위함.
    // v0.7.0 B5: options.includeOverrides=true 면 override를 final에 덮어 비교한다
    //           (사용자가 실제 적용한 결과 기준 drift 확인용)
    function buildRunCompareRows(currentRun, priorRun, options = {}) {
        if (!currentRun || !priorRun) return [];
        const includeOverrides = !!options.includeOverrides;
        const overlay = (run, id) => {
            const phase3 = (run.phase3?.parsed?.translations || []).find(t => normalizeId(t.id) === id);
            const rev = (run.phase45?.parsed?.revisions || []).find(r => normalizeId(r.id) === id);
            const phase45Ok = !!run.phase45?.validation?.ok;
            let finalText = phase3?.t || '';
            let overrideText = null;
            if (phase45Ok && rev) {
                if (rev.t !== null && rev.t !== undefined) finalText = String(rev.t);
            }
            if (includeOverrides) {
                overrideText = getReviewOverride(run.runId, id);
                if (overrideText !== null && overrideText !== undefined) finalText = overrideText;
            }
            return {
                phase3Text: phase3?.t || '',
                finalText,
                overrideText,
                src: phase3?.src || '',
                gid: phase3?.gid || '',
            };
        };
        const ids = new Set();
        (currentRun.phase3?.parsed?.translations || []).forEach(t => ids.add(normalizeId(t.id)));
        (priorRun.phase3?.parsed?.translations || []).forEach(t => ids.add(normalizeId(t.id)));
        const rows = [];
        for (const id of ids) {
            const cur = overlay(currentRun, id);
            const prev = overlay(priorRun, id);
            const sameFinal = cur.finalText === prev.finalText;
            const samePhase3 = cur.phase3Text === prev.phase3Text;
            rows.push({
                id,
                gid: cur.gid || prev.gid,
                src: cur.src || prev.src,
                priorPhase3: prev.phase3Text,
                priorFinal: prev.finalText,
                currentPhase3: cur.phase3Text,
                currentFinal: cur.finalText,
                priorOverride: prev.overrideText || null,
                currentOverride: cur.overrideText || null,
                sameFinal,
                samePhase3,
                onlyInCurrent: !prev.phase3Text && !!cur.phase3Text,
                onlyInPrior: !cur.phase3Text && !!prev.phase3Text,
            });
        }
        return rows.sort((a, b) => Number(a.id) - Number(b.id));
    }

    // v0.6.7 (C3): run 한 개를 CSV로 직렬화. RFC 4180 호환 (CRLF 줄바꿈, 큰따옴표 이스케이프).
    function buildCsvFromRun(run) {
        if (!run) return '';
        const segById = new Map((run.segments || []).map(s => [normalizeId(s.id), s]));
        const phase3ById = new Map((run.phase3?.parsed?.translations || []).map(t => [normalizeId(t.id), t]));
        const revById = new Map((run.phase45?.parsed?.revisions || []).map(r => [normalizeId(r.id), r]));
        const phase45Ok = !!run.phase45?.validation?.ok;
        const overrides = lsGet(LS_KEYS.REVIEW_OVERRIDES, {})?.[run.runId] || {};
        const ids = new Set();
        for (const id of phase3ById.keys()) ids.add(id);
        for (const id of segById.keys()) ids.add(id);
        const idList = Array.from(ids).sort((a, b) => Number(a) - Number(b));

        const headers = ['id', 'gid', 'origin', 'phase3', 'phase45_revision', 'phase45_reasons', 'override', 'final', 'has_override'];
        const esc = (v) => {
            const s = v == null ? '' : String(v);
            if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
        };
        const lines = [headers.join(',')];
        for (const id of idList) {
            const seg = segById.get(id);
            const phase3 = phase3ById.get(id);
            const rev = revById.get(id);
            const overrideEntry = overrides[id];
            const overrideText = overrideEntry == null ? ''
                : (typeof overrideEntry === 'string' ? overrideEntry : (overrideEntry.text || ''));
            let finalText = phase3?.t || '';
            if (phase45Ok && rev && rev.t !== null && rev.t !== undefined) finalText = String(rev.t);
            if (overrideText) finalText = overrideText;
            lines.push([
                id,
                phase3?.gid || '',
                seg?.origin_string || '',
                phase3?.t || '',
                rev ? (rev.t === null ? '<keep>' : (rev.t || '')) : '',
                rev && Array.isArray(rev.r) ? rev.r.join('|') : '',
                overrideText,
                finalText,
                overrideText ? '1' : '0',
            ].map(esc).join(','));
        }
        return lines.join('\r\n') + '\r\n';
    }

    // v0.6.7 (C3): run 직렬화 JSON — raw 필드는 용량을 키워 별도 토글로 포함.
    function buildJsonExportFromRun(run, options = {}) {
        if (!run) return '';
        const includeRaw = !!options.includeRaw;
        const cloned = JSON.parse(JSON.stringify(run));
        if (!includeRaw) {
            if (cloned.phase12) delete cloned.phase12.raw;
            if (cloned.phase3) delete cloned.phase3.raw;
            if (cloned.phase45) delete cloned.phase45.raw;
        }
        cloned.exportedAt = new Date().toISOString();
        cloned.exportedFromVersion = '0.6.9';
        return JSON.stringify(cloned, null, 2);
    }

    // v0.6.7 (D1): 로그 행을 한 단위 객체로 정규화. type/level은 lower-case.
    function buildFilteredLogLines(logs, level, query) {
        const list = Array.isArray(logs) ? logs : [];
        const lvl = (level || 'all').toLowerCase();
        const q = (query || '').trim().toLowerCase();
        return list
            .filter(log => {
                if (lvl !== 'all' && String(log.type || 'info').toLowerCase() !== lvl) return false;
                if (q && !String(log.message || '').toLowerCase().includes(q)) return false;
                return true;
            })
            .map(log => `[${log.at}] ${String(log.type || 'info').toUpperCase()} ${log.message || ''}`);
    }

    // v0.6.7 (C3/D1): 클라이언트 다운로드 헬퍼.
    function downloadTextFile(filename, mime, content) {
        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch {} }, 100);
    }

    // ========================================================================
    // v0.6.0 L1: batch 결과를 chat 세션 system 메시지로 시드
    // ========================================================================
    function importBatchResultToChat(stringId, run, options = {}) {
        const id = normalizeId(stringId);
        if (!run) throw new Error('활성 batch run이 없습니다.');
        const phase45Ok = !!run.phase45?.validation?.ok;
        const requested = options.phase || 'auto';
        const phase = (requested === 'phase45' || (requested === 'auto' && phase45Ok)) ? 'phase45' : 'phase3';

        const phase3Item = (run.phase3?.parsed?.translations || []).find(t => normalizeId(t.id) === id);
        const revisionItem = (run.phase45?.parsed?.revisions || []).find(r => normalizeId(r.id) === id);
        const segItem = (run.segments || []).find(s => normalizeId(s.id) === id);

        let candidateText = '';
        if (phase === 'phase45' && revisionItem && revisionItem.t !== null && revisionItem.t !== undefined) {
            candidateText = String(revisionItem.t);
        } else if (phase3Item) {
            candidateText = String(phase3Item.t || '');
        }
        if (!candidateText) throw new Error(`#${id} 배치 결과에서 사용할 텍스트가 없습니다.`);

        const sysLines = [];
        sysLines.push(`이 세션은 batch run ${run.runId || '?'} 의 ${phase} 결과로 시드되었습니다.`);
        if (segItem?.origin_string) sysLines.push(`원문: ${segItem.origin_string}`);
        if (phase3Item?.t) sysLines.push(`Phase 3 후보: ${phase3Item.t}`);
        if (revisionItem) {
            if (revisionItem.t === null) {
                sysLines.push(`Phase 4+5: 유지 (Phase 3 그대로 사용)`);
            } else if (revisionItem.t !== undefined) {
                const reasons = Array.isArray(revisionItem.r) && revisionItem.r.length ? ` [근거: ${revisionItem.r.join(', ')}]` : '';
                sysLines.push(`Phase 4+5 수정안: ${revisionItem.t}${reasons}`);
            }
        }

        // v0.6.6 (C1): 같은 gid의 다른 세그먼트 샘플 (톤/스타일 일관성 참고용, 최대 5개)
        if (phase3Item?.gid) {
            const segById = new Map((run.segments || []).map(s => [normalizeId(s.id), s]));
            const revById = new Map(((run.phase45?.parsed?.revisions) || []).map(r => [normalizeId(r.id), r]));
            const siblings = (run.phase3?.parsed?.translations || [])
                .filter(it => it.gid === phase3Item.gid && normalizeId(it.id) !== id)
                .slice(0, 5);
            if (siblings.length) {
                const lines = siblings.map(it => {
                    const sid = normalizeId(it.id);
                    const src = segById.get(sid)?.origin_string || '';
                    const rev = revById.get(sid);
                    const finalText = (rev && rev.t !== null && rev.t !== undefined) ? String(rev.t) : it.t;
                    return `- #${sid}: "${src}" → "${finalText}"`;
                });
                sysLines.push(`[같은 그룹 ${phase3Item.gid} 샘플 ${siblings.length}개 (톤/스타일 참고)]\n${lines.join('\n')}`);
            }
        }

        // v0.6.6 (C1): 세그먼트별 TB 용어 매핑 (segment.match_terms)
        if (Array.isArray(segItem?.match_terms) && segItem.match_terms.length) {
            const terms = segItem.match_terms
                .map(t => {
                    const src = t?.trans?.['zh-Hans'] || t?.trans?.zh || '';
                    const dst = t?.trans?.ko || '';
                    return (src && dst) ? `- ${src} → ${dst}` : null;
                })
                .filter(Boolean);
            if (terms.length) sysLines.push(`[적용 용어 (TB)]\n${terms.join('\n')}`);
        }

        // v0.6.6 (C1): 글자수 제한
        if (segItem?.char_limit && segItem.char_limit > 0) {
            sysLines.push(`[글자수 제한] ${segItem.char_limit}자`);
        }

        sysLines.push(`이 후보를 출발점으로, 이후 사용자 요청에 따라 다듬으세요. 같은 그룹의 톤/용어를 일관되게 유지하세요.`);
        const systemText = sysLines.join('\n');

        const session = getSession(id);
        session.messages = [{ role: 'ai', content: candidateText }];
        session.system = systemText;
        session.source = 'batch_import';
        session.importedFromRunId = run.runId || null;
        session.importedAt = new Date().toISOString();
        setSession(id, session);
        return { phase, text: candidateText };
    }

    // ========================================================================
    // 컨텍스트 수집
    // ========================================================================
    function buildSegmentContext(segment) {
        if (!segment) return '';

        const parts = [];
        parts.push(`[원문]\n${segment.origin_string || ''}`);

        if (segment.char_limit && segment.char_limit > 0) {
            parts.push(`[글자수 제한] ${segment.char_limit}자`);
        }

        if (segment.match_terms && segment.match_terms.length > 0) {
            const terms = segment.match_terms
                .map(t => {
                    const src = t.trans?.['zh-Hans'] || t.trans?.zh || '';
                    const dst = t.trans?.ko || '';
                    return (src && dst) ? `- ${src} → ${dst}` : null;
                })
                .filter(Boolean);
            if (terms.length) {
                parts.push(`[용어집]\n${terms.join('\n')}`);
            }
        }

        if (segment.context) {
            parts.push(`[Context ID] ${segment.context}`);
        }

        return parts.join('\n\n');
    }

    // ========================================================================
    // 프롬프트 조립
    // ========================================================================
    function buildPrefixPrompt(systemPrompt, segmentContext, history, userMessage, sessionSystem) {
        const sections = [];

        if (systemPrompt && systemPrompt.trim()) {
            sections.push(`=== 시스템 지침 ===\n${systemPrompt.trim()}`);
        }

        // v0.6.0 L1: batch import 시드된 컬텍스트 (segment context 보다 먼저 표시)
        if (sessionSystem && String(sessionSystem).trim()) {
            sections.push(`=== 배치 컬텍스트 ===\n${String(sessionSystem).trim()}`);
        }

        if (segmentContext) {
            sections.push(`=== 세그먼트 정보 ===\n${segmentContext}`);
        }

        if (history && history.length > 0) {
            const historyText = history
                .map(m => `[${m.role === 'user' ? '사용자' : 'AI'}]\n${m.content}`)
                .join('\n\n');
            sections.push(`=== 이전 대화 ===\n${historyText}`);
        }

        sections.push(`=== 현재 요청 ===\n${userMessage}`);
        // v0.3.3: 워크플로우 모드에서는 기본 OUTPUT_RULE 생략
        // (v3.1 프롬프트 등 JSON 출력을 요구하는 시스템 프롬프트에서 사용)
        const isWorkflowMode = systemPrompt && (
            systemPrompt.includes('[WORKFLOW_MODE]') ||
            systemPrompt.includes('CURRENT_PHASE')
        );
        if (!isWorkflowMode) {
            sections.push(OUTPUT_RULE);
        }

        return sections.join('\n\n---\n\n');
    }

    // ========================================================================
    // Batch workflow state + prompt builders
    // ========================================================================
    function loadBatchRuns() {
        return lsGet(LS_KEYS.BATCH_RUNS, {});
    }

    function saveBatchRuns(runs) {
        // GC: 최근 updatedAt 기준 BATCH_RUNS_LIMIT개만 보관. activeRunId는 무조건 포함.
        const ids = Object.keys(runs || {});
        if (ids.length > BATCH_RUNS_LIMIT) {
            const activeId = getActiveBatchRunId();
            const sorted = ids
                .map(id => ({ id, ts: runs[id]?.updatedAt || runs[id]?.createdAt || '' }))
                .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
            const keep = new Set(sorted.slice(0, BATCH_RUNS_LIMIT).map(x => x.id));
            if (activeId) keep.add(activeId);
            for (const id of ids) {
                if (!keep.has(id)) delete runs[id];
            }
        }
        lsSet(LS_KEYS.BATCH_RUNS, runs);
    }

    function getActiveBatchRunId() {
        return lsGet(LS_KEYS.ACTIVE_BATCH_RUN, null);
    }

    function setActiveBatchRunId(runId) {
        lsSet(LS_KEYS.ACTIVE_BATCH_RUN, runId);
    }

    function makeBatchRunId(params) {
        const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
        return `${stamp}-file${params.fileId || 'unknown'}`;
    }

    function batchRunMatchesCurrentUrl(run) {
        if (!run) return false;
        const params = getUrlParams();
        // page 키는 비교하지 않는다. 페이지 이동 후 돌아와도 활성 런을 잃지
        // 않게 하기 위함. (project/file/language가 같으면 재시잡이다.)
        return String(run.projectId) === String(params.projectId || '') &&
            String(run.fileId) === String(params.fileId || '') &&
            String(run.languageId) === String(params.languageId || '');
    }

    function persistBatchRun(run) {
        if (!run) return;
        // 이전 디바운스 예약이 있으면 모두 치우고 즉시 쓰기로 적용.
        if (_batchPersistTimer) {
            clearTimeout(_batchPersistTimer);
            _batchPersistTimer = null;
            _batchPersistPending = null;
        }
        const prevStatus = (() => { try { return loadBatchRuns()[run.runId]?.status; } catch { return null; } })();
        run.updatedAt = new Date().toISOString();
        const runs = loadBatchRuns();
        runs[run.runId] = run;
        saveBatchRuns(runs);
        setActiveBatchRunId(run.runId);
        // v0.7.7 (#12): phase45 완료 전이(신규/재시도)에만 backup trigger
        if (run.status === 'phase45_ready' && prevStatus !== 'phase45_ready') {
            try { triggerBackupAsync('run-complete'); } catch (e) { dwarn('run-complete backup 실패', e); }
        }
    }

    // appendBatchLog 같은 핫패스얩. 다음 중요 이벤트(persistBatchRun 직호출)
    // 또는 BATCH_LOG_PERSIST_DEBOUNCE_MS 경과 시 플러시된다.
    let _batchPersistTimer = null;
    let _batchPersistPending = null;
    function persistBatchRunDebounced(run) {
        if (!run) return;
        _batchPersistPending = run;
        if (_batchPersistTimer) return;
        _batchPersistTimer = setTimeout(() => {
            const pending = _batchPersistPending;
            _batchPersistTimer = null;
            _batchPersistPending = null;
            if (pending) persistBatchRun(pending);
        }, BATCH_LOG_PERSIST_DEBOUNCE_MS);
    }
    // 페이지 숨김/닫힘 시 디바운스 대기중인 로그를 손실하지 않도록 즉시 플러시.
    window.addEventListener('pagehide', () => {
        if (_batchPersistPending) persistBatchRun(_batchPersistPending);
    });

    function clearActiveBatchRun() {
        const runId = batchRun?.runId || getActiveBatchRunId();
        if (runId) {
            const runs = loadBatchRuns();
            delete runs[runId];
            saveBatchRuns(runs);
        }
        lsSet(LS_KEYS.ACTIVE_BATCH_RUN, null);
        batchRun = null;
        renderBatchRun();
    }

    function restoreActiveBatchRun() {
        const runId = getActiveBatchRunId();
        if (!runId) return null;
        const runs = loadBatchRuns();
        const run = runs[runId] || null;
        if (run && !batchRunMatchesCurrentUrl(run)) {
            lsSet(LS_KEYS.ACTIVE_BATCH_RUN, null);
            return null;
        }
        // stale 마킹은 idempotent해야 한다. 이미 stale로 설정된 run을 다시 불러도
        // 경고 로그가 중복 push되지 않는다.
        if (run && isBatchBusy(run.status)) {
            run.status = 'stale';
            run.lastError = '이전 실행이 진행 중 상태에서 중단되었습니다. 결과 다시 읽기 또는 Phase 재실행을 선택하세요.';
            run.logs = run.logs || [];
            run.logs.push({
                at: new Date().toISOString(),
                type: 'warn',
                message: run.lastError,
            });
            runs[runId] = run;
            saveBatchRuns(runs);
        }
        return run;
    }

    // LS를 단일 source-of-truth로 강제. 모달 재오픈/탭 변경 등 시점에서 호출하면
    // 메모리의 stale batchRun을 LS 상태에 맞게 재동기화한다.
    function syncBatchRunFromLs() {
        const runId = getActiveBatchRunId();
        if (!runId) {
            // LS에 활성 run이 없으면 메모리도 비워 다른 URL의 stale 런이 남지 않게.
            batchRun = null;
            return null;
        }
        const restored = restoreActiveBatchRun();
        batchRun = restored;
        return restored;
    }

    function createBatchRunBase() {
        const params = getUrlParams();
        const page = parseInt(params.page || '1', 10) || 1;
        const pageSize = parseInt(params.pageSize || String(BATCH_DEFAULT_PAGE_SIZE), 10) || BATCH_DEFAULT_PAGE_SIZE;
        const run = {
            runId: makeBatchRunId(params),
            projectId: parseRequiredInt(params.projectId, 'projectId'),
            fileId: parseRequiredInt(params.fileId, 'fileId'),
            languageId: parseRequiredInt(params.languageId, 'languageId'),
            page,
            pageSize,
            model: getSelectedModel(),
            scope: 'current_page',
            status: 'idle',
            segments: [],
            notesByStringId: {},
            storageStringId: null,
            initialStorageRaw: '',
            tbSummary: [],
            phase12: null,
            phase3: null,
            phase45: null,
            validations: {},
            logs: [],
            lastExpectedPhase: null,
            lastError: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        persistBatchRun(run);
        return run;
    }

    function ensureBatchRun() {
        if (!batchRun) {
            batchRun = restoreActiveBatchRun() || createBatchRunBase();
        }
        return batchRun;
    }

    function appendBatchLog(message, type = 'info') {
        const run = ensureBatchRun();
        run.logs.push({
            at: new Date().toISOString(),
            type,
            message,
        });
        if (run.logs.length > 300) run.logs = run.logs.slice(-300);
        // 핫패스 LS 쓰기를 디바운스. 중요 상태 변경(setBatchStatus,
        // phase 결과, error, clearActiveBatchRun 등)은 다른 경로에서 persistBatchRun으로
        // 즉시 플러시되므로 일관성이 유지된다.
        persistBatchRunDebounced(run);
        renderBatchRun();
    }

    function setBatchStatus(status) {
        const run = ensureBatchRun();
        run.status = status;
        persistBatchRun(run);
        renderBatchRun();
    }

    async function fetchCurrentPageSegments(run) {
        const url = `/api/translate/strings/?project=${run.projectId}&target_language=${run.languageId}&file=${run.fileId}&page=${run.page}&page_size=${run.pageSize}`;
        const data = await apiJson(url);
        return normalizeSegmentListResponse(data);
    }

    async function fetchBatchNotes(expectedIds) {
        if (!expectedIds.length) return {};
        // 레퍼런스 주의: string_notes 는 반복 파라미터 형식만 지원하며, URL 길이가 ~8KB를 넘으면 서버가 502/무응답이 될 수 있다.
        // 100개 청크 (약 1.6KB)로 분할해 순차 조회 후 머지. dedupe 동일 id 중복 제거.
        const CHUNK_SIZE = 100;
        const uniqueIds = Array.from(new Set(expectedIds.map(id => String(id))));
        const notesByStringId = {};
        for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
            const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
            const query = chunk.map(id => `strings=${encodeURIComponent(id)}`).join('&');
            const noteData = await apiJson(`/api/translate/string_notes/?${query}`);
            for (const note of (noteData.data || [])) {
                for (const sid of (note.strings || [])) {
                    const id = normalizeId(sid);
                    const bucket = (notesByStringId[id] ||= []);
                    // 청크가 나뉘어도 동일 note.id가 여러 청크에 속한 세그먼트를 공유할 수 있으므로
                    // (note.strings 배열이 청크 경계를 걸칠 때) note.id 기준 dedupe.
                    if (note.id != null && bucket.some(n => n._id === note.id)) continue;
                    bucket.push({ col: note.col, content: note.content, _id: note.id });
                }
            }
        }
        // 내부 _id 키는 소비측에 노출할 필요 없으므로 제거.
        for (const id of Object.keys(notesByStringId)) {
            notesByStringId[id] = notesByStringId[id].map(({ col, content }) => ({ col, content }));
        }
        return notesByStringId;
    }

    async function fetchSavedResultSnapshot(storageStringId) {
        const seg = await fetchSegmentDetail(storageStringId);
        return {
            raw: seg?.active_result?.result || '',
            segment: seg,
        };
    }

    function getWorkflowBasePrompt() {
        const activePrompt = getBatchActivePrompt();
        const content = activePrompt?.content || '';
        if (!content.trim()) {
            throw new Error('배치 실행에는 v3.1 워크플로우 시스템 프롬프트가 필요합니다. 설정에서 프롬프트를 먼저 선택하세요.');
        }
        return content.trim();
    }

    function formatBatchSegmentList(run) {
        return (run.segments || []).map((seg, index) => {
            const id = normalizeId(seg.id);
            const notes = (run.notesByStringId?.[id] || [])
                .sort((a, b) => a.col - b.col)
                .map(note => `  - [col${note.col}] ${note.content}`)
                .join('\n');

            const terms = (seg.match_terms || [])
                .map(term => {
                    const src = term.trans?.['zh-Hans'] || term.trans?.zh || '';
                    const dst = term.trans?.ko || '';
                    return src && dst ? `  - ${src} → ${dst}` : null;
                })
                .filter(Boolean)
                .join('\n');

            const lines = [
                `## #${index + 1} (id: ${id})`,
                `- 원문: "${seg.origin_string || ''}"`,
            ];
            if (seg.char_limit > 0) lines.push(`- 글자수 제한: ${seg.char_limit}자`);
            if (seg.context) lines.push(`- Context: ${seg.context}`);
            if (terms) lines.push(`- TB 용어:\n${terms}`);
            if (notes) lines.push(`- 备注:\n${notes}`);
            return lines.join('\n');
        }).join('\n\n');
    }

    function buildBatchPhasePrompt(phaseTag, run, extraBlocks, finalInstruction) {
        const tbSummaryBlock = formatBatchTbSummary(run.tbSummary || buildBatchTbSummary(run.segments));
        return [
            getWorkflowBasePrompt(),
            '---',
            '# 파일 정보',
            `- 프로젝트 ID: ${run.projectId}`,
            `- 파일 ID: ${run.fileId}`,
            `- 처리 대상: 현재 페이지 ${run.segments.length}개 세그먼트`,
            '',
            ...(tbSummaryBlock ? [tbSummaryBlock, ''] : []),
            '# 번역 대상 세그먼트 목록',
            formatBatchSegmentList(run),
            '',
            ...(extraBlocks.length ? [...extraBlocks, ''] : []),
            '---',
            '',
            `[CURRENT_PHASE: ${phaseTag}]`,
            '',
            finalInstruction,
        ].join('\n');
    }

    function getBatchExpectedIds(run) {
        return (run.segments || []).map(seg => normalizeId(seg.id));
    }

    function buildPhase12CompactPrompt(run) {
        const expectedIds = getBatchExpectedIds(run);
        return buildBatchPhasePrompt(
            '1+2',
            run,
            [
                '---',
                '# Compact JSON output contract',
                '이 UI 실행에서는 상세 Phase 1+2 출력 스키마를 사용하지 않습니다.',
                '아래 compact 스키마만 사용하세요. 문자열 설명은 짧게 쓰고, reason/next_step_proposal/긴 문장 필드는 만들지 마세요.',
                '',
                '# Allowed IDs',
                'groups[].ids에는 아래 id만 사용할 수 있습니다.',
                '목록에 없는 인접 id, 추정 id, 숨은 id를 절대 추가하지 마세요.',
                'ID가 3씩 증가해 보여도 누락된 중간/앞뒤 id를 생성하지 마세요.',
                JSON.stringify(expectedIds),
                '',
                '```json',
                '{',
                '  "phase": "1+2",',
                '  "cats": [13, 2],',
                '  "note_schema": {"col8": "placeholder_zh", "col9": "placeholder_en"},',
                '  "groups": [',
                '    {"gid": "G1", "ids": [5840062], "cats": [13], "tone": "formal_mail", "rules": ["preserve_placeholders", "use_tb_terms"]}',
                '  ],',
                '  "global_rules": ["preserve_value_tokens"]',
                '}',
                '```',
            ],
            [
                `${run.segments.length}개 전체 세그먼트에 대해 Phase 1+2 분석을 수행하세요.`,
                '출력은 compact JSON 한 개만 허용합니다.',
                '모든 Allowed IDs가 정확히 하나의 groups[].ids에 포함되어야 합니다.',
                'Allowed IDs 밖의 id는 하나도 출력하지 마세요.',
                '설명형 문장, 마크다운, 추가 필드는 출력하지 마세요.',
            ].join('\n')
        );
    }

    function buildPhase3CompactPrompt(run) {
        const expectedIds = getBatchExpectedIds(run);
        return buildBatchPhasePrompt(
            '3',
            run,
            [
                '---',
                '# 확정된 Phase 1+2 compact 결과',
                '아래 JSON은 직전 단계의 확정 결과입니다. gid, ids, cats, tone, rules를 그대로 사용하세요.',
                '```json',
                JSON.stringify(run.phase12.parsed, null, 2),
                '```',
                '',
                '# Phase 3 compact output contract',
                '아래 스키마만 사용하세요. 설명, markdown, summary, warnings, notes 필드는 만들지 마세요.',
                '번역문 t는 JSON 문자열이어야 하며 줄바꿈은 반드시 \\n으로 이스케이프하세요.',
                '```json',
                '{',
                '  "phase": "3",',
                '  "translations": [',
                '    {"id": 5840062, "gid": "G1", "t": "번역문"}',
                '  ]',
                '}',
                '```',
                '',
                '# Allowed IDs',
                'translations[].id에는 아래 id만 사용할 수 있습니다.',
                JSON.stringify(expectedIds),
            ],
            [
                `${run.segments.length}개 전체 세그먼트에 대해 Phase 3 번역을 수행하세요.`,
                'Phase 1+2 compact 결과의 그룹 전략을 그대로 따르세요.',
                '모든 Allowed IDs가 정확히 하나의 translations[] 항목에 포함되어야 합니다.',
                'translations[].gid는 Phase 1+2 groups[].gid와 반드시 일치해야 합니다.',
                'Allowed IDs 밖의 id는 하나도 출력하지 마세요.',
                '번역문에는 한국어 번역만 넣고 설명을 섞지 마세요.',
                'placeholder와 value token은 원문 그대로 보존하세요.',
            ].join('\n')
        );
    }

    function buildPhase45CompactPrompt(run) {
        const expectedIds = getBatchExpectedIds(run);
        return buildBatchPhasePrompt(
            '4+5',
            run,
            [
                '---',
                '# 확정된 Phase 1+2 compact 결과',
                '아래 JSON은 확정된 그룹 전략입니다. 새 분석을 만들지 말고 그대로 따르세요.',
                '```json',
                JSON.stringify(run.phase12.parsed, null, 2),
                '```',
                '',
                '# 확정된 Phase 3 compact 결과',
                '아래 JSON의 translations[].t를 기준으로 검수하세요.',
                '```json',
                JSON.stringify(run.phase3.parsed, null, 2),
                '```',
                '',
                '# Phase 4+5 compact output contract',
                '아래 스키마만 사용하세요. summary, notes, markdown, 긴 설명 필드는 만들지 마세요.',
                't가 null이면 Phase 3 번역을 그대로 최종안으로 사용한다는 뜻입니다.',
                '수정이 필요할 때만 t에 수정 번역문을 넣으세요.',
                'r은 짧은 reason code 배열만 허용합니다. 예: "term", "placeholder", "style", "char_limit", "grammar"',
                '```json',
                '{',
                '  "phase": "4+5",',
                '  "revisions": [',
                '    {"id": 5840062, "gid": "G1", "t": null, "r": []}',
                '  ]',
                '}',
                '```',
                '',
                '# Allowed IDs',
                'revisions[].id에는 아래 id만 사용할 수 있습니다.',
                JSON.stringify(expectedIds),
            ],
            [
                `${run.segments.length}개 전체 세그먼트에 대해 Phase 4+5 검수를 수행하세요.`,
                'Phase 3 번역을 기준으로 검수만 수행하고, 번역을 처음부터 다시 만들지 마세요.',
                '모든 Allowed IDs가 정확히 하나의 revisions[] 항목에 포함되어야 합니다.',
                'revisions[].gid는 Phase 3 translations[].gid와 반드시 일치해야 합니다.',
                'Allowed IDs 밖의 id는 하나도 출력하지 마세요.',
                '문제 없으면 반드시 {"t": null, "r": []} 형태로 유지하세요.',
                '수정 번역문 t에는 한국어 최종 번역만 넣고 설명을 섞지 마세요.',
                'placeholder와 value token은 원문 그대로 보존하세요.',
            ].join('\n')
        );
    }

    async function waitForExpectedBatchResult(run, expectedPhase, previousRaw) {
        let lastRaw = '';
        let lastParsed = null;
        let lastInspection = null;

        for (let attempt = 1; attempt <= BATCH_RESULT_RETRY_ATTEMPTS; attempt++) {
            const { raw } = await fetchSavedResultSnapshot(run.storageStringId);
            lastRaw = raw;
            let parsed = null;
            try {
                parsed = parseWorkflowJson(raw);
                lastParsed = parsed;
                lastInspection = { ok: true, parsed };
            } catch (error) {
                lastInspection = inspectSavedJson(raw);
            }

            const changed = raw !== previousRaw;
            const savedIssue = parsed ? null : classifySavedResult(raw);
            appendBatchLog(`결과 조회 ${attempt}차: changed=${changed}, phase=${parsed?.phase || '미확인'}, length=${raw.length}, issue=${savedIssue?.type || '-'}`);

            if (savedIssue) {
                throw makeWorkflowError(`${expectedPhase} 저장 결과가 ${savedIssue.type}입니다. ${savedIssue.message}`, savedIssue.type);
            }

            if (parsed?.phase === expectedPhase && changed) {
                return { raw, parsed };
            }

            await sleep(BATCH_RESULT_RETRY_INTERVAL_MS);
        }

        if (lastParsed?.phase === expectedPhase) {
            throw makeWorkflowError(`${expectedPhase} 결과가 기존 저장본과 같아 새 결과 반영 여부를 확인할 수 없습니다. storage string을 정리하거나 결과 다시 읽기를 사용하세요.`, 'STALE_RESULT');
        }

        if (lastParsed?.phase && lastParsed.phase !== expectedPhase) {
            throw makeWorkflowError(`${expectedPhase} 대신 ${lastParsed.phase} 저장본이 확인되었습니다.`, 'STALE_RESULT');
        }

        if (lastRaw === previousRaw) {
            throw makeWorkflowError(`${expectedPhase} 결과가 저장본에 반영되지 않았습니다. storage string 기존 번역이 유지된 상태일 수 있습니다.`, 'STALE_RESULT');
        }

        if (lastInspection && !lastInspection.ok) {
            const context = lastInspection.context?.position != null
                ? ` 위치=${lastInspection.context.position}`
                : '';
            throw makeWorkflowError(`${expectedPhase} 결과 JSON 파싱 실패:${context} ${lastInspection.error.message}`, 'PARSE_ERROR');
        }

        throw new Error(`${expectedPhase} 결과가 저장본에서 확인되지 않았습니다.`);
    }

    // ========================================================================
    // 모달 UI
    // ========================================================================
    let modalEl = null;
    let currentStringId = null;
    let currentSegment = null;
    let currentMainTab = 'chat';
    let batchRun = null;
    // v0.6.5 (A3): 리뷰 탭 필터/정렬 상태 (메모리 only — 세션 한정)
    // v0.6.7 (C2): 비교 모드 상태 추가 — compareMode/compareRunId 가 set 되면
    // 검토 표 대신 직전 run 비교 표가 렌더된다.
    const reviewView = { filter: 'all', sort: 'id', compareMode: false, compareRunId: null, compareIncludeOverrides: false, lastFailedIds: [], showOnlyFailed: false };
    // v0.6.7 (D1): 로그 탭 필터/검색 상태
    const logView = { level: 'all', query: '' };

    function createModal() {
        if (modalEl) return modalEl;

        const el = document.createElement('div');
        el.id = 'tms-workflow-modal';
        el.innerHTML = `
<div class="tw-header">
    <span class="tw-title">🎮 AI 번역 워크플로우</span>
    <span class="tw-seg-info"></span>
    <span class="tw-header-right">
        <button class="tw-btn tw-btn-ghost tw-btn-settings" title="시스템 프롬프트 설정">⚙️</button>
        <button class="tw-btn tw-btn-ghost tw-btn-close" title="닫기">✕</button>
    </span>
</div>
<div class="tw-main-tabs">
    <button class="tw-main-tab active" data-tab="chat">채팅</button>
    <button class="tw-main-tab" data-tab="batch">배치 실행</button>
    <button class="tw-main-tab" data-tab="review">결과 검토</button>
    <button class="tw-main-tab" data-tab="logs">JSON/로그</button>
</div>
<div class="tw-body tw-tab-content active" data-tab-content="chat">
    <div class="tw-context-panel">
        <div class="tw-panel-title">📄 세그먼트 정보</div>
        <div class="tw-context-content tw-muted">세그먼트 정보 로딩 중…</div>
    </div>
    <div class="tw-chat-panel">
        <div class="tw-chat-messages"></div>
        <div class="tw-chat-input-wrap">
            <div class="tw-input-controls">
                <label class="tw-ctrl">
                    프롬프트:
                    <select class="tw-prompt-select tw-chat-prompt-select"></select>
                </label>
                <label class="tw-ctrl">
                    모델:
                    <select class="tw-model-select"></select>
                </label>
            </div>
            <textarea class="tw-chat-input" placeholder="번역 요청 또는 수정 지시를 입력하세요... (Ctrl+Enter 전송)"></textarea>
            <div class="tw-chat-buttons">
                <button class="tw-btn tw-btn-ghost tw-btn-reset">세션 초기화</button>
                <button class="tw-btn tw-btn-primary tw-btn-adopt" disabled>번역 채택</button>
                <button class="tw-btn tw-btn-primary tw-btn-send">전송 ▶</button>
            </div>
        </div>
    </div>
</div>
<div class="tw-batch-panel tw-tab-content" data-tab-content="batch">
    <div class="tw-batch-sidebar">
        <div class="tw-batch-header-row">
            <div>
                <div class="tw-panel-title">배치 실행</div>
                <div class="tw-batch-meta tw-muted">현재 페이지를 수집한 뒤 Phase를 순서대로 실행합니다.</div>
            </div>
            <div class="tw-batch-header-right">
                <button class="tw-btn tw-btn-ghost tw-btn-toggle-compact" title="Phase stepper와 수집/검증 카드를 접어서 표를 더 빨리 보여줍니다 (localStorage 저장)" data-compact="0">📐 컴팩트</button>
                <div class="tw-batch-status">대기 중</div>
            </div>
        </div>
        <!-- v0.6.9 (G1-a): 활성 run 헤더 카드 -->
        <div class="tw-batch-run-header tw-hidden"></div>
        <!-- v0.6.9 (G1-b): Phase stepper -->
        <div class="tw-batch-stepper"></div>
        <!-- v0.6.9 (G1-d): 수집/검증 결과 카드 (클릭 시 review 탭 필터 자동 적용) -->
        <div class="tw-batch-summary-cards"></div>
        <!-- v0.6.9 hotfix2: 사용 모델/프롬프트 표시 -->
        <div class="tw-batch-config-row tw-muted"></div>
        <div class="tw-batch-warning tw-muted"></div>
        <!-- v0.6.9 hotfix2: 세그먼트 미리보기는 버튼 클릭 시 오버레이로 -->
        <button type="button" class="tw-btn tw-btn-ghost tw-btn-show-segments" disabled>📋 수집 세그먼트 보기</button>
    </div>
    <div class="tw-batch-chat-panel">
        <div class="tw-batch-timeline"></div>
        <!-- v0.6.9 hotfix2: 세그먼트 오버레이 (배치 패널 우측 영역 위로 떠오름) -->
        <div class="tw-batch-segments-overlay tw-hidden">
            <div class="tw-batch-segments-overlay-header">
                <span class="tw-batch-segments-overlay-title">수집 세그먼트</span>
                <button type="button" class="tw-btn tw-btn-ghost tw-btn-close-segments" title="닫기">✕</button>
            </div>
            <div class="tw-batch-segments-overlay-body tw-batch-segments"></div>
        </div>
        <div class="tw-batch-input-wrap">
            <div class="tw-input-controls">
                <label class="tw-ctrl">
                    배치 프롬프트:
                    <select class="tw-prompt-select tw-batch-prompt-select"></select>
                </label>
                <label class="tw-ctrl">
                    배치 모델:
                    <select class="tw-model-select tw-batch-model-select"></select>
                </label>
            </div>
            <div class="tw-batch-actions">
                <button class="tw-btn tw-btn-primary tw-btn-batch-collect">현재 페이지 수집</button>
                <button class="tw-btn tw-btn-primary tw-btn-phase12" disabled>Phase 1+2 실행</button>
                <button class="tw-btn tw-btn-primary tw-btn-phase3" disabled>Phase 3 실행</button>
                <button class="tw-btn tw-btn-primary tw-btn-phase45" disabled>Phase 4+5 실행</button>
                <button class="tw-btn tw-btn-ghost tw-btn-batch-refetch" disabled>결과 다시 읽기</button>
                <button class="tw-btn tw-btn-danger tw-btn-batch-reset">배치 초기화</button>
            </div>
        </div>
    </div>
</div>
<div class="tw-review-panel tw-tab-content" data-tab-content="review">
    <div class="tw-panel-title">결과 검토</div>
    <div class="tw-compare-banner-bar tw-hidden">
        <span class="tw-compare-banner-text">↔ 비교 모드</span>
        <label class="tw-review-compare-overrides-label" title="비교 시 직접 수정(override)을 final에 덮어 표시 (실제 적용 결과 기준 drift)">
            <input type="checkbox" class="tw-review-compare-overrides" /> override 포함
        </label>
        <button class="tw-btn tw-btn-ghost tw-btn-review-compare-exit" title="비교 모드 종료">↩ 검토로 돌아가기</button>
    </div>
    <div class="tw-review-summary tw-muted">아직 Phase 3 결과가 없습니다.</div>
    <div class="tw-review-toolbar">
        <span class="tw-review-toolbar-group" data-group="입력">
            <button class="tw-btn tw-btn-primary tw-btn-review-apply-selected" title="체크된 행만 일괄 입력 (textarea 값 주입까지만 수행)">선택 입력</button>
            <button class="tw-btn tw-btn-ghost tw-btn-review-apply-edited" title="Phase 4+5에서 수정된 행만 일괄 입력">수정만 입력</button>
            <button class="tw-btn tw-btn-ghost tw-btn-review-apply-all" title="모든 행 일괄 입력">전체 입력</button>
        </span>
        <span class="tw-review-toolbar-divider"></span>
        <span class="tw-review-toolbar-group" data-group="보기">
            <label class="tw-review-filter-label">필터
                <select class="tw-review-filter">
                    <option value="all">전체</option>
                    <option value="edited">Phase4+5 수정만</option>
                    <option value="kept">유지만</option>
                    <option value="overridden">직접 수정만</option>
                    <option value="placeholder">placeholder 누락</option>
                    <option value="hanja">한자 잔존</option>
                    <option value="applied">자동 적용됨</option>
                    <option value="drifted">적용 후 변경됨</option>
                    <option value="warn-charlimit">⚠ 길이 초과</option>
                    <option value="warn-order">⚠ placeholder 순서</option>
                    <option value="warn-tb">⚠ TB 용어 누락</option>
                </select>
            </label>
            <label class="tw-review-filter-label">정렬
                <select class="tw-review-sort">
                    <option value="id">ID</option>
                    <option value="group">그룹</option>
                    <option value="state">상태</option>
                </select>
            </label>
            <button class="tw-btn tw-btn-ghost tw-btn-review-failed-toggle tw-hidden" title="직전 일괄 입력에서 실패한 ID만 보기">🔁 실패만 보기</button>
            <span class="tw-review-failed-chips tw-hidden" title="클릭하면 해당 행으로 이동"></span>
        </span>
        <span class="tw-review-apply-status tw-muted">입력은 textarea 값 주입까지만 수행합니다.</span>
        <span class="tw-review-shortcut-hint tw-muted" title="검토 표 행에 포커스가 있을 때 사용할 수 있는 단축키">⌨ ↑↓ 이동 · E 편집 · A 입력 · C 복사</span>
        <button class="tw-btn tw-btn-ghost tw-btn-review-history" title="과거 run 목록 / 내보내기 / 설정">📚 history</button>
    </div>
    <div class="tw-review-history-panel tw-hidden">
        <div class="tw-history-panel-header">
            <span class="tw-history-panel-title">📚 Run history</span>
            <span class="tw-history-panel-actions">
                <button class="tw-btn tw-btn-ghost tw-btn-review-export-json" title="현재 run 결과를 JSON으로 내려받기 (raw 제외)">📥 JSON</button>
                <button class="tw-btn tw-btn-ghost tw-btn-review-export-csv" title="현재 run 결과를 CSV로 내려받기 (id/원문/phase3/45/override/final)">📥 CSV</button>
                <span class="tw-history-divider"></span>
                <button class="tw-btn tw-btn-ghost tw-btn-review-export-overrides" title="모든 직접 수정(override)을 JSON 파일로 내보내기">⤴ override</button>
                <button class="tw-btn tw-btn-ghost tw-btn-review-import-overrides" title="JSON 파일에서 직접 수정(override) 복원">⤵ override</button>
                <input type="file" class="tw-review-import-overrides-file" accept="application/json,.json" hidden />
                <span class="tw-history-divider"></span>
                <button class="tw-btn tw-btn-ghost tw-btn-review-gc" title="현재 활성 batch run 외에 남아있는 직접 수정 데이터 정리">🧹 override 정리</button>
            </span>
        </div>
        <div class="tw-history-list"></div>
    </div>
    <div class="tw-review-table"></div>
</div>
<div class="tw-log-panel tw-tab-content" data-tab-content="logs">
    <div class="tw-log-header">
        <div class="tw-panel-title">JSON/로그</div>
        <span class="tw-log-controls">
            <select class="tw-log-level" title="레벨 필터">
                <option value="all">전체</option>
                <option value="info">INFO</option>
                <option value="success">SUCCESS</option>
                <option value="warn">WARN</option>
                <option value="error">ERROR</option>
            </select>
            <input class="tw-log-search" type="search" placeholder="로그 본문 검색…" />
            <button class="tw-btn tw-btn-ghost tw-btn-log-download" title="필터링된 로그를 .txt 파일로 다운로드">⬇ 다운로드</button>
            <button class="tw-btn tw-btn-ghost tw-btn-log-copy">📋 전체 복사</button>
        </span>
    </div>
    <pre class="tw-log-output">아직 로그가 없습니다.</pre>
</div>
<div class="tw-resize-handle"></div>
`;
        document.body.appendChild(el);
        modalEl = el;

        injectStyles();
        attachHandlers(el);
        restoreModalPosition(el);
        populateSelects(el);
        // v0.7.6 (#7): 모달 폭이 좁아지면 toolbar 압축 클래스 토글 (ResizeObserver 미지원 환경은 무시)
        try {
            if (typeof ResizeObserver !== 'undefined') {
                const NARROW_PX = 900;
                const ro = new ResizeObserver(entries => {
                    for (const entry of entries) {
                        const w = entry.contentRect ? entry.contentRect.width : entry.target.offsetWidth;
                        el.classList.toggle('tw-narrow', w > 0 && w < NARROW_PX);
                    }
                });
                ro.observe(el);
            }
        } catch (e) { /* no-op */ }

        return el;
    }

    function injectStyles() {
        if ($('#tms-workflow-styles')) return;
        const style = document.createElement('style');
        style.id = 'tms-workflow-styles';
        style.textContent = `
/* v0.6.7 (D2): 디자인 토큰 — 색·간격을 한 곳에서 관리. 신규 컴포넌트는 var(--tw-*) 사용을 권장 */
#tms-workflow-modal {
    --tw-accent: #4ade80;
    --tw-accent-soft: rgba(74, 222, 128, 0.18);
    --tw-edit: #fbbf24;        /* 사용자 직접 수정 (✏️) */
    --tw-edit-soft: rgba(251, 191, 36, 0.16);
    --tw-warn: #facc15;        /* 길이 등 경고 */
    --tw-warn-order: #93c5fd;  /* placeholder 순서 */
    --tw-warn-tb: #f9a8d4;     /* TB 용어 */
    --tw-danger: #e74c3c;
    --tw-info: #3498db;
    --tw-success: #27ae60;
    --tw-bg-1: #1e1e1e;
    --tw-bg-2: #252525;
    --tw-bg-3: #2a2a2a;
    --tw-fg: #e0e0e0;
    --tw-muted: #888;
    --tw-border: #3a3a3a;
}
#tms-workflow-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 900px;
    height: 640px;
    min-width: 600px;
    min-height: 400px;
    background: #1e1e1e;
    color: #e0e0e0;
    border: 1px solid #3a3a3a;
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    z-index: 999999;
    display: flex;
    flex-direction: column;
    container-type: inline-size;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
}
#tms-workflow-modal * { box-sizing: border-box; }
.tw-header {
    display: flex; align-items: center; padding: 12px 18px;
    background: #2a2a2a; border-bottom: 1px solid #3a3a3a;
    border-radius: 10px 10px 0 0; cursor: move; user-select: none;
    flex-shrink: 0;
}
.tw-title { font-weight: 600; color: #4ade80; margin-right: 12px; }
.tw-seg-info { flex: 1; color: #888; font-size: 12px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
.tw-header-right { display: flex; gap: 4px; }
.tw-main-tabs {
    display: flex; gap: 4px; padding: 10px 14px 0;
    background: #202020; border-bottom: 1px solid #333;
    flex-shrink: 0;
}
.tw-main-tab {
    background: transparent; color: #999; border: 1px solid transparent;
    border-bottom: none; padding: 8px 14px; border-radius: 6px 6px 0 0;
    cursor: pointer; font-size: 12px; transition: all 0.15s;
}
.tw-main-tab:hover { color: #ddd; background: #282828; }
.tw-main-tab.active {
    background: #2a2a2a; color: #4ade80; border-color: #3a3a3a;
    font-weight: 600;
}
.tw-btn {
    cursor: pointer; border: none; border-radius: 4px;
    padding: 6px 12px; font-size: 12px; transition: all 0.15s;
}
.tw-btn-ghost { background: transparent; color: #aaa; }
.tw-btn-ghost:hover { background: #3a3a3a; color: #fff; }
.tw-btn-primary { background: #4ade80; color: #000; font-weight: 500; }
.tw-btn-primary:hover:not(:disabled) { background: #22c55e; }
.tw-btn-primary:disabled { background: #3a3a3a; color: #666; cursor: not-allowed; }
.tw-body { flex: 1; display: flex; overflow: hidden; }
.tw-tab-content { flex: 1; overflow: hidden; display: none; }
.tw-tab-content.active { display: flex; }
.tw-context-panel {
    width: 320px; flex-shrink: 0; padding: 16px;
    border-right: 1px solid #3a3a3a; overflow-y: auto;
    background: #252525;
    display: flex; flex-direction: column; gap: 14px;
}
.tw-panel-title { font-weight: 600; color: #4ade80; margin: 0 0 4px; font-size: 12px;
    padding-bottom: 8px; border-bottom: 1px solid #333; }
.tw-context-content { font-size: 12px; line-height: 1.55; word-break: break-word; }
.tw-muted { color: #888; }
.tw-context-section { margin: 0 0 14px; display: flex; flex-direction: column; gap: 6px; }
.tw-context-section:last-child { margin-bottom: 0; }
.tw-context-label { color: #4ade80; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px; margin: 0; }
.tw-context-value { background: #1a1a1a; padding: 8px 10px; border-radius: 4px; color: #ddd;
    white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.tw-chat-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.tw-chat-messages { flex: 1; overflow-y: auto; padding: 18px; }
.tw-msg { margin-bottom: 16px; max-width: 90%; word-wrap: break-word; }
.tw-msg-user { margin-left: auto; }
.tw-msg-ai { margin-right: auto; }
.tw-msg-role { font-size: 11px; color: #888; margin-bottom: 4px; }
.tw-msg-user .tw-msg-role { text-align: right; }
.tw-msg-content { padding: 12px 16px; border-radius: 8px; white-space: pre-wrap;
    line-height: 1.55; }
.tw-msg-user .tw-msg-content { background: #2563eb; color: #fff; }
.tw-msg-ai .tw-msg-content { background: #2a2a2a; color: #e0e0e0; border: 1px solid #3a3a3a; }
.tw-msg-system .tw-msg-content { background: transparent; color: #888; font-style: italic;
    text-align: center; padding: 4px; font-size: 11px; }
.tw-msg-system { max-width: 100%; }
.tw-msg-progress { color: #fbbf24; }
/* v0.6.10 C2-신: AI 메시지 인라인 액션 버튼 */
.tw-msg-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.tw-msg-progress .tw-msg-actions { display: none; }
.tw-msg-action {
    background: transparent; color: #94a3b8; border: 1px solid #3a3a3a;
    border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer;
    transition: all 0.12s ease;
}
.tw-msg-action:hover { background: #2a2a2a; color: #e0e0e0; border-color: #4ade80; }
.tw-msg-action-apply:hover { color: #4ade80; }
/* v0.7.8 (#3): chat seed 메시지의 (run xxx) 클릭 가능 태그 */
.tw-chat-runid-tag {
    display: inline-block;
    margin: 0 4px;
    padding: 0 6px;
    border-radius: 8px;
    background: #2a3140;
    color: #93c5fd;
    text-decoration: none;
    font-size: 11px;
    border: 1px solid #3a4660;
    cursor: pointer;
}
.tw-chat-runid-tag:hover { background: #344056; color: #cfe5ff; border-color: #4ade80; }
.tw-chat-input-wrap { padding: 14px 16px; border-top: 1px solid #3a3a3a;
    background: #252525; flex-shrink: 0; }
.tw-input-controls { display: flex; gap: 14px; margin-bottom: 10px; font-size: 12px; color: #aaa; }
.tw-ctrl { display: flex; align-items: center; gap: 6px; }
.tw-prompt-select, .tw-model-select {
    background: #1a1a1a; color: #e0e0e0; border: 1px solid #3a3a3a;
    padding: 5px 8px; border-radius: 4px; font-size: 12px; min-width: 140px;
}
.tw-chat-input {
    width: 100%; min-height: 70px; max-height: 180px; resize: vertical;
    background: #1a1a1a; color: #e0e0e0; border: 1px solid #3a3a3a;
    border-radius: 6px; padding: 10px 12px; font-size: 13px; font-family: inherit;
    line-height: 1.45;
}
.tw-chat-input:focus { outline: none; border-color: #4ade80; }
.tw-chat-buttons { display: flex; gap: 8px; justify-content: flex-end;
    margin-top: 12px; align-items: center; }
.tw-btn-reset { margin-right: auto; }
.tw-review-panel, .tw-log-panel {
    flex-direction: column; padding: 14px; gap: 12px; background: #202020;
}
.tw-batch-panel {
    flex-direction: row; padding: 0; gap: 0; background: #202020; min-width: 0;
}
.tw-batch-sidebar {
    width: 320px; flex-shrink: 0; padding: 12px; border-right: 1px solid #3a3a3a;
    background: #252525; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;
}
.tw-batch-chat-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
.tw-batch-timeline { flex: 1; overflow-y: auto; padding: 14px; }
.tw-batch-event { margin-bottom: 14px; max-width: 92%; }
.tw-batch-event .tw-msg-role { color: #94a3b8; }
.tw-batch-event-info .tw-msg-content { background: #242a33; border-color: #334155; }
.tw-batch-event-success .tw-msg-content { background: #183225; border-color: #256d3d; }
.tw-batch-event-warn .tw-msg-content { background: #33290f; border-color: #7c5c11; color: #facc15; }
.tw-batch-event-error .tw-msg-content { background: #3a1d1d; border-color: #7f1d1d; color: #fecaca; }
.tw-batch-input-wrap {
    padding: 14px 16px; border-top: 1px solid #3a3a3a;
    background: #252525; flex-shrink: 0;
}
.tw-batch-header-row { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.tw-batch-status {
    padding: 5px 10px; border: 1px solid #3a3a3a; border-radius: 999px;
    color: #4ade80; background: #1a1a1a; font-size: 12px; white-space: nowrap;
}
.tw-batch-card { min-width: 0; }
.tw-batch-file-info, .tw-batch-validation { white-space: pre-wrap; max-height: 150px; overflow: auto; }
.tw-batch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.tw-batch-warning {
    color: #fbbf24; background: #2a2212; border: 1px solid #5a4214;
    border-radius: 6px; padding: 12px 14px; font-size: 11px; line-height: 1.55;
    word-break: break-word;
}
.tw-batch-warning:empty { display: none; }
/* v0.6.9 hotfix2: 사용 모델/프롬프트 미니 표시 (사이드바) */
.tw-batch-config-row {
    display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11px;
    padding: 8px 12px; border: 1px dashed var(--tw-border); border-radius: 6px;
    background: rgba(255,255,255,0.02);
}
.tw-batch-config-row:empty { display: none; }
.tw-batch-config-row .tw-batch-config-item { display: inline-flex; gap: 4px; align-items: baseline; min-width: 0; }
.tw-batch-config-row .tw-batch-config-key { color: var(--tw-muted); }
.tw-batch-config-row .tw-batch-config-val {
    color: var(--tw-fg); font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px;
}
/* v0.6.9 hotfix2: 세그먼트 보기 버튼 */
.tw-btn-show-segments {
    width: 100%; text-align: left; padding: 8px 10px; font-size: 12px;
    background: var(--tw-bg-2); border: 1px solid var(--tw-border); color: var(--tw-fg);
}
.tw-btn-show-segments:not(:disabled):hover { background: var(--tw-bg-3); border-color: var(--tw-accent); }
.tw-btn-show-segments:disabled { opacity: 0.5; cursor: not-allowed; }
/* v0.6.9 hotfix2: 세그먼트 오버레이 (chat-panel 위로 떠오름) */
.tw-batch-chat-panel { position: relative; }
.tw-batch-segments-overlay {
    position: absolute; inset: 0; z-index: 20;
    display: flex; flex-direction: column;
    background: rgba(20, 20, 20, 0.97);
    border-left: 1px solid var(--tw-border);
}
.tw-batch-segments-overlay-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid var(--tw-border);
    background: var(--tw-bg-2);
}
.tw-batch-segments-overlay-title { font-weight: 600; color: var(--tw-fg); }
.tw-btn-close-segments {
    width: 28px; height: 28px; padding: 0; border-radius: 50%;
    background: transparent; border: 1px solid var(--tw-border); color: var(--tw-muted);
    cursor: pointer; font-size: 14px;
}
.tw-btn-close-segments:hover { background: var(--tw-bg-3); color: var(--tw-fg); }
.tw-batch-segments-overlay-body {
    flex: 1; overflow: auto; padding: 14px; background: #181818;
    font-size: 12px; line-height: 1.6;
}
/* .tw-batch-segments는 v0.6.9 hotfix2부터 overlay-body 안에서만 사용됨 */
/* v0.6.9 (G1-a): 활성 run 헤더 카드 — 사이드바에 맞게 줄당 1~2 항목으로 wrap */
.tw-batch-run-header {
    display: flex; gap: 8px 12px; align-items: center; flex-wrap: wrap;
    padding: 8px 10px; border: 1px solid var(--tw-border); border-radius: 8px;
    background: linear-gradient(135deg, rgba(74,222,128,0.06) 0%, var(--tw-bg-2) 70%);
    font-size: 11px; line-height: 1.4;
}
.tw-batch-run-header .tw-batch-run-id {
    font-family: monospace; color: var(--tw-accent); font-weight: 600;
    background: rgba(74,222,128,0.1); padding: 2px 8px; border-radius: 4px;
    white-space: nowrap;
}
.tw-batch-run-header .tw-batch-run-meta { color: var(--tw-muted); }
.tw-batch-run-header .tw-batch-run-meta b { color: var(--tw-fg); font-weight: 500; }
.tw-batch-run-header .tw-batch-run-stamp {
    margin-left: auto; color: var(--tw-muted); font-size: 10px; white-space: nowrap;
}
/* v0.6.9 (G1-b): Phase stepper — 좁은 사이드바(290px)에서도 깨지지 않게 세로 스택 */
.tw-batch-stepper {
    display: flex; align-items: stretch; gap: 0; flex-wrap: nowrap;
    padding: 0; background: transparent;
}
.tw-batch-stepper:empty { display: none; }
.tw-batch-step {
    flex: 1 1 0; min-width: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 3px; padding: 8px 4px;
    border: 1px solid var(--tw-border);
    background: var(--tw-bg-1); color: var(--tw-muted);
    text-align: center; line-height: 1.2;
}
.tw-batch-step:not(:last-child) { border-right: none; }
.tw-batch-step:first-child { border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
.tw-batch-step:last-child { border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
.tw-batch-step .tw-batch-step-icon { font-size: 14px; line-height: 1; flex-shrink: 0; }
.tw-batch-step .tw-batch-step-name {
    font-weight: 500; color: var(--tw-fg); font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
}
.tw-batch-step .tw-batch-step-detail {
    font-size: 10px; color: var(--tw-muted); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; max-width: 100%;
}
.tw-batch-step.tw-step-done { background: rgba(39, 174, 96, 0.10); border-color: rgba(39, 174, 96, 0.4); }
.tw-batch-step.tw-step-done .tw-batch-step-name { color: var(--tw-success); }
.tw-batch-step.tw-step-warn { background: rgba(250, 204, 21, 0.08); border-color: rgba(250, 204, 21, 0.4); }
.tw-batch-step.tw-step-warn .tw-batch-step-name { color: var(--tw-warn); }
.tw-batch-step.tw-step-fail { background: rgba(231, 76, 60, 0.10); border-color: rgba(231, 76, 60, 0.4); }
.tw-batch-step.tw-step-fail .tw-batch-step-name { color: var(--tw-danger); }
.tw-batch-step.tw-step-busy { background: rgba(52, 152, 219, 0.10); border-color: rgba(52, 152, 219, 0.4); }
.tw-batch-step.tw-step-busy .tw-batch-step-name { color: var(--tw-info); }
/* v0.7.1: 실행 중 phase의 아이콘을 회전시켜 작업 중임을 시각적으로 표시 */
@keyframes tw-batch-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.tw-batch-step-icon-spin { display: inline-block; animation: tw-batch-spin 1.2s linear infinite; transform-origin: center; }
/* v0.7.0 G1-b 보강: fail/warn step은 클릭 가능 (로그 탭으로 점프) */
.tw-batch-step.tw-step-actionable { cursor: pointer; transition: filter 0.12s ease; }
.tw-batch-step.tw-step-actionable:hover { filter: brightness(1.25); }
/* v0.6.9 (G1-d): 수집/검증 결과 카드 그리드 — 290px 사이드바에서 2열 정도 들어가게 */
.tw-batch-summary-cards {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 8px;
}
.tw-batch-summary-cards:empty { display: none; }
.tw-summary-card {
    padding: 8px 10px; border: 1px solid var(--tw-border); border-radius: 6px;
    background: var(--tw-bg-2); display: flex; flex-direction: column; gap: 2px;
    min-height: 56px; transition: transform 0.08s ease, border-color 0.12s ease;
    min-width: 0;
}
.tw-summary-card.tw-summary-clickable { cursor: pointer; }
.tw-summary-card.tw-summary-clickable:hover { border-color: var(--tw-accent); transform: translateY(-1px); }
.tw-summary-card .tw-summary-label { font-size: 10px; color: var(--tw-muted); text-transform: uppercase; letter-spacing: 0.3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tw-summary-card .tw-summary-value { font-size: 15px; font-weight: 600; color: var(--tw-fg); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tw-summary-card .tw-summary-sub { font-size: 10px; color: var(--tw-muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tw-summary-card.tw-summary-ok .tw-summary-value { color: var(--tw-success); }
.tw-summary-card.tw-summary-warn .tw-summary-value { color: var(--tw-warn); }
.tw-summary-card.tw-summary-fail .tw-summary-value { color: var(--tw-danger); }
.tw-summary-card.tw-summary-info .tw-summary-value { color: var(--tw-info); }
.tw-review-summary { flex-shrink: 0; }
/* v0.7.3: 결과 검토 요약을 칩으로 시각화 */
.tw-review-summary.tw-review-summary-chips {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 4px 0; font-size: 12px;
}
.tw-summary-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--tw-border); background: var(--tw-bg-2);
    color: var(--tw-fg); white-space: nowrap; line-height: 1.3;
}
.tw-summary-chip b { font-weight: 600; }
.tw-summary-chip .tw-summary-chip-label { color: var(--tw-muted); font-size: 11px; }
.tw-summary-chip-info { background: rgba(52, 152, 219, 0.10); border-color: rgba(52, 152, 219, 0.35); }
.tw-summary-chip-info b { color: var(--tw-info); }
.tw-summary-chip-edit { background: var(--tw-edit-soft); border-color: rgba(251, 191, 36, 0.4); }
.tw-summary-chip-edit b { color: var(--tw-edit); }
.tw-summary-chip-ok { background: rgba(39, 174, 96, 0.10); border-color: rgba(39, 174, 96, 0.4); }
.tw-summary-chip-ok b { color: var(--tw-success); }
.tw-summary-chip-warn { background: rgba(250, 204, 21, 0.08); border-color: rgba(250, 204, 21, 0.45); }
.tw-summary-chip-warn b { color: var(--tw-warn); }
.tw-summary-chip-fail { background: rgba(231, 76, 60, 0.10); border-color: rgba(231, 76, 60, 0.4); }
.tw-summary-chip-fail b { color: var(--tw-danger); }
.tw-summary-chip-muted { background: transparent; border-color: var(--tw-border); }
.tw-summary-chip-muted b { color: var(--tw-muted); }
.tw-summary-chip-filter { background: rgba(74, 222, 128, 0.10); border-color: rgba(74, 222, 128, 0.4); cursor: pointer; }
.tw-summary-chip-filter b { color: var(--tw-success); }
.tw-summary-divider { width: 1px; height: 14px; background: var(--tw-border); margin: 0 2px; }
.tw-review-toolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px; border: 1px solid #333; border-radius: 8px;
    background: linear-gradient(135deg, #202820 0%, #181818 70%);
}
.tw-review-apply-status { margin-left: auto; font-size: 12px; }
/* v0.6.8 (A1): 일괄 입력 실패 ID 칩 */
.tw-review-failed-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; max-width: 360px; }
.tw-review-failed-chip {
    display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 9999px;
    font-size: 11px; font-weight: 500; line-height: 1.4; cursor: pointer;
    background: rgba(231, 76, 60, 0.18); color: #fca5a5; border: 1px solid rgba(231, 76, 60, 0.45);
}
.tw-review-failed-chip:hover { background: rgba(231, 76, 60, 0.32); color: #fff; }
.tw-btn-review-failed-toggle.tw-active { background: var(--tw-danger); color: #fff; border-color: var(--tw-danger); }
.tw-review-row.tw-review-row-flash { animation: tw-row-flash 1.6s ease-out; }
@keyframes tw-row-flash {
    0% { background: rgba(251, 191, 36, 0.45); }
    100% { background: transparent; }
}
/* v0.6.5 (A3): 필터/정렬 컨트롤 */
.tw-review-filter-group { display: flex; gap: 8px; align-items: center; }
.tw-review-filter-label { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #aaa; }
.tw-review-filter, .tw-review-sort {
    background: #1a1a1a; color: #e0e0e0; border: 1px solid #3a3a3a;
    padding: 3px 6px; border-radius: 4px; font-size: 12px;
}
/* v0.6.5 (A4): phase3 ↔ phase4+5 단어 단위 diff */
.tw-diff-add { background: rgba(74, 222, 128, 0.18); color: #86efac; border-radius: 2px; padding: 0 2px; }
.tw-diff-del { background: rgba(248, 113, 113, 0.18); color: #fca5a5; text-decoration: line-through; border-radius: 2px; padding: 0 2px; opacity: 0.85; }
/* v0.6.6 (B3): warn-only chip (final 셀에 부착) — v0.6.10 B4: 클릭 시 행 스크롤/flash */
.tw-review-warn-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.tw-review-warn-chip {
    display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 9999px;
    font-size: 11px; font-weight: 500; line-height: 1.4; cursor: pointer;
    background: rgba(250, 204, 21, 0.14); color: #fde047; border: 1px solid rgba(250, 204, 21, 0.35);
    transition: filter 0.12s ease;
}
.tw-review-warn-chip:hover { filter: brightness(1.25); }
.tw-review-warn-chip.tw-review-warn-tb { background: rgba(244, 114, 182, 0.14); color: #f9a8d4; border-color: rgba(244, 114, 182, 0.35); }
.tw-review-warn-chip.tw-review-warn-order { background: rgba(96, 165, 250, 0.14); color: #93c5fd; border-color: rgba(96, 165, 250, 0.35); }
.tw-review-table {
    flex: 1; overflow: auto; border: 1px solid #333; border-radius: 10px; background: #151515;
}
.tw-review-row {
    display: grid; grid-template-columns: 34px 78px 54px minmax(120px, 0.8fr) minmax(130px, 0.95fr) minmax(120px, 0.85fr) minmax(150px, 1fr) 178px;
    gap: 10px; padding: 12px 14px; border-bottom: 1px solid #303030; align-items: start;
}
.tw-review-row:last-child { border-bottom: none; }
.tw-review-head { color: #4ade80; font-weight: 600; background: #202020; position: sticky; top: 0; z-index: 1; }
/* v0.6.3: 기본 셀은 normal whitespace, 텍스트 보존이 필요한 셀만 pre-wrap */
.tw-review-cell { word-break: break-word; line-height: 1.45; }
.tw-review-cell.tw-review-text { white-space: pre-wrap; }
.tw-review-row:not(.tw-review-head):hover { background: #1d241f; }
.tw-review-check { display: flex; align-items: center; justify-content: center; }
.tw-review-select, .tw-review-select-all { accent-color: #4ade80; }
.tw-review-source { color: #aaa; max-height: 90px; overflow: hidden; }
.tw-review-actions {
    display: flex; flex-direction: row; flex-wrap: wrap; gap: 4px;
    align-items: center; justify-content: flex-start;
}
.tw-review-actions .tw-btn {
    width: auto; min-width: 0; padding: 4px 8px; font-size: 12px; line-height: 1.3;
}
.tw-review-flag-chip {
    display: inline-block; padding: 2px 7px; border-radius: 10px;
    font-size: 10px; line-height: 1.4; background: #25304a; color: #cbd5e1; border: 1px solid #334155;
    white-space: nowrap; align-self: flex-start;
}
/* v0.6.4: revision 텍스트와 함께 표시될 때만 윗 여백 */
.tw-review-text + .tw-review-flag-chip { margin-top: 4px; }
.tw-review-flag-chip.tw-review-flag-keep { background: #1f2a1f; color: #86efac; border-color: #2f4a32; }
/* v0.6.7 (D2): "직접 수정" 의미는 amber(--tw-edit)로 통일 (✏️ chip / button / badge 공통 톤) */
.tw-review-flag-chip.tw-review-flag-edit { background: var(--tw-edit-soft); color: var(--tw-edit); border-color: rgba(251, 191, 36, 0.4); }
/* v0.6.7 (D2): 적용 자동화 배지 (renderReviewTable의 appliedBadge 대상). 기존엔 룰 없음 — 토큰 톤으로 정의 */
.tw-review-applied-badge {
    margin-left: 6px; font-size: 11px; opacity: 0.85; cursor: help;
    color: var(--tw-info);
}
/* v0.6.7 (D2): override 되어 있을 때 ✏️ 액션 버튼 강조 (주변 chip과 같은 amber) */
.tw-review-row[data-has-override="1"] .tw-btn-edit-final {
    color: var(--tw-edit); border-color: rgba(251, 191, 36, 0.4);
}
.tw-review-final-wrap { display: flex; flex-direction: column; gap: 4px; }
.tw-review-final-edit { display: flex; flex-direction: column; gap: 6px; }
.tw-review-final-edit textarea {
    width: 100%; min-height: 64px; resize: vertical; box-sizing: border-box;
    background: #0f1612; color: #e6e6e6; border: 1px solid #4ade80; border-radius: 6px;
    padding: 6px 8px; font-size: 12px; line-height: 1.45; font-family: inherit;
}
.tw-review-edit-buttons { display: flex; gap: 4px; }
.tw-review-edit-buttons .tw-btn { padding: 3px 8px; font-size: 11px; }
.tw-review-chat-badge {
    margin-left: 6px; font-size: 11px; opacity: 0.85;
    cursor: help;
}
.tw-log-output {
    flex: 1; margin: 0; overflow: auto; white-space: pre-wrap; word-break: break-word;
    background: #181818; border: 1px solid #333; border-radius: 6px; padding: 10px;
    color: #ddd; font-size: 12px; line-height: 1.5;
}
.tw-log-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; flex-shrink: 0;
}
/* v0.6.7 (D1): 로그 필터/검색/다운로드 컨트롤 */
.tw-log-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tw-log-controls .tw-log-level,
.tw-log-controls .tw-log-search {
    background: var(--tw-bg-2); color: var(--tw-fg);
    border: 1px solid var(--tw-border); border-radius: 4px;
    padding: 3px 6px; font-size: 12px;
}
.tw-log-controls .tw-log-search { width: 160px; }
.tw-log-controls .tw-log-search:focus,
.tw-log-controls .tw-log-level:focus { outline: none; border-color: var(--tw-accent); }
/* v0.6.7 (C2/C3): 검토 툴바 구분선 */
.tw-review-toolbar-divider {
    display: inline-block; width: 1px; height: 18px; background: var(--tw-border);
    margin: 0 4px; align-self: center;
}
.tw-review-compare-select {
    background: var(--tw-bg-2); color: var(--tw-fg);
    border: 1px solid var(--tw-border); border-radius: 4px;
    padding: 3px 6px; font-size: 12px; max-width: 220px;
}
/* v0.6.7 (C2): 비교 모드 표 */
.tw-compare-banner {
    margin: 4px 0 8px; padding: 6px 10px; border-radius: 6px;
    background: var(--tw-accent-soft); color: var(--tw-accent);
    border: 1px solid rgba(74, 222, 128, 0.35); font-size: 12px;
}
.tw-compare-table { display: flex; flex-direction: column; gap: 6px; padding: 4px 0; overflow: auto; }
.tw-compare-row {
    display: grid; grid-template-columns: 70px 1.4fr 1.6fr 1.6fr 90px;
    gap: 8px; padding: 8px 10px; border: 1px solid var(--tw-border);
    border-radius: 6px; background: var(--tw-bg-2); font-size: 12px;
}
.tw-compare-row.tw-compare-head { background: var(--tw-bg-3); color: var(--tw-accent); font-weight: 600; }
.tw-compare-row.tw-compare-changed { border-color: var(--tw-edit); }
.tw-compare-row.tw-compare-only { border-color: var(--tw-info); }
.tw-compare-cell { word-break: break-word; }
.tw-compare-status {
    display: inline-block; padding: 2px 7px; border-radius: 10px;
    font-size: 10px; line-height: 1.4; white-space: nowrap;
}
.tw-compare-status-same { background: #1f2a1f; color: #86efac; border: 1px solid #2f4a32; }
.tw-compare-status-changed { background: var(--tw-edit-soft); color: var(--tw-edit); border: 1px solid rgba(251, 191, 36, 0.4); }
.tw-compare-status-only { background: rgba(52, 152, 219, 0.18); color: #93c5fd; border: 1px solid rgba(52, 152, 219, 0.4); }
/* v0.7.0 G1-c: history 패널 — 같은 file의 과거 run 목록 (v0.7.2: 라벨 수정 + 비교 액션) */
.tw-review-history-panel {
    margin: 6px 0; padding: 6px;
    border: 1px solid var(--tw-border); border-radius: 6px;
    background: var(--tw-bg-2); max-height: 280px; overflow: auto;
}
.tw-history-row {
    display: grid; grid-template-columns: 130px minmax(180px, 1.2fr) 110px 50px minmax(280px, 2fr);
    gap: 8px; padding: 5px 8px; align-items: center; font-size: 12px;
    border-bottom: 1px solid var(--tw-border);
}
.tw-history-row:last-child { border-bottom: none; }
.tw-history-row.tw-history-active { background: rgba(74, 222, 128, 0.08); }
.tw-history-row.tw-history-comparing { background: rgba(52, 152, 219, 0.10); }
.tw-history-row.tw-history-head { font-weight: 600; color: var(--tw-accent); border-bottom: 1px solid var(--tw-border); }
.tw-history-row > div { word-break: break-all; }
.tw-history-row .tw-history-status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tw-history-row .tw-history-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tw-history-row .tw-history-name-text { font-weight: 500; color: var(--tw-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tw-history-row .tw-history-runid { font-size: 10px; color: var(--tw-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tw-history-row .tw-history-badge { display: inline-block; padding: 1px 5px; margin-left: 4px; font-size: 10px; border-radius: 3px; background: rgba(74, 222, 128, 0.18); color: var(--tw-success); }
.tw-history-row .tw-history-badge.tw-history-badge-compare { background: rgba(52, 152, 219, 0.18); color: var(--tw-info); }
.tw-history-actions { display: flex; gap: 4px; flex-wrap: nowrap; justify-content: flex-end; }
.tw-history-actions .tw-btn { padding: 2px 7px; font-size: 11px; white-space: nowrap; }
.tw-history-empty { padding: 12px; text-align: center; color: var(--tw-muted, #888); font-size: 12px; }
/* v0.7.4: history 패널 헤더 (데이터/override 운용 그룹 이주) */
.tw-history-panel-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; flex-wrap: wrap; padding: 4px 6px 8px;
    border-bottom: 1px solid var(--tw-border); margin-bottom: 6px;
}
.tw-history-panel-title { font-weight: 600; color: var(--tw-accent); font-size: 12px; }
.tw-history-panel-actions { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.tw-history-panel-actions .tw-btn { padding: 3px 8px; font-size: 11px; white-space: nowrap; }
.tw-history-divider {
    display: inline-block; width: 1px; height: 14px; background: var(--tw-border); margin: 0 3px;
}
.tw-history-list { display: block; }
/* v0.7.4: 비교 모드 banner (toolbar 외 상단에 고정 표시) */
.tw-compare-banner-bar {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin: 4px 0 6px; padding: 6px 10px; border-radius: 6px;
    background: var(--tw-accent-soft); border: 1px solid rgba(74, 222, 128, 0.35);
    font-size: 12px;
}
.tw-compare-banner-bar .tw-compare-banner-text { color: var(--tw-accent); font-weight: 600; }
.tw-compare-banner-bar .tw-review-filter-label { margin-left: auto; color: var(--tw-fg); }
.tw-compare-banner-bar .tw-btn { padding: 3px 10px; font-size: 12px; }
/* v0.7.4: toolbar 그룹화 (입력 / 보기 / 운용) */
.tw-review-toolbar-group {
    display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.tw-btn-review-history { margin-left: 0; }
@container (max-width: 760px) {
    .tw-context-panel { width: 260px; }
    .tw-batch-panel { flex-direction: column; }
    .tw-batch-sidebar {
        width: 100%; max-height: 240px; border-right: none; border-bottom: 1px solid #3a3a3a;
    }
    .tw-batch-event { max-width: 100%; }
    .tw-input-controls { flex-direction: column; align-items: stretch; }
    .tw-ctrl { align-items: flex-start; flex-direction: column; }
    .tw-prompt-select, .tw-model-select { width: 100%; }
    .tw-review-toolbar { align-items: stretch; }
    .tw-review-apply-status { width: 100%; margin-left: 0; }
    .tw-review-row {
        grid-template-columns: minmax(0, 1fr);
        gap: 6px; padding: 12px; margin: 10px;
        border: 1px solid #303030; border-radius: 10px;
        background: #181818;
    }
    .tw-review-head { display: none; }
    .tw-review-cell {
        display: grid; grid-template-columns: 82px minmax(0, 1fr);
        gap: 8px; align-items: start;
    }
    .tw-review-cell::before {
        content: attr(data-label);
        color: #4ade80; font-size: 11px; font-weight: 700;
    }
    .tw-review-check { justify-content: flex-start; }
    .tw-review-check::before { content: "선택"; }
    .tw-review-source { max-height: none; }
    .tw-review-actions { flex-direction: row; align-items: center; flex-wrap: wrap; }
    .tw-review-actions .tw-btn { width: auto; }
}
@media (max-width: 760px) {
    #tms-workflow-modal { min-width: 420px; }
    .tw-main-tabs { overflow-x: auto; }
    .tw-review-head { display: none; }
    .tw-review-row { grid-template-columns: minmax(0, 1fr); }
}
.tw-resize-handle {
    position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, #555 50%, #555 60%, transparent 60%, transparent 70%, #555 70%, #555 80%, transparent 80%);
}
.tw-hidden { display: none !important; }

/* 시스템 프롬프트 편집 오버레이 */
.tw-settings-overlay {
    position: absolute; inset: 0; background: rgba(0,0,0,0.85); z-index: 10;
    display: flex; align-items: center; justify-content: center;
    border-radius: 10px;
}
.tw-settings-panel {
    width: 92%; height: 85%; background: #1e1e1e; border: 1px solid #4ade80;
    border-radius: 8px; padding: 16px; display: flex; flex-direction: column;
}
.tw-settings-header { display: flex; align-items: center; margin-bottom: 12px; gap: 8px; }
.tw-settings-header-title { font-weight: 600; color: #4ade80; }
.tw-settings-tabs { display: flex; gap: 4px; flex: 1; margin-left: 16px; }
.tw-settings-tab {
    background: transparent; color: #888; border: 1px solid transparent;
    padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
    transition: all 0.15s;
}
.tw-settings-tab:hover { color: #ccc; background: #252525; }
.tw-settings-tab.active { background: #2a2a2a; color: #4ade80; border-color: #4ade80; }
.tw-settings-content { flex: 1; display: flex; gap: 12px; overflow: hidden; }
.tw-settings-tab-prompts { flex-direction: column; }
.tw-settings-prompt-toolbar {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 8px 10px; background: #252525; border-radius: 6px;
    flex-shrink: 0;
}
.tw-prompt-lock-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: #e0e0e0; cursor: pointer;
    user-select: none;
}
.tw-prompt-lock-label input[type="checkbox"] { accent-color: #4ade80; cursor: pointer; }
.tw-prompt-lock-hint { color: #888; font-size: 11px; }
.tw-settings-prompt-body { flex: 1; display: flex; gap: 12px; overflow: hidden; min-height: 0; }
.tw-settings-list { width: 200px; background: #252525; border-radius: 6px; padding: 8px;
    overflow-y: auto; }
.tw-settings-list-item {
    padding: 6px 10px; cursor: pointer; border-radius: 4px; margin-bottom: 2px;
    font-size: 12px; color: #ccc;
    display: flex; align-items: center; gap: 6px;
}
.tw-settings-list-item:hover { background: #2a2a2a; }
.tw-settings-list-item.active { background: #4ade80; color: #000; font-weight: 500; }
.tw-prompt-list-name {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tw-prompt-badges {
    display: inline-flex; gap: 2px; flex-shrink: 0; font-size: 11px;
}
.tw-prompt-badge {
    display: inline-block; line-height: 1;
}
.tw-settings-editor { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.tw-prompt-header-row { display: flex; gap: 8px; align-items: center; }
.tw-prompt-name {
    flex: 1; background: #1a1a1a; color: #e0e0e0; border: 1px solid #3a3a3a;
    padding: 6px 10px; border-radius: 4px; font-size: 13px;
}
.tw-prompt-content {
    flex: 1; background: #1a1a1a; color: #e0e0e0; border: 1px solid #3a3a3a;
    padding: 10px; border-radius: 4px; font-size: 12px; font-family: monospace;
    resize: none; line-height: 1.5;
}
.tw-settings-buttons { display: flex; gap: 8px; margin-top: 8px; }
.tw-btn-danger { background: #dc2626; color: #fff; }
.tw-btn-danger:hover:not(:disabled) { background: #b91c1c; }

/* v0.7.5: 자체 confirm 모달 */
.tw-confirm-overlay {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, sans-serif;
}
.tw-confirm-dialog {
    background: #2a2a2a; color: #e0e0e0;
    border: 1px solid #3a3a3a; border-radius: 8px;
    min-width: 320px; max-width: 520px;
    padding: 20px 22px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
}
.tw-confirm-dialog.tw-confirm-danger { border-color: #dc2626; }
.tw-confirm-title {
    font-size: 14px; font-weight: 600;
    color: #4ade80; margin-bottom: 12px;
}
.tw-confirm-dialog.tw-confirm-danger .tw-confirm-title { color: #f87171; }
.tw-confirm-message {
    font-size: 13px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word;
    margin-bottom: 18px; color: #d0d0d0;
}
.tw-confirm-buttons {
    display: flex; justify-content: flex-end; gap: 8px;
}
.tw-confirm-buttons .tw-btn { min-width: 72px; }

/* v0.7.5: 검토 표 행 키보드 포커스 */
.tw-review-row[tabindex="0"] { outline: none; }
.tw-review-row[tabindex="0"]:focus,
.tw-review-row.tw-review-row-focused {
    box-shadow: inset 3px 0 0 #4ade80, inset 0 0 0 1px rgba(74,222,128,0.35);
    background: rgba(74,222,128,0.05);
}
.tw-review-shortcut-hint {
    font-size: 11px; opacity: 0.7; padding: 0 4px;
}

/* 세션 관리 탭 */
.tw-session-stats, .tw-session-actions, .tw-session-info {
    background: #252525; border-radius: 6px; padding: 14px;
}
.tw-stat-title { font-weight: 600; color: #4ade80; margin-bottom: 10px; font-size: 13px; }
.tw-stat-body { display: flex; flex-direction: column; gap: 6px; }
.tw-stat-row { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; }
.tw-stat-label { color: #888; }
.tw-stat-value { color: #e0e0e0; font-weight: 500; }
.tw-session-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.tw-session-info-body { font-size: 12px; color: #aaa; line-height: 1.7; }
.tw-stat-hint { font-size: 11px; color: #888; margin-top: 8px; font-style: italic; }

/* v0.7.9: 워크스페이스 관리 (run/override/IDB slot 표) */
.tw-ws-section-head {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 10px;
}
.tw-ws-section-head .tw-stat-title { margin-bottom: 0; }
.tw-ws-section-head-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.tw-ws-table {
    width: 100%; border-collapse: collapse; font-size: 12px;
    background: #1f1f1f; border: 1px solid #333; border-radius: 4px;
    overflow: hidden;
}
.tw-ws-table th, .tw-ws-table td {
    padding: 6px 8px; text-align: left; border-bottom: 1px solid #2c2c2c;
}
.tw-ws-table th {
    background: #2a2a2a; color: #888; font-weight: 600;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px;
}
.tw-ws-table tr:last-child td { border-bottom: none; }
.tw-ws-table tr:hover td { background: #262626; }
.tw-ws-table tr.tw-ws-row-active td { background: rgba(74,222,128,0.08); }
.tw-ws-table tr.tw-ws-row-active td:first-child { border-left: 2px solid #4ade80; }
.tw-ws-table tr.tw-ws-row-orphan td { color: #fbbf24; }
.tw-ws-table .tw-ws-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.tw-ws-table .tw-ws-actions .tw-btn {
    padding: 2px 6px; font-size: 11px; min-width: 0;
}
.tw-ws-table .tw-btn-ws-run-activate.is-active {
    background: rgba(74,222,128,0.15); border-color: rgba(74,222,128,0.5); color: #4ade80;
    cursor: default; opacity: 1;
}
/* v0.7.10: export 체크박스 매트릭스 + import diff */
.tw-ws-export-matrix {
    display: flex; flex-wrap: wrap; gap: 10px 14px; padding: 8px 10px;
    background: #1a1a1a; border: 1px solid #333; border-radius: 6px; margin-bottom: 8px;
}
.tw-ws-export-matrix label {
    display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #ccc;
    cursor: pointer; user-select: none;
}
.tw-ws-export-matrix label.disabled { color: #555; cursor: not-allowed; }
.tw-ws-export-matrix input[type="checkbox"] { margin: 0; cursor: pointer; }
.tw-ws-export-matrix .tw-ws-matrix-count { color: #888; font-size: 11px; }
.tw-ws-import-diff {
    background: #1a1a1a; border: 1px solid #333; border-radius: 6px;
    padding: 8px 10px; font-size: 12px; line-height: 1.6;
    margin-top: 6px; max-width: 480px;
}
.tw-ws-import-diff-row { display: flex; justify-content: space-between; gap: 12px; }
.tw-ws-import-diff-row .label { color: #ccc; }
.tw-ws-import-diff-row .num-new { color: #4ade80; font-weight: 600; }
.tw-ws-import-diff-row .num-overwrite { color: #fbbf24; font-weight: 600; }
.tw-ws-import-diff-row .num-same { color: #666; }
.tw-ws-empty {
    padding: 20px; text-align: center; color: #666; font-size: 12px; font-style: italic;
}
.tw-ws-warn-badge {
    display: inline-block; padding: 1px 6px; font-size: 11px; font-weight: 600;
    background: rgba(251,191,36,0.15); color: #fbbf24; border-radius: 8px;
    border: 1px solid rgba(251,191,36,0.4);
}
.tw-ws-quota-bar {
    height: 6px; background: #2a2a2a; border-radius: 3px; overflow: hidden;
    margin-top: 4px;
}
.tw-ws-quota-bar-fill {
    height: 100%; background: linear-gradient(90deg, #4ade80, #facc15 70%, #ef4444);
    transition: width 0.3s;
}

/* v0.7.6 (#4): 컴팩트 모드 — Phase stepper와 수집/검증 카드 접기 */
.tw-batch-header-right {
    display: flex; align-items: center; gap: 8px;
}
.tw-btn-toggle-compact {
    font-size: 11px; padding: 4px 8px; white-space: nowrap;
}
.tw-btn-toggle-compact[data-compact="1"] {
    background: rgba(74,222,128,0.15); border-color: rgba(74,222,128,0.5); color: #4ade80;
}
.tw-batch-panel.tw-compact .tw-batch-stepper,
.tw-batch-panel.tw-compact .tw-batch-summary-cards {
    display: none !important;
}

/* v0.7.6 (#7): 좁은 모달 폭(<900px) 대응 — toolbar 압축 */
#tms-workflow-modal.tw-narrow .tw-review-toolbar { gap: 4px; row-gap: 4px; }
#tms-workflow-modal.tw-narrow .tw-review-toolbar .tw-btn { padding: 4px 7px; font-size: 11px; }
#tms-workflow-modal.tw-narrow .tw-review-toolbar-divider { display: none; }
#tms-workflow-modal.tw-narrow .tw-review-shortcut-hint { display: none; }
#tms-workflow-modal.tw-narrow .tw-review-filter-label { font-size: 11px; gap: 2px; }
#tms-workflow-modal.tw-narrow .tw-review-filter,
#tms-workflow-modal.tw-narrow .tw-review-sort { font-size: 11px; padding: 2px 4px; }
#tms-workflow-modal.tw-narrow .tw-review-toolbar-group { gap: 4px; }

/* v0.7.6 (#5): 최종 후보 편집 모달 */
.tw-final-edit-overlay {
    position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, sans-serif;
}
.tw-final-edit-dialog {
    background: #1f1f1f; color: #e0e0e0;
    border: 1px solid #3a3a3a; border-radius: 8px;
    width: min(960px, 92vw); max-height: 86vh;
    display: flex; flex-direction: column;
    box-shadow: 0 14px 48px rgba(0,0,0,0.55);
}
.tw-final-edit-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 18px; border-bottom: 1px solid #3a3a3a;
}
.tw-final-edit-title { font-size: 14px; font-weight: 600; color: #4ade80; }
.tw-final-edit-close {
    background: transparent; border: none; color: #888; font-size: 18px;
    cursor: pointer; padding: 0 6px; line-height: 1;
}
.tw-final-edit-close:hover { color: #e0e0e0; }
.tw-final-edit-body {
    display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
    padding: 14px 18px; overflow: auto; flex: 1 1 auto; min-height: 0;
}
.tw-final-edit-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.tw-final-edit-section {
    display: flex; flex-direction: column; gap: 4px;
    background: #252525; border: 1px solid #333; border-radius: 6px;
    padding: 8px 10px;
}
.tw-final-edit-section-label {
    font-size: 11px; font-weight: 600; color: #4ade80; text-transform: uppercase;
}
.tw-final-edit-section-body {
    font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    color: #d0d0d0; max-height: 180px; overflow: auto;
}
.tw-final-edit-section-body.tw-empty { color: #666; font-style: italic; }
.tw-final-edit-textarea {
    width: 100%; min-height: 220px; resize: vertical;
    background: #1a1a1a; color: #e0e0e0; border: 1px solid #3a3a3a;
    border-radius: 6px; padding: 8px 10px;
    font-family: inherit; font-size: 13px; line-height: 1.5;
    box-sizing: border-box;
}
.tw-final-edit-textarea:focus { outline: 2px solid #4ade80; outline-offset: -2px; }
.tw-final-edit-meta { font-size: 11px; color: #888; }
.tw-final-edit-footer {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 10px 18px; border-top: 1px solid #3a3a3a;
}
@media (max-width: 760px) {
    .tw-final-edit-body { grid-template-columns: 1fr; }
}
`;
        document.head.appendChild(style);
    }

    function populateSelects(el) {
        renderAllPromptSelects(el);
        renderAllModelSelects(el);
    }

    function renderAllPromptSelects(root = modalEl) {
        if (!root) return;
        $$('.tw-chat-prompt-select', root).forEach(selectEl => renderChatPromptSelect(selectEl));
        $$('.tw-batch-prompt-select', root).forEach(selectEl => renderBatchPromptSelect(selectEl));
    }

    function renderAllModelSelects(root = modalEl) {
        $$('.tw-model-select', root).forEach(selectEl => renderModelSelect(selectEl));
    }

    // 채팅 드롭다운 변경 → 채팅 활성 ID 저장. 잠금 ON이면 배치도 같이.
    function syncChatPromptSelects(promptId) {
        setChatActivePromptId(promptId);
        if (!modalEl) return;
        $$('.tw-chat-prompt-select', modalEl).forEach(selectEl => {
            selectEl.value = promptId;
        });
        if (getPromptLockLinked()) {
            setBatchActivePromptId(promptId);
            $$('.tw-batch-prompt-select', modalEl).forEach(selectEl => {
                selectEl.value = promptId;
            });
        }
    }

    // 배치 드롭다운 변경 → 배치 활성 ID 저장. 잠금 ON이면 채팅도 같이.
    function syncBatchPromptSelects(promptId) {
        setBatchActivePromptId(promptId);
        if (!modalEl) return;
        $$('.tw-batch-prompt-select', modalEl).forEach(selectEl => {
            selectEl.value = promptId;
        });
        if (getPromptLockLinked()) {
            setChatActivePromptId(promptId);
            $$('.tw-chat-prompt-select', modalEl).forEach(selectEl => {
                selectEl.value = promptId;
            });
        }
    }

    function syncModelSelects(model) {
        lsSet(LS_KEYS.MODEL, model);
        if (!modalEl) return;
        $$('.tw-model-select', modalEl).forEach(selectEl => {
            selectEl.value = model;
        });
    }

    function renderModelSelect(modelSelect) {
        if (!modelSelect) return;
        modelSelect.innerHTML = MODELS.map(m =>
            `<option value="${m}">${m}</option>`).join('');
        modelSelect.value = lsGet(LS_KEYS.MODEL, MODELS[0]);
        modelSelect.onchange = () => syncModelSelects(modelSelect.value);
    }

    function renderChatPromptSelect(selectEl) {
        if (!selectEl) return;
        const prompts = loadPrompts();
        const activeId = getChatActivePromptId();
        selectEl.innerHTML = prompts.map(p =>
            `<option value="${escapeHtml(String(p.id))}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
        ).join('');
        selectEl.onchange = () => syncChatPromptSelects(selectEl.value);
    }

    function renderBatchPromptSelect(selectEl) {
        if (!selectEl) return;
        const prompts = loadPrompts();
        const activeId = getBatchActivePromptId();
        selectEl.innerHTML = prompts.map(p =>
            `<option value="${escapeHtml(String(p.id))}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
        ).join('');
        selectEl.onchange = () => syncBatchPromptSelects(selectEl.value);
    }

    // ========================================================================
    // 이벤트 핸들러
    // ========================================================================
    function attachHandlers(el) {
        $$('.tw-main-tab', el).forEach(btn => {
            btn.addEventListener('click', () => setMainTab(btn.dataset.tab));
        });

        // 닫기
        $('.tw-btn-close', el).addEventListener('click', () => hideModal());

        // 드래그
        makeDraggable(el, $('.tw-header', el));

        // 리사이즈
        makeResizable(el, $('.tw-resize-handle', el));

        // 전송 버튼
        $('.tw-btn-send', el).addEventListener('click', onSend);

        // Ctrl+Enter 전송
        $('.tw-chat-input', el).addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onSend();
            }
        });

        // 세션 초기화
        $('.tw-btn-reset', el).addEventListener('click', onResetSession);

        // 번역 채택
        $('.tw-btn-adopt', el).addEventListener('click', onAdoptTranslation);

        // v0.6.10 C2-신: AI 메시지 인라인 액션 (셀로 적용 / 복사)
        const messagesEl = $('.tw-chat-messages', el);
        if (messagesEl) messagesEl.addEventListener('click', onChatMessageAction);

        // 설정 버튼
        $('.tw-btn-settings', el).addEventListener('click', showSettingsPanel);

        $('.tw-btn-batch-collect', el).addEventListener('click', onBatchCollect);
        $('.tw-btn-phase12', el).addEventListener('click', () => onRunBatchPhase('1+2'));
        $('.tw-btn-phase3', el).addEventListener('click', () => onRunBatchPhase('3'));
        $('.tw-btn-phase45', el).addEventListener('click', () => onRunBatchPhase('4+5'));
        $('.tw-btn-batch-refetch', el).addEventListener('click', onBatchRefetchResult);
        $('.tw-btn-batch-reset', el).addEventListener('click', onBatchReset);
        // v0.7.6 (#4): 컴팩트 모드 토글
        const compactBtn = $('.tw-btn-toggle-compact', el);
        const batchPanel = $('.tw-batch-panel', el);
        if (compactBtn && batchPanel) {
            const applyCompact = (on) => {
                batchPanel.classList.toggle('tw-compact', !!on);
                compactBtn.dataset.compact = on ? '1' : '0';
                compactBtn.textContent = on ? '📐 컴팩트 ✓' : '📐 컴팩트';
                compactBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
            };
            applyCompact(lsGet(LS_KEYS.COMPACT_MODE) === '1');
            compactBtn.addEventListener('click', () => {
                const next = compactBtn.dataset.compact !== '1';
                applyCompact(next);
                lsSet(LS_KEYS.COMPACT_MODE, next ? '1' : '0');
            });
        }
        $('.tw-btn-log-copy', el).addEventListener('click', onCopyLogOutput);
        $('.tw-btn-review-apply-selected', el).addEventListener('click', () => applyBatchTranslationsByIds(getSelectedReviewIds()));
        $('.tw-btn-review-apply-all', el).addEventListener('click', () => applyBatchTranslationsByIds(getReviewTranslationIds()));
        // v0.6.5 (A1): 수정만 입력
        $('.tw-btn-review-apply-edited', el).addEventListener('click', () => applyBatchTranslationsByIds(getEditedReviewIds()));
        // v0.6.5 (A3): 필터/정렬 변경 → 재렌더
        $('.tw-review-filter', el).addEventListener('change', (e) => { reviewView.filter = e.target.value || 'all'; renderReviewTable(); });
        $('.tw-review-sort', el).addEventListener('change', (e) => { reviewView.sort = e.target.value || 'id'; renderReviewTable(); });
        // v0.6.6 (B1): 고아 override 정리
        $('.tw-btn-review-gc', el).addEventListener('click', onReviewOverrideGc);

        // v0.6.8 (A1): 실패만 보기 토글 + 실패 ID 칩 클릭
        $('.tw-btn-review-failed-toggle', el).addEventListener('click', onToggleFailedOnly);
        $('.tw-review-failed-chips', el).addEventListener('click', onFailedChipClick);

        // v0.6.9 (G1-d): 배치 패널 요약 카드 → review 탭 점프
        const batchCards = $('.tw-batch-summary-cards', el);
        if (batchCards) batchCards.addEventListener('click', onBatchSummaryCardClick);

        // v0.6.9 hotfix2: 세그먼트 보기 버튼 / 오버레이 닫기
        const segBtn = $('.tw-btn-show-segments', el);
        if (segBtn) segBtn.addEventListener('click', openSegmentsOverlay);
        const segCloseBtn = $('.tw-btn-close-segments', el);
        if (segCloseBtn) segCloseBtn.addEventListener('click', closeSegmentsOverlay);
        // ESC로 오버레이 닫기
        const segOverlay = $('.tw-batch-segments-overlay', el);
        if (segOverlay) {
            segOverlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSegmentsOverlay(); });
        }

        // v0.6.7 (C2): 비교 모드 select / 종료 버튼
        $('.tw-btn-review-compare-exit', el).addEventListener('click', onExitCompareMode);
        // v0.7.0 B5: override 포함 토글 — compare 모드에서만 노출
        $('.tw-review-compare-overrides', el).addEventListener('change', (e) => {
            reviewView.compareIncludeOverrides = !!e.target.checked;
            renderReviewTable();
        });
        // v0.6.7 (C3): export JSON/CSV
        $('.tw-btn-review-export-json', el).addEventListener('click', onExportRunJson);
        $('.tw-btn-review-export-csv', el).addEventListener('click', onExportRunCsv);
        // v0.6.10 E1: override export/import
        $('.tw-btn-review-export-overrides', el).addEventListener('click', onExportOverrides);
        $('.tw-btn-review-import-overrides', el).addEventListener('click', () => {
            $('.tw-review-import-overrides-file', el)?.click();
        });
        $('.tw-review-import-overrides-file', el).addEventListener('change', onImportOverridesFile);
        // v0.7.0 G1-c: history 패널 토글 + 행 액션 위임
        $('.tw-btn-review-history', el).addEventListener('click', onToggleHistory);
        $('.tw-review-history-panel', el).addEventListener('click', (e) => {
            const act = e.target.closest('.tw-btn-history-activate');
            if (act) { onActivateRun(act.getAttribute('data-run-id')); return; }
            const cmp = e.target.closest('.tw-btn-history-compare');
            if (cmp) { onCompareWithRun(cmp.getAttribute('data-run-id')); return; }
            const cmpExit = e.target.closest('.tw-btn-history-compare-exit');
            if (cmpExit) { onExitCompareMode(); return; }
            const ren = e.target.closest('.tw-btn-history-rename');
            if (ren) { onRenameRun(ren.getAttribute('data-run-id')); return; }
            const del = e.target.closest('.tw-btn-history-delete');
            if (del) { onDeleteRun(del.getAttribute('data-run-id')); return; }
        });
        // v0.6.7 (D1): 로그 필터/검색/다운로드
        $('.tw-log-level', el).addEventListener('change', onLogLevelChange);
        $('.tw-log-search', el).addEventListener('input', onLogSearchInput);
        $('.tw-btn-log-download', el).addEventListener('click', onDownloadLog);

        // v0.7.0 G1-b 보강: 실패/경고 phase step 클릭 → 로그 탭으로 점프 + phase 이름 필터
        const stepperEl = $('.tw-batch-stepper', el);
        if (stepperEl) {
            stepperEl.addEventListener('click', (e) => {
                const step = e.target.closest('.tw-batch-step.tw-step-actionable');
                if (!step) return;
                const key = step.getAttribute('data-phase-key');
                const PHASE_LOG_QUERY = { collect: '수집', phase12: 'Phase 1+2', phase3: 'Phase 3', phase45: 'Phase 4+5' };
                const q = PHASE_LOG_QUERY[key];
                if (!q) return;
                logView.query = q;
                setMainTab('logs');
                const searchInput = $('.tw-log-search', el);
                if (searchInput) searchInput.value = q;
                renderLogOutput();
                toast(`📜 로그 탭에서 "${q}" 항목으로 필터했어요`, 'info', 3000);
            });
        }

        $('.tw-review-table', el).addEventListener('click', async (e) => {
            // v0.7.0 B4 재설계: warn chip 클릭 → 위반 상세를 toast로 표시
            // (chip의 title 속성에 이미 상세 메시지가 들어있음. v0.6.10의 자기 행 flash는
            //  이미 보이는 행이라 정보적 가치가 낮아 상세 안내로 교체)
            const warnChip = e.target.closest('.tw-review-warn-chip');
            if (warnChip) {
                const kind = warnChip.classList.contains('tw-review-warn-tb') ? 'TB 용어'
                    : warnChip.classList.contains('tw-review-warn-order') ? 'placeholder 순서'
                    : warnChip.classList.contains('tw-review-warn-charlimit') ? '길이'
                    : '검증';
                const detail = warnChip.getAttribute('title') || '상세 없음';
                toast(`⚠ ${kind} — ${detail}`, 'warn', 6000);
                return;
            }

            const copyBtn = e.target.closest('.tw-btn-copy-final');
            if (copyBtn) {
                const text = getBatchFinalText(Number(copyBtn.dataset.id));
                if (!text) return;
                try {
                    await navigator.clipboard.writeText(text);
                    toast('최종 후보를 클립보드에 복사했습니다.', 'success');
                } catch {
                    toast('클립보드 복사에 실패했습니다.', 'error');
                }
                return;
            }

            const applyBtn = e.target.closest('.tw-btn-apply-final');
            if (applyBtn) {
                await applyBatchTranslationsByIds([Number(applyBtn.dataset.id)]);
                renderReviewTable(); // v0.6.0: applied 배지 즉시 반영
                return;
            }

            // v0.6.0 L2: review → chat 점프
            const refineBtn = e.target.closest('.tw-btn-chat-refine');
            if (refineBtn) {
                await onChatRefineFromReview(Number(refineBtn.dataset.id));
                return;
            }

            // v0.6.2: 인라인 직접 수정 진입
            const editBtn = e.target.closest('.tw-btn-edit-final');
            if (editBtn) {
                openInlineFinalEditor(normalizeId(editBtn.dataset.id));
                return;
            }
            // v0.6.2: 인라인 수정 저장
            const saveBtn = e.target.closest('.tw-btn-edit-save');
            if (saveBtn) {
                commitInlineFinalEditor(normalizeId(saveBtn.dataset.id));
                return;
            }
            // v0.6.2: 인라인 수정 취소
            const cancelBtn = e.target.closest('.tw-btn-edit-cancel');
            if (cancelBtn) {
                renderReviewTable();
                return;
            }
            // v0.6.2: override 되돌리기
            const revertBtn = e.target.closest('.tw-btn-revert-final');
            if (revertBtn) {
                const id = normalizeId(revertBtn.dataset.id);
                const run = batchRun || restoreActiveBatchRun();
                if (run?.runId) {
                    const ok = await twConfirm({
                        title: '직접 수정 되돌리기',
                        message: `#${id} 직접 수정을 되돌리고 배치 결과로 복원하시겠습니까?`,
                        danger: true,
                    });
                    if (!ok) return;
                    clearReviewOverride(run.runId, id);
                    appendBatchLog(`#${id} 직접 수정 되돌림`, 'info');
                    renderReviewTable();
                }
                return;
            }
        });

        // v0.7.5: 검토 표 행 키보드 단축키 — ↑↓ 이동, E 편집, A 적용, C 복사
        $('.tw-review-table', el).addEventListener('keydown', async (e) => {
            const tag = (e.target.tagName || '').toUpperCase();
            // 입력 컨트롤에서는 단축키 가로채지 않음
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            const row = e.target.closest('.tw-review-row[data-row-id]');
            if (!row) return;
            const id = row.dataset.rowId;

            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                // v0.7.7 (#6): 청크 렌더 중이면 동기 flush로 인덱스 일관성 확보
                try { renderReviewTable._pendingFlush && renderReviewTable._pendingFlush(); } catch {}
                const rows = $$('.tw-review-row[data-row-id]', el);
                const idx = rows.indexOf(row);
                if (idx < 0) return;
                const nextIdx = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
                const next = rows[nextIdx];
                if (next && next !== row) {
                    next.focus();
                    next.scrollIntoView({ block: 'nearest' });
                }
                return;
            }
            const k = e.key.toLowerCase();
            if (k === 'e') {
                e.preventDefault();
                openInlineFinalEditor(normalizeId(id));
                return;
            }
            if (k === 'a') {
                e.preventDefault();
                await applyBatchTranslationsByIds([Number(id)]);
                renderReviewTable();
                // 재렌더 후 같은 행에 포커스 복원
                const restored = $(`.tw-review-row[data-row-id="${CSS && CSS.escape ? CSS.escape(String(id)) : String(id)}"]`, el);
                if (restored) restored.focus();
                return;
            }
            if (k === 'c') {
                e.preventDefault();
                const text = getBatchFinalText(Number(id));
                if (!text) { toast(`#${id} 복사할 최종 후보가 없습니다.`, 'error'); return; }
                try {
                    await navigator.clipboard.writeText(text);
                    toast('최종 후보를 클립보드에 복사했습니다.', 'success');
                } catch {
                    toast('클립보드 복사에 실패했습니다.', 'error');
                }
                return;
            }
        });

        // v0.7.5: 행 어디든 클릭하면 키보드 포커스가 그 행으로 이동 (단축키 시작점 명확화)
        $('.tw-review-table', el).addEventListener('click', (e) => {
            const tag = (e.target.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            const row = e.target.closest('.tw-review-row[data-row-id]');
            if (row && document.activeElement !== row) row.focus();
        });

        $('.tw-review-table', el).addEventListener('change', (e) => {
            if (!e.target.classList.contains('tw-review-select-all')) return;
            $$('.tw-review-select', el).forEach(input => {
                input.checked = e.target.checked;
            });
            const count = $$('.tw-review-select:checked', el).length;
            updateReviewApplyStatus(`${count}개 선택됨`);
        });

        $('.tw-review-table', el).addEventListener('change', (e) => {
            if (!e.target.classList.contains('tw-review-select')) return;
            const count = $$('.tw-review-select:checked', el).length;
            updateReviewApplyStatus(`${count}개 선택됨`);
        });
    }

    function updateReviewApplyStatus(message) {
        const el = $('.tw-review-apply-status', modalEl);
        if (el) el.textContent = message;
    }

    // v0.6.8 (A1): 실패 ID 칩/토글 영역 갱신
    function refreshFailedChips() {
        if (!modalEl) return;
        const wrap = $('.tw-review-failed-chips', modalEl);
        const toggle = $('.tw-btn-review-failed-toggle', modalEl);
        if (!wrap || !toggle) return;
        const ids = reviewView.lastFailedIds || [];
        if (!ids.length) {
            wrap.classList.add('tw-hidden');
            toggle.classList.add('tw-hidden');
            toggle.classList.remove('tw-active');
            wrap.innerHTML = '';
            return;
        }
        wrap.classList.remove('tw-hidden');
        toggle.classList.remove('tw-hidden');
        toggle.textContent = `🔁 실패만 보기 (${ids.length})`;
        toggle.classList.toggle('tw-active', !!reviewView.showOnlyFailed);
        const preview = ids.slice(0, 12).map(id =>
            `<button type="button" class="tw-review-failed-chip" data-failed-id="${escapeHtml(String(id))}" title="#${escapeHtml(String(id))} 행으로 이동">#${escapeHtml(String(id))}</button>`
        ).join('');
        const more = ids.length > 12 ? `<span class="tw-muted" style="font-size:11px;">+${ids.length - 12}</span>` : '';
        wrap.innerHTML = preview + more;
    }

    // v0.6.8 (A1): 특정 review row로 스크롤 + 짧은 하이라이트
    function scrollToReviewRow(id) {
        if (!modalEl) return false;
        const norm = normalizeId(id);
        const row = $(`.tw-review-row[data-row-id="${CSS && CSS.escape ? CSS.escape(String(norm)) : String(norm)}"]`, modalEl);
        if (!row) return false;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('tw-review-row-flash');
        // reflow trigger then re-add for animation restart
        void row.offsetWidth;
        row.classList.add('tw-review-row-flash');
        return true;
    }

    function onToggleFailedOnly() {
        if (!reviewView.lastFailedIds.length) return;
        reviewView.showOnlyFailed = !reviewView.showOnlyFailed;
        renderReviewTable();
    }

    function onFailedChipClick(e) {
        const btn = e.target.closest('.tw-review-failed-chip');
        if (!btn) return;
        const id = btn.getAttribute('data-failed-id');
        if (!id) return;
        if (reviewView.showOnlyFailed) {
            // 필터 켜진 상태면 그대로 스크롤
            if (!scrollToReviewRow(id)) toast(`#${id} 행을 찾지 못했습니다.`, 'info');
            return;
        }
        // 필터 꺼진 상태에서는 한 번 렌더 후 스크롤
        if (!scrollToReviewRow(id)) toast(`#${id} 행을 찾지 못했습니다.`, 'info');
    }

    function makeDraggable(modal, handle) {
        let startX, startY, startLeft, startTop;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            const rect = modal.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            // transform 제거하고 left/top 절대 좌표로
            modal.style.transform = 'none';
            modal.style.left = `${rect.left}px`;
            modal.style.top = `${rect.top}px`;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp, { once: true });
        });
        function onMove(e) {
            modal.style.left = `${startLeft + e.clientX - startX}px`;
            modal.style.top = `${startTop + e.clientY - startY}px`;
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            saveModalPosition(modal);
        }
    }

    function makeResizable(modal, handle) {
        let startX, startY, startW, startH;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const rect = modal.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startW = rect.width; startH = rect.height;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp, { once: true });
        });
        function onMove(e) {
            modal.style.width = `${Math.max(600, startW + e.clientX - startX)}px`;
            modal.style.height = `${Math.max(400, startH + e.clientY - startY)}px`;
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            saveModalSize(modal);
        }
    }

    function saveModalPosition(el) {
        const r = el.getBoundingClientRect();
        lsSet(LS_KEYS.MODAL_POS, { left: r.left, top: r.top });
    }
    function saveModalSize(el) {
        lsSet(LS_KEYS.MODAL_SIZE, { width: el.offsetWidth, height: el.offsetHeight });
    }
    function restoreModalPosition(el) {
        const pos = lsGet(LS_KEYS.MODAL_POS);
        const size = lsGet(LS_KEYS.MODAL_SIZE);
        if (pos) {
            el.style.transform = 'none';
            el.style.left = `${pos.left}px`;
            el.style.top = `${pos.top}px`;
        }
        if (size) {
            el.style.width = `${size.width}px`;
            el.style.height = `${size.height}px`;
        }
    }

    function setMainTab(tab) {
        currentMainTab = tab || 'chat';
        if (!modalEl) return;

        $$('.tw-main-tab', modalEl).forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === currentMainTab);
        });
        $$('.tw-tab-content', modalEl).forEach(panel => {
            panel.classList.toggle('active', panel.dataset.tabContent === currentMainTab);
        });

        if (currentMainTab === 'batch') {
            ensureBatchRun();
            renderBatchRun();
        } else if (currentMainTab === 'review') {
            renderReviewTable();
        } else if (currentMainTab === 'logs') {
            renderLogOutput();
        }
    }

    function isBatchBusy(status) {
        // 실제 코드에서 set되는 busy 상태는 'collecting'뿐. phase_* 후보는 향후
        // 확장을 위해 이름만 남겨둡고, 설정되는 곳이 추가될 때 함께 업데이트.
        return status === 'collecting';
    }

    // 검증 객체에서 실패 사유를 짧은 토큰 배열로 추출. 간단 표시용.
    function summarizeValidationIssues(validation) {
        if (!validation) return [];
        const tokens = [];
        const c = validation.coverage;
        if (c && !c.ok) {
            if (c.missing?.length) tokens.push(`누락 ${c.missing.length}`);
            if (c.extra?.length) tokens.push(`추가 ${c.extra.length}`);
            if (c.duplicates?.length) tokens.push(`중복 ${c.duplicates.length}`);
        }
        // Phase 1+2 전용
        if (validation.invalidGroups?.length) {
            tokens.push(`그룹 스키마 ${validation.invalidGroups.length}`);
        }
        if (validation.groupsCount === 0) tokens.push('그룹 0');
        // Phase 3 / 4+5 공용
        if (validation.wrongGroups?.length) tokens.push(`그룹ID 불일치 ${validation.wrongGroups.length}`);
        if (validation.invalidTranslationType?.length) tokens.push(`번역타입 ${validation.invalidTranslationType.length}`);
        if (validation.emptyTranslations?.length) tokens.push(`빈 번역 ${validation.emptyTranslations.length}`);
        if (validation.missingPlaceholders?.length) tokens.push(`플레이스홀더 누락 ${validation.missingPlaceholders.length}`);
        if (validation.hanjaLike?.length) tokens.push(`한자 잔존 ${validation.hanjaLike.length}`);
        // Phase 4+5 전용
        if (validation.missingTField?.length) tokens.push(`t 필드 ${validation.missingTField.length}`);
        if (validation.invalidTType?.length) tokens.push(`t 타입 ${validation.invalidTType.length}`);
        if (validation.invalidReasons?.length) tokens.push(`reason ${validation.invalidReasons.length}`);
        if (validation.emptyFinals?.length) tokens.push(`빈 최종 ${validation.emptyFinals.length}`);
        return tokens;
    }

    function formatPhaseValidation(validation) {
        if (!validation) return '대기';
        const c = validation.coverage;
        if (validation.ok) {
            return c ? `OK (${c.actualCount}/${c.expectedCount})` : 'OK';
        }
        const issues = summarizeValidationIssues(validation);
        const issueStr = issues.length ? ` — ${issues.join(', ')}` : '';
        const counts = c ? ` (${c.actualCount}/${c.expectedCount})` : '';
        return `주의 필요${counts}${issueStr}`;
    }

    // v0.6.9 (G1-d): 배치 패널 카드용 요약 통계 — 순수 함수, run만 보고 집계
    // 반환 구조:
    //   { segments, phase3:{state,actual,expected}, phase45:{state,changed,kept,total},
    //     warns:{charLimit,order,tb,total}, applied:{count,drifted,unknown}, lastError }
    function buildBatchSummaryStats(run) {
        if (!run) return null;
        const segments = (run.segments || []).length;
        // phase3
        const p3v = run.phase3?.validation;
        const p3 = { state: 'pending', actual: 0, expected: 0 };
        if (p3v) {
            const cov = p3v.coverage || {};
            p3.actual = cov.actualCount || 0;
            p3.expected = cov.expectedCount || 0;
            p3.state = p3v.ok ? 'ok' : 'fail';
        }
        // phase45
        const p45v = run.phase45?.validation;
        const revisions = run.phase45?.parsed?.revisions || [];
        const changed = revisions.filter(r => r.t !== null && r.t !== undefined).length;
        const kept = revisions.length - changed;
        const p45 = {
            state: p45v ? (p45v.ok ? 'ok' : 'fail') : 'pending',
            changed, kept, total: revisions.length,
        };
        // warn-only (phase45 우선, 없으면 phase3 폴백)
        const warnSrc = (p45v?.warnings ? p45v : (run.phase3?.validation || {})).warnings || {};
        const warns = {
            charLimit: (warnSrc.charLimitOver || []).length,
            order: (warnSrc.placeholderOrderMismatch || []).length,
            tb: (warnSrc.tbTermsMissed || []).length,
        };
        warns.total = warns.charLimit + warns.order + warns.tb;
        return { segments, phase3: p3, phase45: p45, warns, lastError: run.lastError || null };
    }

    function renderBatchRun() {
        if (!modalEl) return;
        const run = batchRun || restoreActiveBatchRun();
        if (run && !batchRun) batchRun = run;

        const statusEl = $('.tw-batch-status', modalEl);
        const warningEl = $('.tw-batch-warning', modalEl);
        const segmentsEl = $('.tw-batch-segments', modalEl); // overlay body
        const segmentsBtn = $('.tw-btn-show-segments', modalEl);
        if (!statusEl || !warningEl || !segmentsEl) return;

        if (!run) {
            statusEl.textContent = '대기 중';
            warningEl.textContent = '';
            segmentsEl.innerHTML = '<span class="tw-muted">현재 페이지 수집을 먼저 실행하세요.</span>';
            if (segmentsBtn) {
                segmentsBtn.disabled = true;
                segmentsBtn.textContent = '📋 수집 세그먼트 보기';
            }
            renderBatchRunHeader(null);
            renderBatchPhaseStepper(null);
            renderBatchSummaryCards(null);
            renderBatchConfigRow(null);
            updateBatchButtons(null);
            renderBatchTimeline(null);
            renderLogOutput();
            renderReviewTable();
            return;
        }

        statusEl.textContent = BATCH_STATUS_LABELS[run.status] || run.status || '대기 중';

        renderBatchRunHeader(run);
        renderBatchPhaseStepper(run);
        renderBatchSummaryCards(run);
        renderBatchConfigRow(run);

        warningEl.textContent = run.storageStringId
            ? `주의: Phase 실행 결과는 storageStringId ${run.storageStringId}의 번역 칸에 저장됩니다. 테스트 후 수동 정리가 필요해요.`
            : '';

        const segCount = run.segments?.length || 0;
        if (segmentsBtn) {
            segmentsBtn.disabled = segCount === 0;
            segmentsBtn.textContent = segCount > 0
                ? `📋 수집 세그먼트 보기 (${segCount}개)`
                : '📋 수집 세그먼트 보기';
        }
        if (segCount) {
            const preview = run.segments.map(seg => {
                const text = String(seg.origin_string || '').replace(/\s+/g, ' ').slice(0, 200);
                return `<div><b>#${escapeHtml(seg.id)}</b> ${escapeHtml(text)}</div>`;
            }).join('');
            segmentsEl.innerHTML = preview;
        } else {
            segmentsEl.innerHTML = '<span class="tw-muted">현재 페이지 수집을 먼저 실행하세요.</span>';
        }

        updateBatchButtons(run);
        renderBatchTimeline(run);
        renderLogOutput();
        renderReviewTable();
    }

    // v0.6.9 hotfix2: 사용 모델/프롬프트 미니 표시
    function renderBatchConfigRow(run) {
        const el = $('.tw-batch-config-row', modalEl);
        if (!el) return;
        const model = (run && run.model) || (typeof getSelectedModel === 'function' ? getSelectedModel() : '');
        let promptName = '';
        try {
            const p = getBatchActivePrompt();
            promptName = p?.name || p?.id || '';
        } catch (_) { /* noop */ }
        const items = [];
        if (model) items.push({ k: '모델', v: String(model) });
        if (promptName) items.push({ k: '프롬프트', v: String(promptName) });
        if (run) {
            items.push({ k: '파일', v: `proj ${run.projectId || '?'} / file ${run.fileId || '?'} / lang ${run.languageId || '?'}` });
            if (run.page || run.pageSize) items.push({ k: '페이지', v: `${run.page || '?'} / ${run.pageSize || '?'}` });
        }
        if (!items.length) { el.innerHTML = ''; return; }
        el.innerHTML = items.map(it => `
            <span class="tw-batch-config-item" title="${escapeHtml(it.k)}: ${escapeHtml(it.v)}">
                <span class="tw-batch-config-key">${escapeHtml(it.k)}</span>
                <span class="tw-batch-config-val">${escapeHtml(it.v)}</span>
            </span>
        `).join('');
    }

    function openSegmentsOverlay() {
        if (!modalEl) return;
        const overlay = $('.tw-batch-segments-overlay', modalEl);
        if (overlay) overlay.classList.remove('tw-hidden');
    }
    function closeSegmentsOverlay() {
        if (!modalEl) return;
        const overlay = $('.tw-batch-segments-overlay', modalEl);
        if (overlay) overlay.classList.add('tw-hidden');
    }

    // v0.6.9 (G1-a): 활성 run 헤더 카드
    function renderBatchRunHeader(run) {
        const el = $('.tw-batch-run-header', modalEl);
        const subtitleEl = $('.tw-batch-meta', modalEl);
        if (!el) return;
        if (!run) {
            el.classList.add('tw-hidden');
            el.innerHTML = '';
            if (subtitleEl) subtitleEl.classList.remove('tw-hidden');
            return;
        }
        el.classList.remove('tw-hidden');
        if (subtitleEl) subtitleEl.classList.add('tw-hidden'); // run 있으면 안내 문구 숨김
        const runIdShort = String(run.runId || '').slice(-12) || '?';
        const stamp = run.updatedAt ? String(run.updatedAt).slice(0, 19).replace('T', ' ') : '';
        const overrides = (function () {
            try {
                const all = loadReviewOverrides();
                return Object.keys(all[run.runId] || {}).length;
            } catch (_) { return 0; }
        })();
        el.innerHTML = `
            <span class="tw-batch-run-id" title="runId: ${escapeHtml(String(run.runId || ''))}${run.label ? `\n라벨: ${run.label}` : ''}">🏃 ${escapeHtml(run.label || runIdShort)}</span>
            <span class="tw-batch-run-meta">project <b>${escapeHtml(String(run.projectId || '?'))}</b> / file <b>${escapeHtml(String(run.fileId || '?'))}</b> / lang <b>${escapeHtml(String(run.languageId || '?'))}</b></span>
            <span class="tw-batch-run-meta">override <b>${overrides}</b></span>
            <span class="tw-batch-run-stamp">${escapeHtml(stamp)}</span>
        `;
    }

    // v0.6.9 (G1-b): Phase stepper — 단계별 상태 시각화
    function renderBatchPhaseStepper(run) {
        const el = $('.tw-batch-stepper', modalEl);
        if (!el) return;
        if (!run) { el.innerHTML = ''; return; }
        const busyStatus = run.status === 'collecting';
        const steps = [
            {
                key: 'collect', name: '수집',
                state: (run.segments && run.segments.length) ? 'done' : (busyStatus ? 'busy' : 'idle'),
                detail: run.segments?.length ? `${run.segments.length}개` : '',
            },
            {
                key: 'phase12', name: 'Phase 1+2',
                state: phaseStateFor(run.phase12),
                detail: phaseStateDetail(run.phase12),
            },
            {
                key: 'phase3', name: 'Phase 3',
                state: phaseStateFor(run.phase3),
                detail: phaseStateDetail(run.phase3),
            },
            {
                key: 'phase45', name: 'Phase 4+5',
                state: phaseStateFor(run.phase45),
                detail: phaseStateDetail(run.phase45),
            },
        ];
        const ICON = { idle: '⭕', busy: '◐', done: '✅', warn: '⚠', fail: '❌' };
        // v0.7.0 G1-b 보강: fail/warn step 클릭 → 로그 탭 + phase 이름으로 필터
        const PHASE_LOG_QUERY = { collect: '수집', phase12: 'Phase 1+2', phase3: 'Phase 3', phase45: 'Phase 4+5' };
        // v0.7.1: 현재 실행 중인 phase는 busy 상태로 표시 (icon이 회전)
        const RUNNING_KEY_FOR_STATUS = {
            collecting: 'collect',
            phase12_running: 'phase12',
            phase3_running: 'phase3',
            phase45_running: 'phase45',
        };
        const runningKey = RUNNING_KEY_FOR_STATUS[run.status];
        el.innerHTML = steps.map(s => {
            // 현재 실행 중인 phase면 busy로 덮어쓰기 (단, 이미 done인 경우는 유지)
            if (runningKey === s.key && s.state !== 'done') {
                s.state = 'busy';
            }
            const cls = s.state === 'done' ? 'tw-step-done'
                : s.state === 'fail' ? 'tw-step-fail'
                : s.state === 'warn' ? 'tw-step-warn'
                : s.state === 'busy' ? 'tw-step-busy'
                : '';
            const actionable = (s.state === 'fail' || s.state === 'warn') && PHASE_LOG_QUERY[s.key];
            const dataAttr = actionable ? ` data-phase-key="${escapeHtml(s.key)}"` : '';
            const actionableCls = actionable ? ' tw-step-actionable' : '';
            const titleSuffix = actionable ? ' · 클릭 시 로그 탭에서 해당 phase 항목 필터' : '';
            const iconCls = s.state === 'busy' ? ' tw-batch-step-icon-spin' : '';
            return `<div class="tw-batch-step ${cls}${actionableCls}"${dataAttr} title="${escapeHtml(s.name)}: ${escapeHtml(s.state)}${titleSuffix}">
                <span class="tw-batch-step-icon${iconCls}">${ICON[s.state] || '⭕'}</span>
                <span class="tw-batch-step-name">${escapeHtml(s.name)}</span>
                ${s.detail ? `<span class="tw-batch-step-detail">${escapeHtml(s.detail)}</span>` : ''}
            </div>`;
        }).join('');
    }

    function phaseStateFor(phase) {
        if (!phase) return 'idle';
        if (phase.validation) return phase.validation.ok ? 'done' : 'fail';
        if (phase.parsed || phase.raw) return 'warn'; // 결과는 있는데 검증 미완
        return 'idle';
    }
    function phaseStateDetail(phase) {
        const c = phase?.validation?.coverage;
        if (!c) return '';
        const a = c.actualCount, e = c.expectedCount;
        if ((a == null) && (e == null)) return '';
        if (!a && !e) return ''; // 0/0은 숨김
        return `${a || 0}/${e || 0}`;
    }

    // v0.6.9 (G1-d): 수집/검증 결과 카드 — 클릭 시 review 탭 필터 자동 적용
    function renderBatchSummaryCards(run) {
        const el = $('.tw-batch-summary-cards', modalEl);
        if (!el) return;
        if (!run) { el.innerHTML = ''; return; }
        const stats = buildBatchSummaryStats(run);
        if (!stats) { el.innerHTML = ''; return; }

        const cards = [];
        // 세그먼트 카드 (정보용, 클릭 비활성)
        cards.push({
            cls: 'tw-summary-info',
            label: '세그먼트',
            value: `${stats.segments}개`,
            sub: stats.segments ? '수집 OK' : '미수집',
        });
        // Phase 3
        if (stats.phase3.state !== 'pending') {
            const okCls = stats.phase3.state === 'ok' ? 'tw-summary-ok' : 'tw-summary-fail';
            cards.push({
                cls: okCls,
                label: 'Phase 3',
                value: `${stats.phase3.actual}/${stats.phase3.expected}`,
                sub: stats.phase3.state === 'ok' ? '검증 통과' : '검증 실패',
            });
        }
        // Phase 4+5 — changed/kept 클릭 가능
        if (stats.phase45.state !== 'pending') {
            cards.push({
                cls: stats.phase45.state === 'ok' ? 'tw-summary-ok' : 'tw-summary-warn',
                label: 'Phase 4+5 변경',
                value: `${stats.phase45.changed}`,
                sub: `유지 ${stats.phase45.kept} · 합 ${stats.phase45.total}`,
                clickFilter: 'edited',
            });
        }
        // Warn (있을 때만)
        if (stats.warns.total > 0) {
            const warnDetails = [];
            if (stats.warns.charLimit) warnDetails.push({ value: stats.warns.charLimit, label: '길이', filter: 'warn-charlimit' });
            if (stats.warns.order) warnDetails.push({ value: stats.warns.order, label: '순서', filter: 'warn-order' });
            if (stats.warns.tb) warnDetails.push({ value: stats.warns.tb, label: '용어', filter: 'warn-tb' });
            // 각 warn 종류별 카드
            for (const w of warnDetails) {
                cards.push({
                    cls: 'tw-summary-warn',
                    label: `Warn ${w.label}`,
                    value: `${w.value}`,
                    sub: '클릭 → 검토 필터',
                    clickFilter: w.filter,
                });
            }
        }
        // Applied / Drift
        const driftStats = computeAppliedStats(run);
        if (driftStats.count > 0) {
            cards.push({
                cls: driftStats.drifted > 0 ? 'tw-summary-warn' : 'tw-summary-ok',
                label: 'Applied',
                value: `${driftStats.count}`,
                sub: driftStats.drifted > 0
                    ? `drift ${driftStats.drifted} · 확인불가 ${driftStats.unknown}`
                    : `drift 0`,
                clickFilter: driftStats.drifted > 0 ? 'drifted' : 'applied',
            });
        }
        // 마지막 오류
        if (stats.lastError) {
            cards.push({
                cls: 'tw-summary-fail',
                label: '마지막 오류',
                value: '❌',
                sub: String(stats.lastError).slice(0, 80),
            });
        }
        el.innerHTML = cards.map(c => `
            <div class="tw-summary-card ${c.cls} ${c.clickFilter ? 'tw-summary-clickable' : ''}"
                 ${c.clickFilter ? `data-jump-filter="${escapeHtml(c.clickFilter)}"` : ''}
                 ${c.clickFilter ? `title="검토 탭으로 이동하고 필터 '${escapeHtml(c.clickFilter)}' 적용"` : ''}>
                <div class="tw-summary-label">${escapeHtml(c.label)}</div>
                <div class="tw-summary-value">${escapeHtml(c.value)}</div>
                ${c.sub ? `<div class="tw-summary-sub">${escapeHtml(c.sub)}</div>` : ''}
            </div>
        `).join('');
    }

    // 헬퍼: applied/drift 집계 (renderReviewTable의 로직 발췌, 카드용 경량 버전)
    function computeAppliedStats(run) {
        const out = { count: 0, drifted: 0, unknown: 0 };
        if (!run?.phase3?.parsed?.translations) return out;
        const segmentById = new Map((run.segments || []).map(seg => [normalizeId(seg.id), seg]));
        for (const tr of run.phase3.parsed.translations) {
            const id = normalizeId(tr.id);
            const a = getAppliedFromBatch(id);
            if (!a || (run.runId && a.runId && a.runId !== run.runId)) continue;
            out.count += 1;
            const ta = findTranslationTextareaForStringId(id);
            if (ta) {
                if (ta.value !== a.text) out.drifted += 1;
            } else {
                const seg = segmentById.get(id);
                const cur = seg?.active_result?.result;
                if (typeof cur === 'string') {
                    if (cur !== a.text) out.drifted += 1;
                } else {
                    out.unknown += 1;
                }
            }
        }
        return out;
    }

    // v0.6.9 (G1-d): 카드 클릭 → review 탭으로 이동 + 필터 적용
    function onBatchSummaryCardClick(e) {
        const card = e.target.closest('.tw-summary-card.tw-summary-clickable');
        if (!card) return;
        const filter = card.getAttribute('data-jump-filter');
        if (!filter) return;
        // 비교 모드는 끄고 필터만 적용
        reviewView.compareMode = false;
        reviewView.compareRunId = null;
        reviewView.filter = filter;
        setMainTab('review');
        renderReviewTable();
    }

    function renderBatchTimeline(run) {
        if (!modalEl) return;
        const timelineEl = $('.tw-batch-timeline', modalEl);
        if (!timelineEl) return;

        if (!run) {
            timelineEl.innerHTML = `
<div class="tw-msg tw-msg-system tw-batch-event">
    <div class="tw-msg-content">현재 페이지 수집을 누르면 배치 작업 이벤트가 여기에 대화처럼 쌓입니다.</div>
</div>`;
            return;
        }

        const logs = run.logs || [];
        if (!logs.length) {
            timelineEl.innerHTML = `
<div class="tw-msg tw-msg-ai tw-batch-event tw-batch-event-info">
    <div class="tw-msg-role">배치 워크플로우</div>
    <div class="tw-msg-content">배치 세션이 준비되었습니다. 아래 프롬프트와 모델을 확인한 뒤 현재 페이지를 수집하세요.</div>
</div>`;
            return;
        }

        timelineEl.innerHTML = logs.map(log => {
            const type = ['success', 'warn', 'error'].includes(log.type) ? log.type : 'info';
            const time = log.at ? new Date(log.at).toLocaleTimeString('ko-KR', { hour12: false }) : '';
            return `
<div class="tw-msg tw-msg-ai tw-batch-event tw-batch-event-${type}">
    <div class="tw-msg-role">배치 이벤트${time ? ` · ${escapeHtml(time)}` : ''}</div>
    <div class="tw-msg-content">${escapeHtml(log.message)}</div>
</div>`;
        }).join('');
        timelineEl.scrollTop = timelineEl.scrollHeight;
    }

    function updateBatchButtons(run) {
        if (!modalEl) return;
        const busy = run ? isBatchBusy(run.status) : false;
        const collectBtn = $('.tw-btn-batch-collect', modalEl);
        const phase12Btn = $('.tw-btn-phase12', modalEl);
        const phase3Btn = $('.tw-btn-phase3', modalEl);
        const phase45Btn = $('.tw-btn-phase45', modalEl);
        const refetchBtn = $('.tw-btn-batch-refetch', modalEl);

        if (collectBtn) collectBtn.disabled = busy;
        if (phase12Btn) phase12Btn.disabled = busy || !run?.segments?.length;
        if (phase3Btn) phase3Btn.disabled = busy || !run?.phase12?.validation?.ok;
        if (phase45Btn) phase45Btn.disabled = busy || !run?.phase3?.validation?.ok;
        if (refetchBtn) refetchBtn.disabled = busy || !run?.storageStringId || !run?.lastExpectedPhase;
    }

    async function onBatchReset() {
        const run = batchRun || restoreActiveBatchRun();
        if (run) {
            const ok = await twConfirm({
                title: '배치 실행 기록 초기화',
                message: '현재 배치 실행 기록(JSON/로그/검증 상태)을 초기화할까요?\n\n이미 TMS 번역 칸에 저장된 storageStringId 결과는 삭제되지 않습니다.',
                danger: true,
            });
            if (!ok) return;
        }
        clearActiveBatchRun();
        toast('배치 실행 기록을 초기화했습니다.', 'success');
    }

    function renderLogOutput() {
        if (!modalEl) return;
        const output = $('.tw-log-output', modalEl);
        if (!output) return;
        const run = batchRun || restoreActiveBatchRun();
        if (!run) {
            output.textContent = '아직 로그가 없습니다.';
            return;
        }

        // v0.6.7 (D1): 레벨 필터/검색 적용
        const logLines = buildFilteredLogLines(run.logs, logView.level, logView.query);
        const jsonBlocks = [];
        if (run.lastError) jsonBlocks.push(`\n\n=== Last error ===\n${run.lastError}`);
        if (run.validations && Object.keys(run.validations).length) {
            jsonBlocks.push(`\n\n=== Validation object ===\n${JSON.stringify(run.validations, null, 2)}`);
        }
        if (run.phase12?.raw) jsonBlocks.push(`\n\n=== Phase 1+2 raw ===\n${run.phase12.raw}`);
        if (run.phase3?.raw) jsonBlocks.push(`\n\n=== Phase 3 raw ===\n${run.phase3.raw}`);
        if (run.phase45?.raw) jsonBlocks.push(`\n\n=== Phase 4+5 raw ===\n${run.phase45.raw}`);
        const totalLogs = (run.logs || []).length;
        const filterTag = (logView.level !== 'all' || logView.query)
            ? `[필터: 레벨=${logView.level}${logView.query ? `, q="${logView.query}"` : ''} → ${logLines.length}/${totalLogs}건]\n\n`
            : '';
        const body = logLines.length ? logLines.join('\n') : (totalLogs ? '(필터 결과 없음)' : '아직 로그가 없습니다.');
        output.textContent = filterTag + body + jsonBlocks.join('');
    }

    async function onCopyLogOutput() {
        if (!modalEl) return;
        const output = $('.tw-log-output', modalEl);
        const text = output?.textContent || '';
        if (!text || text === '아직 로그가 없습니다.') {
            toast('복사할 로그가 없습니다.', 'info');
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            toast(`JSON/로그 전체 복사 완료 (${text.length.toLocaleString()}자)`, 'success');
        } catch (error) {
            derror('log copy 실패', error);
            toast('클립보드 복사 실패: ' + error.message, 'error');
        }
    }

    // v0.6.7 (D1): 로그 레벨/검색/다운로드 핸들러
    function onLogLevelChange(e) { logView.level = (e.target.value || 'all').toLowerCase(); renderLogOutput(); }
    function onLogSearchInput(e) { logView.query = String(e.target.value || ''); renderLogOutput(); }
    function onDownloadLog() {
        const run = batchRun || restoreActiveBatchRun();
        if (!run) { toast('활성 batch run이 없어 다운로드할 로그가 없습니다.', 'info'); return; }
        const lines = buildFilteredLogLines(run.logs, logView.level, logView.query);
        if (!lines.length) { toast('필터 결과가 비어 있어 다운로드할 내용이 없습니다.', 'info'); return; }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const tag = logView.level === 'all' ? 'all' : logView.level;
        downloadTextFile(`tms-${run.runId || 'run'}-log-${tag}-${stamp}.txt`, 'text/plain', lines.join('\n') + '\n');
        toast(`로그 ${lines.length}건 다운로드 시작`, 'success');
    }

    // v0.7.2: 비교 select를 제거하고 history 패널로 일원화—
    // refreshCompareSelect는 이제 컨트롤만(exit 버튼 / override 체크박스 / history 렌더) 갱신
    // v0.7.4: compare 종료/override 포함 컨트롤은 toolbar 외 상단 banner로 이동
    function refreshCompareSelect(currentRun) {
        if (!modalEl) return;
        const banner = $('.tw-compare-banner-bar', modalEl);
        if (banner) banner.classList.toggle('tw-hidden', !reviewView.compareMode);
        const ovrChk = $('.tw-review-compare-overrides', modalEl);
        if (ovrChk) ovrChk.checked = !!reviewView.compareIncludeOverrides;
        // v0.7.2: history 패널이 열려있으면 active/comparing 표시 갱신
        const panel = $('.tw-review-history-panel', modalEl);
        if (panel && !panel.classList.contains('tw-hidden')) renderHistoryPanel();
    }

    // v0.7.2: 비교 select 제거 후에도 남겨둔 프로그래마틱 입구—history 패널의 '비교' 버튼에서 호출
    function onCompareSelectChange(/* legacy */) { /* no-op (kept for backward refs) */ }

    function onExitCompareMode() {
        reviewView.compareMode = false;
        reviewView.compareRunId = null;
        renderReviewTable();
        renderHistoryPanel();
    }

    // v0.6.7 (C2): 비교 표 렌더 — current vs prior run, 같은 project/file/language
    function renderCompareTable(currentRun, summaryEl, tableEl) {
        const runs = lsGet(LS_KEYS.BATCH_RUNS, {}) || {};
        const prior = runs[reviewView.compareRunId];
        if (!prior) {
            summaryEl.classList.remove('tw-review-summary-chips');
            summaryEl.textContent = '비교 대상 run을 찾을 수 없습니다 (삭제되었을 수 있음).';
            tableEl.innerHTML = '';
            return;
        }
        const rows = buildRunCompareRows(currentRun, prior, { includeOverrides: !!reviewView.compareIncludeOverrides });
        const changed = rows.filter(r => !r.sameFinal && !r.onlyInCurrent && !r.onlyInPrior).length;
        const onlyCurrent = rows.filter(r => r.onlyInCurrent).length;
        const onlyPrior = rows.filter(r => r.onlyInPrior).length;
        const overrideTag = reviewView.compareIncludeOverrides
            ? ` · ✏️ override 반영 (현재 ${rows.filter(r => r.currentOverride).length} / 직전 ${rows.filter(r => r.priorOverride).length})`
            : '';
        summaryEl.classList.remove('tw-review-summary-chips');
        summaryEl.textContent = `비교: 현재 run ${currentRun.runId} ↔ 직전 run ${prior.runId} · 총 ${rows.length}개 · 최종 변경 ${changed}개 · 현재만 ${onlyCurrent}개 · 직전만 ${onlyPrior}개${overrideTag}`;
        const head = `<div class="tw-compare-row tw-compare-head">
            <div class="tw-compare-cell">ID</div>
            <div class="tw-compare-cell">원문</div>
            <div class="tw-compare-cell">직전 final</div>
            <div class="tw-compare-cell">현재 final</div>
            <div class="tw-compare-cell">상태</div>
        </div>`;
        const body = rows.map(r => {
            let cls = 'tw-compare-row';
            let status, statusCls;
            if (r.onlyInCurrent) { cls += ' tw-compare-only'; status = '현재만'; statusCls = 'tw-compare-status-only'; }
            else if (r.onlyInPrior) { cls += ' tw-compare-only'; status = '직전만'; statusCls = 'tw-compare-status-only'; }
            else if (r.sameFinal) { status = '동일'; statusCls = 'tw-compare-status-same'; }
            else { cls += ' tw-compare-changed'; status = '변경'; statusCls = 'tw-compare-status-changed'; }
            const diffHtml = (!r.sameFinal && r.priorFinal && r.currentFinal)
                ? renderDiffHtml(diffWords(r.priorFinal, r.currentFinal))
                : escapeHtml(r.currentFinal || '');
            return `<div class="${cls}">
                <div class="tw-compare-cell">#${escapeHtml(r.id)}<div class="tw-muted" style="font-size:10px;margin-top:2px">${escapeHtml(r.gid || '')}</div></div>
                <div class="tw-compare-cell">${escapeHtml(r.src || '')}</div>
                <div class="tw-compare-cell">${escapeHtml(r.priorFinal || '')}</div>
                <div class="tw-compare-cell">${diffHtml}</div>
                <div class="tw-compare-cell"><span class="tw-compare-status ${statusCls}">${status}</span></div>
            </div>`;
        }).join('');
        tableEl.innerHTML = `<div class="tw-compare-banner">⚖ 비교 모드 — 직전 run의 ${reviewView.compareIncludeOverrides ? '실제 적용 결과 (override 포함)' : 'LLM 결과'}와 비교. 종료하려면 우측 상단 ↩ 버튼.</div>
            <div class="tw-compare-table">${head}${body}</div>`;
    }

    // v0.6.7 (C3): 현재 run을 JSON / CSV로 다운로드
    function onExportRunJson() {
        const run = batchRun || restoreActiveBatchRun();
        if (!run) { toast('활성 batch run이 없어 내보낼 데이터가 없습니다.', 'info'); return; }
        const json = buildJsonExportFromRun(run, { includeRaw: false });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadTextFile(`tms-${run.runId || 'run'}-${stamp}.json`, 'application/json', json);
        toast(`JSON 내보내기 완료 (${(json.length / 1024).toFixed(1)} KB)`, 'success');
        appendBatchLog('현재 run을 JSON으로 내보냄', 'info');
    }
    function onExportRunCsv() {
        const run = batchRun || restoreActiveBatchRun();
        if (!run) { toast('활성 batch run이 없어 내보낼 데이터가 없습니다.', 'info'); return; }
        const csv = buildCsvFromRun(run);
        const lineCount = csv.split('\r\n').length - 2; // header + trailing blank
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        // CSV는 Excel/Numbers 호환을 위해 BOM 부착
        downloadTextFile(`tms-${run.runId || 'run'}-${stamp}.csv`, 'text/csv', '\uFEFF' + csv);
        toast(`CSV 내보내기 완료 (${lineCount}행)`, 'success');
        appendBatchLog(`현재 run을 CSV로 내보냄 (${lineCount}행)`, 'info');
    }

    // v0.6.10 E1: override export/import
    function onExportOverrides() {
        const all = loadReviewOverrides() || {};
        const runIds = Object.keys(all);
        const itemCount = runIds.reduce((sum, rid) => sum + Object.keys(all[rid] || {}).length, 0);
        if (!itemCount) { toast('내보낼 직접 수정(override)이 없습니다.', 'info'); return; }
        const payload = {
            schema: 'tms_workflow_review_overrides',
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            scriptVersion: (typeof GM_info !== 'undefined' && GM_info?.script?.version) || null,
            runCount: runIds.length,
            itemCount,
            overrides: all,
        };
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadTextFile(`tms-overrides-${stamp}.json`, 'application/json', JSON.stringify(payload, null, 2));
        toast(`override 내보내기 완료 (run ${runIds.length}, 항목 ${itemCount})`, 'success');
    }
    function onImportOverridesFile(e) {
        const input = e.target;
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const text = String(reader.result || '');
                const parsed = JSON.parse(text);
                // v0.7.0 E1 보강: 다음 3가지 포맷 모두 허용
                //   1) wrapper: { schema, schemaVersion, overrides: {...} }   (v0.6.10 export)
                //   2) raw bucket: { [runId]: { [stringId]: { text, updatedAt } | string } }
                //      (사용자가 localStorage에서 직접 복사한 경우)
                //   3) wrapper에 schemaVersion이 다르면 사용자 확인 후 강행
                let incoming = null;
                let schemaVersion = null;
                if (parsed && typeof parsed === 'object' && parsed.overrides && typeof parsed.overrides === 'object') {
                    incoming = parsed.overrides;
                    schemaVersion = parsed.schemaVersion ?? null;
                } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    // raw bucket: 각 값이 객체이고 그 안의 값이 string 또는 {text} 면 OK
                    const sample = Object.values(parsed)[0];
                    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
                        incoming = parsed;
                    }
                }
                if (!incoming) {
                    toast('파일 형식이 올바르지 않습니다 (overrides 데이터 없음).', 'error');
                    return;
                }
                if (schemaVersion !== null && schemaVersion !== 1) {
                    const okSchema = await twConfirm({
                        title: '알려지지 않은 schemaVersion',
                        message: `이 파일의 schemaVersion=${schemaVersion} 은 알려진 형식이 아닙니다.\n\n그래도 가져오시겠습니까? (호환성은 보장되지 않음)`,
                        danger: true,
                    });
                    if (!okSchema) {
                        return;
                    }
                }
                const runIds = Object.keys(incoming);
                const incomingCount = runIds.reduce((s, rid) => s + Object.keys(incoming[rid] || {}).length, 0);
                if (!incomingCount) { toast('파일에 복원할 항목이 없습니다.', 'info'); return; }

                // 사전 충돌 분석 — 신규/변경/동일을 미리 카운트해서 confirm 메시지에 포함
                const current = loadReviewOverrides() || {};
                let added = 0;
                let changed = 0;
                let same = 0;
                for (const rid of runIds) {
                    const bucket = incoming[rid] || {};
                    const targetExisting = current[rid] || {};
                    for (const sid of Object.keys(bucket)) {
                        const v = bucket[sid];
                        const incomingText = typeof v === 'string'
                            ? v
                            : (v && typeof v === 'object' && typeof v.text === 'string' ? v.text : null);
                        if (incomingText === null) continue;
                        const existing = targetExisting[sid];
                        const existingText = typeof existing === 'string'
                            ? existing
                            : (existing && typeof existing === 'object' ? existing.text : null);
                        if (existing == null) added += 1;
                        else if (existingText === incomingText) same += 1;
                        else changed += 1;
                    }
                }
                const detail = `신규 ${added} · 변경 ${changed} · 동일 ${same}`;
                const okImport = await twConfirm({
                    title: 'override 가져오기',
                    message: `파일: run ${runIds.length}개 / 항목 ${incomingCount}개\n비교: ${detail}\n\n진행하면 변경된 항목은 파일 값으로 덮어쓰기 됩니다.`,
                    confirmLabel: '진행',
                    cancelLabel: '중단',
                });
                if (!okImport) {
                    return;
                }

                let appliedAdded = 0;
                let appliedChanged = 0;
                for (const rid of runIds) {
                    const bucket = incoming[rid] || {};
                    const target = current[rid] || (current[rid] = {});
                    for (const sid of Object.keys(bucket)) {
                        const v = bucket[sid];
                        const norm = typeof v === 'string'
                            ? { text: v, updatedAt: Date.now() }
                            : (v && typeof v === 'object' && typeof v.text === 'string'
                                ? { text: v.text, updatedAt: v.updatedAt || Date.now() }
                                : null);
                        if (!norm) continue;
                        const existing = target[sid];
                        const existingText = typeof existing === 'string'
                            ? existing
                            : (existing && typeof existing === 'object' ? existing.text : null);
                        if (existing == null) appliedAdded += 1;
                        else if (existingText !== norm.text) appliedChanged += 1;
                        target[sid] = norm;
                    }
                }
                saveReviewOverrides(current);
                toast(`override 가져오기 완료 — 신규 ${appliedAdded} / 덮어쓰기 ${appliedChanged} / 동일 ${same}`, 'success');
                appendBatchLog(`override 가져오기 (신규 ${appliedAdded}, 덮어쓰기 ${appliedChanged}, 동일 ${same}, schemaVersion=${schemaVersion ?? 'raw'})`, 'info');
                renderReviewTable();
            } catch (err) {
                derror('override import 실패:', err);
                toast('가져오기 실패: ' + err.message, 'error');
            } finally {
                input.value = '';
            }
        };
        reader.onerror = () => {
            toast('파일을 읽지 못했습니다.', 'error');
            input.value = '';
        };
        reader.readAsText(file);
    }

    // v0.7.0 G1-c: history 패널 — 이 파일의 과거 batch run을 나열하고
    // 활성 전환 / 삭제할 수 있게 함. compare-select와 달리 현재 활성 run도 포함.
    function onToggleHistory() {
        const panel = $('.tw-review-history-panel', modalEl);
        if (!panel) return;
        // v0.7.1: 토글을 먼저 적용한 뒤 렌더링해야 함.
        // (renderHistoryPanel은 panel이 hidden이면 early-return하므로 순서가 중요)
        panel.classList.toggle('tw-hidden');
        if (!panel.classList.contains('tw-hidden')) renderHistoryPanel();
    }
    function renderHistoryPanel() {
        const panel = $('.tw-review-history-panel', modalEl);
        if (!panel || panel.classList.contains('tw-hidden')) return;
        // v0.7.4: 동적 리스트는 .tw-history-list에만 쓰고 패널 헤더는 보존 (이벤트 핸들러 유지)
        const listEl = $('.tw-history-list', panel);
        if (!listEl) return;
        const runs = loadBatchRuns();
        const params = getUrlParams();
        const sameFile = Object.values(runs)
            .filter(r => r && r.runId &&
                String(r.projectId) === String(params.projectId || '') &&
                String(r.fileId) === String(params.fileId || '') &&
                String(r.languageId) === String(params.languageId || ''))
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        if (!sameFile.length) {
            listEl.innerHTML = '<div class="tw-history-empty">이 파일에는 저장된 run 기록이 없습니다.</div>';
            return;
        }
        const activeId = getActiveBatchRunId();
        const compareId = reviewView.compareMode ? reviewView.compareRunId : null;
        const head = `<div class="tw-history-row tw-history-head">
    <div>업데이트</div><div>이름 / Run ID</div><div>상태</div><div>항목</div><div>동작</div>
</div>`;
        const body = sameFile.map(r => {
            const stamp = (r.updatedAt || r.createdAt || '').slice(0, 19).replace('T', ' ');
            const itemCount = r.phase3?.parsed?.translations?.length || 0;
            const statusLabel = (typeof BATCH_STATUS_LABELS === 'object' && BATCH_STATUS_LABELS[r.status]) || r.status || '-';
            const isActive = r.runId === activeId;
            const isComparing = compareId && r.runId === compareId;
            const displayName = r.label || r.runId;
            const badges = [];
            if (isActive) badges.push('<span class="tw-history-badge">현재</span>');
            if (isComparing) badges.push('<span class="tw-history-badge tw-history-badge-compare">비교 중</span>');
            // v0.7.2: 비교 버튼은 활성/현재 비교 중 row에서는 숨김
            const compareBtn = (!isActive && !isComparing)
                ? `<button class="tw-btn tw-btn-ghost tw-btn-history-compare" data-run-id="${escapeHtml(r.runId)}" title="이 run을 활성 run과 비교 (LLM 결과 drift)">↔ 비교</button>`
                : (isComparing ? `<button class="tw-btn tw-btn-ghost tw-btn-history-compare-exit" title="비교 종료">⨯ 비교 종료</button>` : '');
            const activateBtn = isActive
                ? ''
                : `<button class="tw-btn tw-btn-ghost tw-btn-history-activate" data-run-id="${escapeHtml(r.runId)}" title="이 run을 활성으로 전환 (이후 review/log/compare가 이 run 기준이 됨)">✓ 활성화</button>`;
            const renameBtn = `<button class="tw-btn tw-btn-ghost tw-btn-history-rename" data-run-id="${escapeHtml(r.runId)}" title="이 run에 라벨 지정 / 변경 (runId는 유지)">✏ 이름</button>`;
            const deleteBtn = `<button class="tw-btn tw-btn-ghost tw-btn-history-delete" data-run-id="${escapeHtml(r.runId)}" title="이 run 삭제 (override는 별도 키이므로 보존됨)">🗑 삭제</button>`;
            const rowCls = (isActive ? ' tw-history-active' : '') + (isComparing ? ' tw-history-comparing' : '');
            return `<div class="tw-history-row${rowCls}">
    <div title="${escapeHtml(r.createdAt || '')}">${escapeHtml(stamp || '-')}</div>
    <div class="tw-history-name">
        <span class="tw-history-name-text" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}${badges.join('')}</span>
        ${r.label ? `<span class="tw-history-runid" title="${escapeHtml(r.runId)}">${escapeHtml(r.runId)}</span>` : ''}
    </div>
    <div class="tw-history-status" title="${escapeHtml(statusLabel)}">${escapeHtml(statusLabel)}</div>
    <div>${itemCount}</div>
    <div class="tw-history-actions">${activateBtn}${compareBtn}${renameBtn}${deleteBtn}</div>
</div>`;
        }).join('');
        listEl.innerHTML = head + body;
    }
    function onActivateRun(runId) {
        if (!runId) return;
        const runs = loadBatchRuns();
        if (!runs[runId]) { toast('run을 찾을 수 없습니다.', 'error'); return; }
        // v0.7.2: 새로 활성화하는 run을 비교 대상으로 두면 안 되므로 자기 비교 충돌 시 비교 종료
        if (reviewView.compareMode && reviewView.compareRunId === runId) {
            reviewView.compareMode = false;
            reviewView.compareRunId = null;
        }
        setActiveBatchRunId(runId);
        syncBatchRunFromLs();
        renderBatchRun();
        renderHistoryPanel();
        toast(`run ${runId} 활성화`, 'success');
    }
    async function onDeleteRun(runId) {
        if (!runId) return;
        const isActive = runId === getActiveBatchRunId();
        const msg = (isActive ? '⚠ 현재 활성 run을 삭제합니다.\n\n' : '')
            + `run을 삭제합니다.\n\n${runId}\n\n계속하시겠습니까?`;
        const ok = await twConfirm({ title: 'run 삭제', message: msg, danger: true });
        if (!ok) return;
        const runs = loadBatchRuns();
        delete runs[runId];
        saveBatchRuns(runs);
        // v0.7.8 (#4): dangling 정리 — 이 run을 importedFromRunId로 가진 SESSIONS 항목에서 nullify
        try {
            const danglingCount = nullifyDanglingImportedFromRunId(runId);
            if (danglingCount > 0) dverbose(`run ${runId} 삭제: dangling importedFromRunId ${danglingCount}건 nullify`);
        } catch (e) { dwarn('dangling importedFromRunId nullify 실패', e); }
        if (isActive) {
            lsSet(LS_KEYS.ACTIVE_BATCH_RUN, null);
            batchRun = null;
            renderBatchRun();
        }
        // v0.7.2: 비교 대상이 삭제되면 비교 모드 종료
        if (reviewView.compareMode && reviewView.compareRunId === runId) {
            reviewView.compareMode = false;
            reviewView.compareRunId = null;
            renderBatchRun();
        }
        renderHistoryPanel();
        toast(`run ${runId} 삭제됨`, 'success');
    }
    // v0.7.2: 라벨 변경 — runId는 유지하고 사용자 친화적 이름만 추가/수정
    function onRenameRun(runId) {
        if (!runId) return;
        const runs = loadBatchRuns();
        const run = runs[runId];
        if (!run) { toast('run을 찾을 수 없습니다.', 'error'); return; }
        const current = run.label || '';
        const next = prompt(`라벨 입력 (빈 값 + 확인 → 라벨 제거)\n\nrunId: ${runId}`, current);
        if (next === null) return; // cancel
        const trimmed = String(next || '').trim().slice(0, 80);
        if (trimmed) run.label = trimmed; else delete run.label;
        run.updatedAt = run.updatedAt || new Date().toISOString();
        runs[runId] = run;
        saveBatchRuns(runs);
        // 활성 run이면 메모리 사본도 동기화
        if (batchRun && batchRun.runId === runId) {
            if (trimmed) batchRun.label = trimmed; else delete batchRun.label;
            renderBatchRun();
        }
        renderHistoryPanel();
        toast(trimmed ? `라벨 변경: "${trimmed}"` : '라벨 제거됨', 'success');
    }
    // v0.7.2: history 패널의 '비교' 버튼 — 활성 run과 비교 모드 진입
    function onCompareWithRun(runId) {
        if (!runId) return;
        const activeId = getActiveBatchRunId();
        if (!activeId) { toast('활성 run이 없어 비교할 수 없습니다.', 'warn'); return; }
        if (runId === activeId) { toast('활성 run은 자신과 비교할 수 없습니다.', 'warn'); return; }
        const runs = loadBatchRuns();
        if (!runs[runId]) { toast('run을 찾을 수 없습니다.', 'error'); return; }
        reviewView.compareMode = true;
        reviewView.compareRunId = runId;
        renderReviewTable();
        renderHistoryPanel();
        toast(`${runs[runId].label || runId} 와 비교 시작`, 'info');
    }
    function getBatchFinalText(id) {
        const run = batchRun || restoreActiveBatchRun();
        if (!run?.phase3?.parsed || !run.phase3.validation?.ok) return '';
        // v0.6.2: 사용자 인라인 수정 override 우선
        const override = getReviewOverride(run.runId, id);
        if (typeof override === 'string') return override;
        const phase3 = (run.phase3.parsed.translations || []).find(item => normalizeId(item.id) === normalizeId(id));
        const revision = run.phase45?.validation?.ok
            ? (run.phase45?.parsed?.revisions || []).find(item => normalizeId(item.id) === normalizeId(id))
            : null;
        if (!phase3) return '';
        return revision && revision.t !== null ? String(revision.t || '') : String(phase3.t || '');
    }

    // v0.6.2: 최종 후보 직접 수정 — v0.7.6 (#5) 부터는 인라인 textarea 대신 모달로 전환.
    //  - 좌측: 원문 / Phase3 / Phase4+5 (read-only)
    //  - 우측: 최종 후보 textarea (편집)
    // 단축키: Ctrl/Cmd+Enter 저장, Esc 취소
    function openInlineFinalEditor(stringId) {
        return openFinalEditModal(stringId);
    }

    function openFinalEditModal(stringId) {
        const id = normalizeId(stringId);
        if (!id) return;
        const run = batchRun || restoreActiveBatchRun();
        if (!run?.runId) { toast('활성 batch run이 없어 편집할 수 없습니다.', 'error'); return; }
        // 동시에 두 개 띄우지 않음
        const existing = document.querySelector('.tw-final-edit-overlay');
        if (existing) existing.remove();

        const seg = (run.segments || []).find(s => normalizeId(s.id) === id);
        const phase3 = (run.phase3?.parsed?.translations || []).find(it => normalizeId(it.id) === id);
        const revision = run.phase45?.validation?.ok
            ? (run.phase45?.parsed?.revisions || []).find(it => normalizeId(it.id) === id)
            : null;
        const sourceText = String(seg?.origin_string || '');
        const phase3Text = String(phase3?.t || '');
        const phase45Text = revision && revision.t !== null ? String(revision.t || '') : '';
        const currentFinal = getBatchFinalText(id);
        const charLimit = Number(seg?.char_limit || 0) || 0;

        const overlay = document.createElement('div');
        overlay.className = 'tw-final-edit-overlay';
        overlay.innerHTML = `
<div class="tw-final-edit-dialog" role="dialog" aria-modal="true" aria-label="최종 후보 편집">
    <div class="tw-final-edit-header">
        <span class="tw-final-edit-title">✏ 최종 후보 편집 — #${escapeHtml(id)}${charLimit ? ` <span class="tw-final-edit-meta">(char_limit: ${charLimit})</span>` : ''}</span>
        <button type="button" class="tw-final-edit-close" title="닫기 (Esc)">✕</button>
    </div>
    <div class="tw-final-edit-body">
        <div class="tw-final-edit-col">
            <div class="tw-final-edit-section">
                <span class="tw-final-edit-section-label">원문 (source)</span>
                <div class="tw-final-edit-section-body${sourceText ? '' : ' tw-empty'}">${sourceText ? escapeHtml(sourceText) : '(없음)'}</div>
            </div>
            <div class="tw-final-edit-section">
                <span class="tw-final-edit-section-label">Phase 3 결과</span>
                <div class="tw-final-edit-section-body${phase3Text ? '' : ' tw-empty'}">${phase3Text ? escapeHtml(phase3Text) : '(없음)'}</div>
            </div>
            <div class="tw-final-edit-section">
                <span class="tw-final-edit-section-label">Phase 4+5 수정</span>
                <div class="tw-final-edit-section-body${phase45Text ? '' : ' tw-empty'}">${phase45Text ? escapeHtml(phase45Text) : '(수정 없음 / Phase4+5 미실행)'}</div>
            </div>
        </div>
        <div class="tw-final-edit-col">
            <div class="tw-final-edit-section" style="flex: 1 1 auto;">
                <span class="tw-final-edit-section-label">최종 후보 (편집)</span>
                <textarea class="tw-final-edit-textarea" data-id="${escapeHtml(id)}">${escapeHtml(currentFinal)}</textarea>
                <span class="tw-final-edit-meta tw-final-edit-counter">길이: ${currentFinal.length}자${charLimit ? ` / ${charLimit}` : ''}</span>
            </div>
        </div>
    </div>
    <div class="tw-final-edit-footer">
        <button type="button" class="tw-btn tw-btn-ghost tw-final-edit-cancel">취소</button>
        <button type="button" class="tw-btn tw-btn-primary tw-final-edit-save">💾 저장 (Ctrl+Enter)</button>
    </div>
</div>`;
        document.body.appendChild(overlay);

        const dialog = overlay.querySelector('.tw-final-edit-dialog');
        const ta = overlay.querySelector('.tw-final-edit-textarea');
        const counter = overlay.querySelector('.tw-final-edit-counter');
        const close = () => { overlay.remove(); };
        const updateCounter = () => {
            if (!counter || !ta) return;
            const len = ta.value.length;
            counter.textContent = `길이: ${len}자${charLimit ? ` / ${charLimit}` : ''}`;
            counter.style.color = (charLimit && len > charLimit) ? '#f87171' : '';
        };
        const save = () => {
            commitFinalEditModal(id, ta ? ta.value : '');
            close();
        };
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
        overlay.querySelector('.tw-final-edit-close').addEventListener('click', close);
        overlay.querySelector('.tw-final-edit-cancel').addEventListener('click', close);
        overlay.querySelector('.tw-final-edit-save').addEventListener('click', save);
        if (ta) {
            ta.addEventListener('input', updateCounter);
            ta.addEventListener('keydown', (ev) => {
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); save(); }
                else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
            });
            // 모달 외부에서도 Esc로 닫히도록
            dialog.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape') { ev.preventDefault(); close(); }
            });
            // 포커스 + 커서 끝
            setTimeout(() => {
                ta.focus();
                try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
            }, 0);
        }
    }

    function commitFinalEditModal(stringId, newText) {
        const id = normalizeId(stringId);
        const run = batchRun || restoreActiveBatchRun();
        if (!run?.runId) {
            toast('활성 batch run이 없어 저장할 수 없습니다.', 'error');
            return;
        }
        const text = String(newText == null ? '' : newText);
        const phase3 = (run.phase3?.parsed?.translations || []).find(it => normalizeId(it.id) === id);
        const revision = run.phase45?.validation?.ok
            ? (run.phase45?.parsed?.revisions || []).find(it => normalizeId(it.id) === id)
            : null;
        const original = revision && revision.t !== null ? String(revision.t || '') : String(phase3?.t || '');
        const override = getReviewOverride(run.runId, id);
        if (text === original) {
            if (override !== null) clearReviewOverride(run.runId, id);
            appendBatchLog(`#${id} 직접 수정이 원본과 같아 override 제거`, 'info');
        } else {
            setReviewOverride(run.runId, id, text);
            appendBatchLog(`#${id} 직접 수정 저장 (${text.length}자)`, 'success');
        }
        renderReviewTable();
    }

    // 구버전 호환 — 직접 호출되는 일은 없지만 export 등 외부 참조 안전망
    function _legacy_openInlineFinalEditor_INLINE(stringId) {
        if (!modalEl) return;
        const id = normalizeId(stringId);
        const wrap = modalEl.querySelector(`.tw-review-final-wrap[data-final-id="${CSS.escape(String(id))}"]`);
        if (!wrap) return;
        const current = getBatchFinalText(id);
        wrap.innerHTML = `
<div class="tw-review-final-edit">
    <textarea class="tw-review-final-textarea" data-id="${escapeHtml(id)}">${escapeHtml(current)}</textarea>
    <div class="tw-review-edit-buttons">
        <button class="tw-btn tw-btn-primary tw-btn-edit-save" data-id="${escapeHtml(id)}">저장</button>
        <button class="tw-btn tw-btn-ghost tw-btn-edit-cancel" data-id="${escapeHtml(id)}">취소</button>
    </div>
</div>`;
        const ta = wrap.querySelector('textarea');
        if (ta) {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
            // Ctrl/Cmd+Enter 저장, Esc 취소 단축키
            ta.addEventListener('keydown', (ev) => {
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                    ev.preventDefault();
                    commitInlineFinalEditor(id);
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    renderReviewTable();
                }
            });
        }
    }

    function commitInlineFinalEditor(stringId) {
        if (!modalEl) return;
        const id = normalizeId(stringId);
        const ta = modalEl.querySelector(`.tw-review-final-textarea[data-id="${CSS.escape(String(id))}"]`);
        if (!ta) return;
        const run = batchRun || restoreActiveBatchRun();
        if (!run?.runId) {
            toast('활성 batch run이 없어 저장할 수 없습니다.', 'error');
            return;
        }
        const newText = ta.value;
        // 배치 원본과 동일하면 override 제거 (의미 없는 빈 override 누적 방지)
        const override = getReviewOverride(run.runId, id);
        // 원본 텍스트 (override 무시 버전) 계산
        const phase3 = (run.phase3?.parsed?.translations || []).find(it => normalizeId(it.id) === id);
        const revision = run.phase45?.validation?.ok
            ? (run.phase45?.parsed?.revisions || []).find(it => normalizeId(it.id) === id)
            : null;
        const original = revision && revision.t !== null ? String(revision.t || '') : String(phase3?.t || '');
        if (newText === original) {
            if (override !== null) clearReviewOverride(run.runId, id);
            appendBatchLog(`#${id} 직접 수정이 원본과 같아 override 제거`, 'info');
        } else {
            setReviewOverride(run.runId, id, newText);
            appendBatchLog(`#${id} 직접 수정 저장 (${newText.length}자)`, 'success');
        }
        renderReviewTable();
    }

    function getReviewTranslationIds() {
        const run = batchRun || restoreActiveBatchRun();
        if (!run?.phase3?.parsed || !run.phase3.validation?.ok) return [];
        return (run.phase3.parsed.translations || []).map(item => normalizeId(item.id));
    }

    function getSelectedReviewIds() {
        if (!modalEl) return [];
        return $$('.tw-review-select:checked', modalEl)
            .map(input => normalizeId(input.dataset.id))
            .filter(id => Number.isFinite(Number(id)));
    }

    // v0.6.5 (A1): Phase 4+5에서 실제 수정이 일어났거나 직접 수정된 ID만 (no-op 유지는 제외)
    function getEditedReviewIds() {
        const run = batchRun || restoreActiveBatchRun();
        if (!run?.phase3?.parsed || !run.phase3.validation?.ok) return [];
        const phase3Map = new Map((run.phase3.parsed.translations || []).map(it => [normalizeId(it.id), it]));
        const revisionMap = new Map(((run.phase45?.parsed?.revisions) || []).map(it => [normalizeId(it.id), it]));
        const ids = [];
        for (const [id, p3] of phase3Map) {
            if (typeof getReviewOverride(run.runId, id) === 'string') { ids.push(id); continue; }
            const rev = revisionMap.get(id);
            if (rev && typeof rev.t === 'string' && rev.t !== p3.t) ids.push(id);
        }
        return ids;
    }

    // v0.6.5 (A4): 단어 단위 diff (Korean/CJK 안전 — 공백/문장부호 분할 LCS)
    function tokenizeForDiff(text) {
        return String(text || '').split(/(\s+|[.,!?…·\-\/()\[\]{}'"`~:;])/).filter(t => t.length > 0);
    }
    function diffWords(oldText, newText) {
        const a = tokenizeForDiff(oldText);
        const b = tokenizeForDiff(newText);
        const n = a.length, m = b.length;
        // LCS DP
        const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
        for (let i = n - 1; i >= 0; i -= 1) {
            for (let j = m - 1; j >= 0; j -= 1) {
                dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        const ops = []; // {type:'eq'|'add'|'del', text}
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (a[i] === b[j]) { ops.push({ type: 'eq', text: a[i] }); i += 1; j += 1; }
            else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i += 1; }
            else { ops.push({ type: 'add', text: b[j] }); j += 1; }
        }
        while (i < n) { ops.push({ type: 'del', text: a[i] }); i += 1; }
        while (j < m) { ops.push({ type: 'add', text: b[j] }); j += 1; }
        // 인접한 같은 type 병합
        const merged = [];
        for (const op of ops) {
            const last = merged[merged.length - 1];
            if (last && last.type === op.type) last.text += op.text;
            else merged.push({ ...op });
        }
        return merged;
    }
    function renderDiffHtml(ops) {
        return ops.map(op => {
            if (op.type === 'eq') return escapeHtml(op.text);
            if (op.type === 'add') return `<span class="tw-diff-add">${escapeHtml(op.text)}</span>`;
            return `<span class="tw-diff-del">${escapeHtml(op.text)}</span>`;
        }).join('');
    }

    async function applyBatchFinalToTextarea(id) {
        const text = getBatchFinalText(id);
        if (!text) throw new Error(`#${id} 최종 후보가 없습니다.`);

        const item = findStringItemByStringId(id);
        if (!item) {
            throw new Error(`#${id} 세그먼트가 현재 화면 DOM에 없습니다. 해당 세그먼트가 보이도록 스크롤한 뒤 다시 시도하세요.`);
        }

        item.scrollIntoView({ block: 'center', behavior: 'smooth' });
        item.click();
        await sleep(120);

        const textarea = findTranslationTextareaForStringId(id);
        if (!textarea) {
            throw new Error(`#${id} 번역 textarea를 찾지 못했습니다. 세그먼트를 펼친 뒤 다시 시도하세요.`);
        }

        injectTextareaValue(textarea, text);
        // v0.6.0 L3: 적용 성공 기록 (drift 감지 용)
        try {
            const run = batchRun || restoreActiveBatchRun();
            if (run?.runId) {
                const phase = run.phase45?.validation?.ok ? 'phase45' : 'phase3';
                recordAppliedFromBatch(id, run.runId, phase, text);
            }
        } catch (err) {
            dwarn('applied-from-batch 기록 실패', err);
        }
        return { id, ok: true };
    }

    async function applyBatchTranslationsByIds(ids) {
        const uniqueIds = Array.from(new Set((ids || []).map(normalizeId)));
        if (!uniqueIds.length) {
            toast('입력할 세그먼트를 선택하세요.', 'error');
            updateReviewApplyStatus('선택된 항목이 없습니다.');
            return;
        }

        let success = 0;
        const failures = [];
        const total = uniqueIds.length;
        updateReviewApplyStatus(`${total}개 입력 시작...`);
        // v0.6.5 (A1): 일괄 입력 시작 토스트 (1개일 때는 생략)
        if (total > 1) toast(`${total}개 일괄 입력을 시작합니다.`, 'info', 2500);

        for (let i = 0; i < uniqueIds.length; i += 1) {
            const id = uniqueIds[i];
            try {
                await applyBatchFinalToTextarea(id);
                success += 1;
                appendBatchLog(`#${id} textarea 입력 완료`, 'success');
            } catch (error) {
                failures.push({ id, message: error.message });
                appendBatchLog(`#${id} textarea 입력 실패: ${error.message}`, 'warn');
            }
            // 5개마다 또는 마지막에 진행 상태 갱신 (UI 업데이트 비용 절감)
            if ((i + 1) % 5 === 0 || i === uniqueIds.length - 1) {
                updateReviewApplyStatus(`진행 ${i + 1}/${total} · 성공 ${success} · 실패 ${failures.length}`);
            }
        }

        let message = failures.length
            ? `입력 완료 ${success}개, 실패 ${failures.length}개`
            : `입력 완료 ${success}개`;
        if (failures.length) {
            const previewIds = failures.slice(0, 5).map(f => `#${f.id}`).join(', ');
            const more = failures.length > 5 ? ` 외 ${failures.length - 5}개` : '';
            message += ` (실패: ${previewIds}${more})`;
        }
        updateReviewApplyStatus(message);
        toast(message, failures.length ? 'info' : 'success', 4500);
        // v0.6.8 (A1): 실패 ID를 reviewView에 보존하고 칩 영역을 갱신
        reviewView.lastFailedIds = failures.map(f => normalizeId(f.id));
        if (!reviewView.lastFailedIds.length) reviewView.showOnlyFailed = false;
        // v0.6.5: 입력 후 applied 배지/필터 갱신
        if (success > 0 || failures.length > 0) renderReviewTable();
    }

    // v0.6.6 (B1): 고아 override 정리 클릭 핸들러
    async function onReviewOverrideGc() {
        const all = loadReviewOverrides();
        const totalRuns = Object.keys(all).length;
        const totalItems = Object.values(all).reduce((sum, b) => sum + Object.keys(b || {}).length, 0);
        if (!totalItems) { toast('정리할 직접 수정 데이터가 없습니다.', 'info'); return; }
        const knownRuns = lsGet(LS_KEYS.BATCH_RUNS, {}) || {};
        const activeRunId = lsGet(LS_KEYS.ACTIVE_BATCH_RUN, null);
        const orphanRunIds = Object.keys(all).filter(rid => !knownRuns[rid] && rid !== activeRunId);
        const orphanItems = orphanRunIds.reduce((sum, rid) => sum + Object.keys(all[rid] || {}).length, 0);

        let prunedActive = 0;
        if (activeRunId && all[activeRunId]) {
            const phase3Ids = new Set((knownRuns[activeRunId]?.phase3?.parsed?.translations || []).map(it => normalizeId(it.id)));
            if (phase3Ids.size) {
                for (const itemId of Object.keys(all[activeRunId])) {
                    if (!phase3Ids.has(normalizeId(itemId))) prunedActive += 1;
                }
            }
        }
        const removableItems = orphanItems + prunedActive;
        if (!removableItems) {
            toast(`정리할 고아 데이터가 없습니다. (전체 ${totalItems}개, run ${totalRuns}개 모두 활성/알려진 run 안에 있음)`, 'info', 3500);
            return;
        }
        const msg = `- 알려지지 않은 run: ${orphanRunIds.length}개 (항목 ${orphanItems}개)\n` +
            (prunedActive ? `- 활성 run 내 phase3에 없는 항목: ${prunedActive}개\n` : '') +
            `\n총 ${removableItems}개 항목을 삭제합니다. 진행하시겠습니까?`;
        const ok = await twConfirm({ title: '직접 수정 데이터 정리', message: msg, danger: true });
        if (!ok) return;
        const result = gcOrphanReviewOverrides();
        const after = loadReviewOverrides();
        const remaining = Object.values(after).reduce((sum, b) => sum + Object.keys(b || {}).length, 0);
        appendBatchLog(`override GC: run ${result.removedRunIds.length}개, 항목 ${result.totalItemsRemoved}개 삭제, 남음 ${remaining}개`, 'info');
        toast(`정리 완료 — ${result.totalItemsRemoved}개 삭제, 남음 ${remaining}개`, 'success', 3500);
        renderReviewTable();
    }

    // v0.6.0 L2: review 행 → chat 탭 점프 (단일 세그먼트 다듬기 모드)
    async function onChatRefineFromReview(stringId) {
        const id = normalizeId(stringId);
        const run = batchRun || restoreActiveBatchRun();
        if (!run) { toast('활성 배치 실행이 없습니다.', 'error'); return; }
        if (!getBatchFinalText(id)) { toast(`#${id} 적용 가능한 배치 결과가 없습니다.`, 'error'); return; }

        // 페이지 DOM에 없으면 조용히 중단 (P1: segmentWatcher가 currentStringId를 되돌려서 채팅이 틀어지는 혀난함 방지)
        const item = findStringItemByStringId(id);
        if (!item) {
            toast(`#${id} 세그먼트가 현재 페이지 DOM에 없습니다. 해당 세그먼트가 보이도록 스크롤/클릭한 뒤 다시 시도하세요.`, 'error', 4000);
            return;
        }
        item.scrollIntoView({ block: 'center', behavior: 'smooth' });
        item.click();
        await sleep(120);

        // 기존 chat 메시지가 있으면 덮어쓰기 confirm
        const existing = getSession(id);
        if (existing.messages && existing.messages.length > 0) {
            const ok = await twConfirm({
                title: '기존 chat 메시지 덮어쓰기',
                message: `#${id}에 이미 ${existing.messages.length}개의 chat 메시지가 있습니다.\n배치 결과로 새로 시드하면 기존 대화는 사라집니다. 계속하시겠습니까?`,
                danger: true,
            });
            if (!ok) return;
        }

        try {
            importBatchResultToChat(id, run);
        } catch (err) {
            toast(`시드 실패: ${err.message}`, 'error');
            return;
        }

        currentStringId = id;
        try { await loadSegmentInfo(id); } catch (err) { dwarn('loadSegmentInfo 실패', err); }
        setMainTab('chat');
        renderChatHistory();
        appendBatchLog(`#${id} chat 다듬기 모드로 시드됨`, 'info');
        toast(`#${id} chat 다듬기 모드로 전환됨`, 'success');
    }

    function renderReviewTable() {
        if (!modalEl) return;
        // v0.6.10 F1: 렌더 시작 시각 기록 (대량 run 감시용)
        renderReviewTable._t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const summaryEl = $('.tw-review-summary', modalEl);
        const tableEl = $('.tw-review-table', modalEl);
        if (!summaryEl || !tableEl) return;
        const run = batchRun || restoreActiveBatchRun();

        // v0.6.7 (C2): 비교 select 옵션 갱신 (run 변경/재렌더 시 동기화)
        refreshCompareSelect(run);
        // v0.6.8 (A1): 일괄 입력 실패 ID 칩/토글 갱신
        refreshFailedChips();

        if (!run?.phase3?.parsed) {
            summaryEl.classList.remove('tw-review-summary-chips');
            summaryEl.textContent = '아직 Phase 3 결과가 없습니다.';
            tableEl.innerHTML = '';
            return;
        }
        if (!run.phase3.validation?.ok) {
            summaryEl.classList.remove('tw-review-summary-chips');
            summaryEl.textContent = 'Phase 3 검증이 실패해 결과 검토를 표시하지 않습니다. JSON/로그 탭에서 세부 오류를 확인하세요.';
            tableEl.innerHTML = '';
            return;
        }

        // v0.6.7 (C2): 비교 모드 — 검토 표 자리에 비교 표를 렌더하고 종료
        if (reviewView.compareMode && reviewView.compareRunId) {
            renderCompareTable(run, summaryEl, tableEl);
            return;
        }

        const translations = run.phase3.parsed.translations || [];
        const usePhase45 = !!run.phase45?.validation?.ok;
        const revisions = usePhase45 ? (run.phase45?.parsed?.revisions || []) : [];
        const revisionById = new Map(revisions.map(item => [normalizeId(item.id), item]));
        const segmentById = new Map((run.segments || []).map(seg => [normalizeId(seg.id), seg]));
        const changedCount = revisions.filter(item => item.t !== null).length;

        // v0.6.1 P3: applied 기록 집계 (현 run에 속한 것만)
        let appliedCount = 0;
        let driftedCount = 0;
        let unknownCount = 0;
        for (const tr of translations) {
            const id = normalizeId(tr.id);
            const a = getAppliedFromBatch(id);
            if (!a || (run.runId && a.runId && a.runId !== run.runId)) continue;
            appliedCount += 1;
            const ta = findTranslationTextareaForStringId(id);
            if (ta) {
                if (ta.value !== a.text) driftedCount += 1;
            } else {
                const seg = segmentById.get(id);
                const cur = seg?.active_result?.result;
                if (typeof cur === 'string') {
                    if (cur !== a.text) driftedCount += 1;
                } else {
                    unknownCount += 1;
                }
            }
        }
        const appliedSummary = appliedCount
            ? `자동 적용 ${appliedCount}개 (수정 ${driftedCount}, 확인 불가 ${unknownCount})`
            : '자동 적용 없음';

        // v0.6.5 (A3): 필터/정렬 컨트롤 동기화 + 분류 메타 사전 계산
        const filterSel = $('.tw-review-filter', modalEl);
        const sortSel = $('.tw-review-sort', modalEl);
        if (filterSel && filterSel.value !== reviewView.filter) filterSel.value = reviewView.filter;
        if (sortSel && sortSel.value !== reviewView.sort) sortSel.value = reviewView.sort;

        // phase45 validation에서 placeholder/hanja 분류 가져오기
        const phase45Validation = run.phase45?.validation || {};
        const missingPlaceholderIds = new Set((phase45Validation.missingPlaceholders || []).map(item => normalizeId(item.id)));
        const hanjaIds = new Set((phase45Validation.hanjaLike || []).map(id => normalizeId(id)));
        // v0.6.6 (B3): warn-only 분류 (phase45 우선, 없으면 phase3로 폴백)
        const warnSource = (phase45Validation.warnings ? phase45Validation : (run.phase3?.validation || {})).warnings || {};
        const warnCharLimitIds = new Set((warnSource.charLimitOver || []).map(w => normalizeId(w.id)));
        const warnOrderIds = new Set((warnSource.placeholderOrderMismatch || []).map(w => normalizeId(w.id)));
        const warnTbIds = new Set((warnSource.tbTermsMissed || []).map(w => normalizeId(w.id)));

        const stateOrder = { override: 0, edit: 1, keep: 2, none: 3 };
        const descriptors = translations.map(item => {
            const id = normalizeId(item.id);
            const revision = revisionById.get(id);
            const isEffectiveKeep = revision && (revision.t === null || (typeof revision.t === 'string' && revision.t === item.t));
            const hasOverride = typeof getReviewOverride(run.runId, id) === 'string';
            let stateKey; // 'override' | 'edit' | 'keep' | 'none'
            if (hasOverride) stateKey = 'override';
            else if (revision && !isEffectiveKeep) stateKey = 'edit';
            else if (revision && isEffectiveKeep) stateKey = 'keep';
            else stateKey = 'none';
            const applied = getAppliedFromBatch(id);
            const appliedActive = !!(applied && (!run.runId || !applied.runId || applied.runId === run.runId));
            let appliedState = 'none';
            if (appliedActive) {
                const ta = findTranslationTextareaForStringId(id);
                if (ta) appliedState = ta.value === applied.text ? 'ok' : 'drifted';
                else {
                    const seg = segmentById.get(id);
                    const cur = seg?.active_result?.result;
                    appliedState = typeof cur === 'string' ? (cur === applied.text ? 'ok' : 'drifted') : 'unknown';
                }
            }
            return {
                id, item, revision, isEffectiveKeep, hasOverride, stateKey,
                appliedActive, appliedState,
                hasMissingPlaceholder: missingPlaceholderIds.has(id),
                hasHanja: hanjaIds.has(id),
                warnCharLimit: warnCharLimitIds.has(id),
                warnOrder: warnOrderIds.has(id),
                warnTb: warnTbIds.has(id),
            };
        });

        // 필터 적용
        const failedSet = reviewView.showOnlyFailed && reviewView.lastFailedIds.length
            ? new Set(reviewView.lastFailedIds.map(normalizeId))
            : null;
        const filtered = descriptors.filter(d => {
            if (failedSet && !failedSet.has(normalizeId(d.id))) return false;
            switch (reviewView.filter) {
                case 'edited': return d.stateKey === 'edit';
                case 'kept': return d.stateKey === 'keep' || d.stateKey === 'none';
                case 'overridden': return d.stateKey === 'override';
                case 'placeholder': return d.hasMissingPlaceholder;
                case 'hanja': return d.hasHanja;
                case 'applied': return d.appliedActive;
                case 'drifted': return d.appliedState === 'drifted';
                case 'warn-charlimit': return d.warnCharLimit;
                case 'warn-order': return d.warnOrder;
                case 'warn-tb': return d.warnTb;
                case 'all':
                default: return true;
            }
        });

        // 정렬 적용
        filtered.sort((a, b) => {
            if (reviewView.sort === 'group') {
                const cmp = String(a.item.gid || '').localeCompare(String(b.item.gid || ''));
                return cmp !== 0 ? cmp : a.id - b.id;
            }
            if (reviewView.sort === 'state') {
                const cmp = stateOrder[a.stateKey] - stateOrder[b.stateKey];
                return cmp !== 0 ? cmp : a.id - b.id;
            }
            return a.id - b.id;
        });

        const totalCount = descriptors.length;
        const shownCount = filtered.length;
        // v0.7.3: 요약을 챕으로 시각화 (색상별 등급: ok/edit/warn/info/fail/muted)
        const chips = [];
        chips.push(`<span class="tw-summary-chip tw-summary-chip-info" title="Phase 3 번역 총 개수"><span class="tw-summary-chip-label">번역</span> <b>${translations.length}</b></span>`);
        if (usePhase45) {
            const phase45Cls = changedCount > 0 ? 'tw-summary-chip-edit' : 'tw-summary-chip-ok';
            chips.push(`<span class="tw-summary-chip ${phase45Cls}" title="Phase 4+5 검수에서 수정된 개수"><span class="tw-summary-chip-label">Phase 4+5</span> <b>수정 ${changedCount}</b></span>`);
        } else {
            chips.push(`<span class="tw-summary-chip tw-summary-chip-muted" title="Phase 4+5 미적용 또는 검증 실패"><span class="tw-summary-chip-label">Phase 4+5</span> <b>—</b></span>`);
        }
        if (appliedCount) {
            const appliedCls = driftedCount > 0 ? 'tw-summary-chip-warn' : 'tw-summary-chip-ok';
            const driftSuffix = driftedCount > 0 ? ` <span class="tw-summary-chip-label">· 수정 ${driftedCount}</span>` : '';
            const unknownSuffix = unknownCount > 0 ? ` <span class="tw-summary-chip-label">· 확인불가 ${unknownCount}</span>` : '';
            chips.push(`<span class="tw-summary-chip ${appliedCls}" title="자동 적용된 항목 수 (drift는 이후 사용자 수정 수)"><span class="tw-summary-chip-label">자동 적용</span> <b>${appliedCount}</b>${driftSuffix}${unknownSuffix}</span>`);
        } else {
            chips.push(`<span class="tw-summary-chip tw-summary-chip-muted" title="이 run에서 자동 적용된 항목 없음"><span class="tw-summary-chip-label">자동 적용</span> <b>0</b></span>`);
        }
        const warnTotals = {
            charLimit: warnCharLimitIds.size,
            order: warnOrderIds.size,
            tb: warnTbIds.size,
        };
        const warnSum = warnTotals.charLimit + warnTotals.order + warnTotals.tb;
        if (warnSum > 0) {
            chips.push('<span class="tw-summary-divider"></span>');
            if (warnTotals.charLimit) chips.push(`<span class="tw-summary-chip tw-summary-chip-warn" title="길이 제한 초과"><span class="tw-summary-chip-label">⚠ 길이</span> <b>${warnTotals.charLimit}</b></span>`);
            if (warnTotals.order) chips.push(`<span class="tw-summary-chip tw-summary-chip-warn" title="placeholder 순서 불일치"><span class="tw-summary-chip-label">⚠ 순서</span> <b>${warnTotals.order}</b></span>`);
            if (warnTotals.tb) chips.push(`<span class="tw-summary-chip tw-summary-chip-warn" title="TB(용어집) 누락"><span class="tw-summary-chip-label">⚠ 용어</span> <b>${warnTotals.tb}</b></span>`);
        }
        if (reviewView.filter !== 'all') {
            chips.push('<span class="tw-summary-divider"></span>');
            chips.push(`<span class="tw-summary-chip tw-summary-chip-filter" title="현재 필터: ${escapeHtml(reviewView.filter)}"><span class="tw-summary-chip-label">필터</span> <b>${shownCount}/${totalCount}</b></span>`);
        }
        summaryEl.classList.add('tw-review-summary-chips');
        summaryEl.innerHTML = chips.join('');

        // v0.7.7 (#6): chunked render — 50행 청크 + requestIdleCallback. renderToken 으로 중단.
        const REVIEW_CHUNK_SIZE = 50;
        const buildRowHtml = (d) => {
            const item = d.item;
            const id = d.id;
            const seg = segmentById.get(id);
            const revision = d.revision;
            const finalText = getBatchFinalText(id);
            const isEffectiveKeep = d.isEffectiveKeep;
            const revisionText = revision && !isEffectiveKeep ? String(revision.t || '') : '';
            // v0.6.2: flag chip (action 셀에서 분리, Phase 4+5 셀로 이동)
            let flagChipClass = 'tw-review-flag-chip';
            let flagChipText;
            if (revision) {
                if (isEffectiveKeep) { flagChipClass += ' tw-review-flag-keep'; flagChipText = '유지'; }
                else { flagChipClass += ' tw-review-flag-edit'; flagChipText = `수정: ${(revision.r || []).join(', ') || 'reason 없음'}`; }
            } else {
                flagChipText = 'Phase3';
            }
            // v0.6.2: override 적용 여부
            const hasOverride = d.hasOverride;
            const overrideChip = hasOverride
                ? `<span class="tw-review-flag-chip tw-review-flag-edit" title="사용자가 직접 수정한 최종 후보">✏️ 직접 수정</span>`
                : '';
            const workState = getSegmentWorkState(id);
            const chatBadge = workState.chat.hasSession
                ? `<span class="tw-review-chat-badge" title="채팅 세션 ${workState.chat.messageCount}개 메시지">💬</span>`
                : '';
            // v0.6.0 L3: applied-from-batch 배지
            let appliedBadge = '';
            if (d.appliedActive) {
                const applied = getAppliedFromBatch(id);
                const stateLabel = d.appliedState === 'drifted' ? ' — 이후 수정됨' : d.appliedState === 'unknown' ? ' — 현재 값 확인 불가 (DOM에 없음)' : '';
                const tip = `배치에서 자동 적용됨 (run ${applied.runId || '?'}, ${applied.phase})${stateLabel}`;
                const icon = d.appliedState === 'drifted' ? '🤖→✏️' : d.appliedState === 'unknown' ? '🤖❓' : '🤖';
                appliedBadge = ` <span class="tw-review-applied-badge" title="${escapeHtml(tip)}">${icon}</span>`;
            }
            // v0.6.5 (A4): revisionText가 있으면 phase3 ↔ revision diff로 렌더
            const revisionHtml = revisionText
                ? `<div class="tw-review-text" title="phase3 대비 변경: 초록=추가, 빨강=삭제">${renderDiffHtml(diffWords(item.t || '', revisionText))}</div>`
                : '';
            // v0.6.6 (B3): warn-only chip들 (final 셀에 부착)
            const warnChips = [];
            if (d.warnCharLimit) {
                const w = (warnSource.charLimitOver || []).find(x => normalizeId(x.id) === id);
                const tip = w ? `길이 ${w.length} / 한도 ${w.limit} (${w.source})` : '길이 초과';
                warnChips.push(`<span class="tw-review-warn-chip tw-review-warn-charlimit" title="${escapeHtml(tip)}">⚠ 길이</span>`);
            }
            if (d.warnOrder) {
                const w = (warnSource.placeholderOrderMismatch || []).find(x => normalizeId(x.id) === id);
                const tip = w ? `예상 순서: ${(w.expected || []).join(' → ')} / 실제: ${(w.actual || []).join(' → ')}` : 'placeholder 순서 다름';
                warnChips.push(`<span class="tw-review-warn-chip tw-review-warn-order" title="${escapeHtml(tip)}">⚠ 순서</span>`);
            }
            if (d.warnTb) {
                const w = (warnSource.tbTermsMissed || []).find(x => normalizeId(x.id) === id);
                const tip = w ? `누락된 용어: ${(w.terms || []).map(t => `${t.src}→${t.expected}`).join(', ')}` : 'TB 용어 누락';
                warnChips.push(`<span class="tw-review-warn-chip tw-review-warn-tb" title="${escapeHtml(tip)}">⚠ 용어</span>`);
            }
            const warnChipsHtml = warnChips.length ? `<div class="tw-review-warn-row">${warnChips.join('')}</div>` : '';
            return `
<div class="tw-review-row" data-row-id="${escapeHtml(id)}" data-has-override="${hasOverride ? '1' : '0'}" tabindex="0">
    <div class="tw-review-cell tw-review-check" data-label="선택"><input class="tw-review-select" type="checkbox" data-id="${escapeHtml(id)}"></div>
    <div class="tw-review-cell" data-label="ID">#${escapeHtml(id)}${chatBadge}${appliedBadge}</div>
    <div class="tw-review-cell" data-label="그룹">${escapeHtml(item.gid || '')}</div>
    <div class="tw-review-cell tw-review-source tw-review-text" data-label="원문">${escapeHtml(seg?.origin_string || '')}</div>
    <div class="tw-review-cell tw-review-text" data-label="Phase 3">${escapeHtml(item.t || '')}</div>
    <div class="tw-review-cell" data-label="Phase 4+5">${revisionHtml}<span class="${flagChipClass}">${escapeHtml(flagChipText)}</span></div>
    <div class="tw-review-cell" data-label="최종 후보"><div class="tw-review-final-wrap" data-final-id="${escapeHtml(id)}"><div class="tw-review-final-view tw-review-text">${escapeHtml(finalText)}</div>${overrideChip}${warnChipsHtml}</div></div>
    <div class="tw-review-cell tw-review-actions" data-label="동작"><button class="tw-btn tw-btn-primary tw-btn-apply-final" data-id="${escapeHtml(id)}" title="현재 textarea에 입력">입력</button><button class="tw-btn tw-btn-ghost tw-btn-edit-final" data-id="${escapeHtml(id)}" title="최종 후보를 직접 수정">✏️</button><button class="tw-btn tw-btn-ghost tw-btn-copy-final" data-id="${escapeHtml(id)}" title="최종 후보 복사">📋</button><button class="tw-btn tw-btn-ghost tw-btn-chat-refine" data-id="${escapeHtml(id)}" title="chat 탭에서 다듬기">💬</button>${hasOverride ? `<button class="tw-btn tw-btn-ghost tw-btn-revert-final" data-id="${escapeHtml(id)}" title="직접 수정 되돌리기">↺</button>` : ''}</div>
</div>`;
        };

        const headHtml = `
<div class="tw-review-row tw-review-head">
    <div><input class="tw-review-select-all" type="checkbox" title="전체 선택"></div><div>ID</div><div>그룹</div><div>원문</div><div>Phase 3</div><div>Phase 4+5</div><div>최종 후보</div><div>동작</div>
</div>`;

        // 첫 청크는 동기 렌더 (50행 또는 전체) — 이전 토큰의 비동기 청크를 무효화
        renderReviewTable._token = (renderReviewTable._token || 0) + 1;
        const myToken = renderReviewTable._token;
        const firstChunk = filtered.slice(0, REVIEW_CHUNK_SIZE).map(buildRowHtml).join('');
        tableEl.innerHTML = headHtml + firstChunk;

        // 남은 행은 청크 단위로 비동기 렌더
        if (filtered.length > REVIEW_CHUNK_SIZE) {
            let cursor = REVIEW_CHUNK_SIZE;
            const total = filtered.length;
            const renderNextChunk = (deadline) => {
                if (renderReviewTable._token !== myToken) return; // cancelled
                if (cursor >= total) {
                    renderReviewTable._pendingFlush = null;
                    return;
                }
                const end = Math.min(cursor + REVIEW_CHUNK_SIZE, total);
                const chunkHtml = filtered.slice(cursor, end).map(buildRowHtml).join('');
                tableEl.insertAdjacentHTML('beforeend', chunkHtml);
                cursor = end;
                if (cursor < total) {
                    scheduleNextChunk();
                } else {
                    renderReviewTable._pendingFlush = null;
                }
            };
            const scheduleNextChunk = () => {
                if (typeof requestIdleCallback === 'function') {
                    requestIdleCallback(renderNextChunk, { timeout: 200 });
                } else {
                    setTimeout(() => renderNextChunk({ timeRemaining: () => 0, didTimeout: true }), 0);
                }
            };
            // 동기 flush hook — 키보드 ↑↓ 점프 시 남은 행을 즉시 그려 인덱스 일관성 확보
            renderReviewTable._pendingFlush = () => {
                if (renderReviewTable._token !== myToken) return;
                if (cursor >= total) return;
                const restHtml = filtered.slice(cursor).map(buildRowHtml).join('');
                tableEl.insertAdjacentHTML('beforeend', restHtml);
                cursor = total;
                renderReviewTable._pendingFlush = null;
            };
            scheduleNextChunk();
        } else {
            renderReviewTable._pendingFlush = null;
        }

        updateReviewApplyStatus('입력은 textarea 값 주입까지만 수행합니다.');
        // v0.6.10 F1: 대용량 run 감시 (200+ 항목일 때 콘솔에 렌더 시간 기록)
        if (descriptors.length >= 200) {
            const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - (renderReviewTable._t0 || 0);
            dverbose(`renderReviewTable: ${descriptors.length}개 행 / ${dt.toFixed(1)}ms (filtered=${filtered.length})`);
        }
    }

    async function onBatchCollect() {
        batchRun = createBatchRunBase();
        try {
            setBatchStatus('collecting');
            appendBatchLog('현재 페이지 세그먼트 수집 시작');

            const { segments, meta } = await fetchCurrentPageSegments(batchRun);
            if (!segments.length) throw new Error('현재 페이지에서 세그먼트를 찾지 못했습니다.');

            const expectedIds = segments.map(seg => normalizeId(seg.id));
            const storageStringId = currentStringId && expectedIds.includes(normalizeId(currentStringId))
                ? normalizeId(currentStringId)
                : expectedIds[0];

            appendBatchLog(`세그먼트 ${segments.length}개 수집 (${meta.shape}, count=${meta.count ?? segments.length})`);
            const notesByStringId = await fetchBatchNotes(expectedIds);
            appendBatchLog(`备注 있는 세그먼트 ${Object.keys(notesByStringId).length}개 수집`);

            const storageSnapshot = await fetchSavedResultSnapshot(storageStringId);
            const tbSummary = buildBatchTbSummary(segments);
            Object.assign(batchRun, {
                status: 'ready',
                segments,
                segmentMeta: meta,
                notesByStringId,
                storageStringId,
                initialStorageRaw: storageSnapshot.raw,
                tbSummary,
                phase12: null,
                phase3: null,
                phase45: null,
                validations: {},
            });
            appendBatchLog(`파일 전체 TB 용어 ${tbSummary.length}개 준비`);
            if (storageSnapshot.raw) {
                appendBatchLog(`storageStringId 기존 결과 길이: ${storageSnapshot.raw.length}`, 'warn');
            }
            persistBatchRun(batchRun);
            renderBatchRun();
        } catch (error) {
            batchRun.status = 'failed';
            appendBatchLog(`수집 실패: ${error.message}`, 'error');
            persistBatchRun(batchRun);
            renderBatchRun();
            toast(error.message, 'error');
        }
    }

    function getPreviousRawForPhase(run, phaseTag) {
        if (phaseTag === '1+2') return run.initialStorageRaw || '';
        if (phaseTag === '3') return run.phase12?.raw || '';
        if (phaseTag === '4+5') return run.phase3?.raw || '';
        return '';
    }

    function getRawForPhase(run, phaseTag) {
        if (phaseTag === '1+2') return run.phase12?.raw || '';
        if (phaseTag === '3') return run.phase3?.raw || '';
        if (phaseTag === '4+5') return run.phase45?.raw || '';
        return '';
    }

    function buildPromptForPhase(run, phaseTag) {
        if (phaseTag === '1+2') return buildPhase12CompactPrompt(run);
        if (phaseTag === '3') return buildPhase3CompactPrompt(run);
        if (phaseTag === '4+5') return buildPhase45CompactPrompt(run);
        throw new Error(`알 수 없는 Phase: ${phaseTag}`);
    }

    function validateParsedPhase(run, phaseTag, parsed) {
        if (phaseTag === '1+2') return validatePhase12Compact(parsed, run.segments);
        // v0.6.6 (B3): warn-only 추가 검증을 위해 visible TB term 매핑 주입 (DOM 의존 — 없으면 빈 Map)
        let tbTerms;
        try { tbTerms = extractVisibleTbTerms(); } catch (_) { tbTerms = new Map(); }
        const opts = { tbTerms };
        if (phaseTag === '3') return validatePhase3Compact(run.phase12.parsed, parsed, run.segments, opts);
        if (phaseTag === '4+5') return validatePhase45Compact(run.phase3.parsed, parsed, run.segments, opts);
        throw new Error(`알 수 없는 Phase: ${phaseTag}`);
    }

    function storePhaseResult(run, phaseTag, raw, parsed, validation) {
        const phaseResult = { raw, parsed, validation, updatedAt: new Date().toISOString() };
        if (phaseTag === '1+2') {
            run.phase12 = phaseResult;
            run.status = validation.ok ? 'phase12_ready' : 'failed';
        } else if (phaseTag === '3') {
            run.phase3 = phaseResult;
            run.status = validation.ok ? 'phase3_ready' : 'failed';
        } else if (phaseTag === '4+5') {
            run.phase45 = phaseResult;
            run.status = validation.ok ? 'phase45_ready' : 'failed';
        }
        run.validations[phaseTag] = validation;
        if (validation.ok) run.lastError = null;
    }

    async function onRunBatchPhase(phaseTag) {
        const run = ensureBatchRun();
        if (!run.segments?.length) {
            toast('먼저 현재 페이지를 수집하세요.', 'error');
            return;
        }
        if (phaseTag === '3' && !run.phase12?.validation?.ok) {
            toast('Phase 1+2 검증 통과 후 실행할 수 있습니다.', 'error');
            return;
        }
        if (phaseTag === '4+5' && !run.phase3?.validation?.ok) {
            toast('Phase 3 검증 통과 후 실행할 수 있습니다.', 'error');
            return;
        }

        // v0.6.5 (B2): override 보호 — phase 재실행은 최종 후보에 영향 줄 수 있음
        if ((phaseTag === '3' || phaseTag === '4+5') && run.runId) {
            const overrideCount = countReviewOverridesForRun(run.runId);
            if (overrideCount > 0) {
                const ok = await twConfirm({
                    title: `Phase ${phaseTag} 재실행 — 직접 수정 보존`,
                    message: `이 run에 직접 수정한 최종 후보가 ${overrideCount}개 있습니다.\n` +
                        `Phase ${phaseTag}을(를) 다시 실행하면 새 결과가 표시되지만 직접 수정값은 유지되어 우선 적용됩니다.\n\n` +
                        `계속하시겠습니까? (취소하면 실행이 중단됩니다)`,
                });
                if (!ok) {
                    appendBatchLog(`Phase ${phaseTag} 재실행 취소됨 (직접 수정 ${overrideCount}개 유지)`, 'info');
                    return;
                }
                appendBatchLog(`Phase ${phaseTag} 재실행 — 직접 수정 ${overrideCount}개는 유지됨`, 'warn');
            }
        }

        try {
            run.model = getSelectedModel() || run.model || MODELS[0];
            const statusMap = { '1+2': 'phase12_running', '3': 'phase3_running', '4+5': 'phase45_running' };
            run.status = statusMap[phaseTag];
            run.lastExpectedPhase = phaseTag;
            run.lastError = null;
            persistBatchRun(run);
            renderBatchRun();

            const prompt = buildPromptForPhase(run, phaseTag);
            appendBatchLog(`Phase ${phaseTag} 실행 시작, prompt length=${prompt.length}`);

            const previousRaw = getPreviousRawForPhase(run, phaseTag);
            const taskId = await callPrefixPromptTran(run.projectId, run.storageStringId, prompt, run.model);
            appendBatchLog(`task 등록 완료: ${taskId}`);

            await pollTask(taskId, {
                maxAttempts: BATCH_MAX_POLL_ATTEMPTS,
                interval: BATCH_POLL_INTERVAL_MS,
                onProgress: (n, status, progress) => {
                    const tail = progress ? ` (${formatTaskProgress(progress)})` : '';
                    appendBatchLog(`Phase ${phaseTag} 폴링 ${n}차: ${status}${tail}`);
                },
            });

            const { raw, parsed } = await waitForExpectedBatchResult(run, phaseTag, previousRaw);
            const validation = validateParsedPhase(run, phaseTag, parsed);
            storePhaseResult(run, phaseTag, raw, parsed, validation);
            appendBatchLog(
                `Phase ${phaseTag} 검증: ${formatPhaseValidation(validation)}`,
                validation.ok ? 'success' : 'warn'
            );
            persistBatchRun(run);
            renderBatchRun();
            if (validation.ok) toast(`Phase ${phaseTag} 완료`, 'success');
        } catch (error) {
            const statusByCode = {
                STALE_RESULT: 'stale',
                BEDROCK_READ_TIMEOUT: 'bedrock_timeout',
                MODEL_ENDPOINT_ERROR: 'model_endpoint_error',
            };
            run.status = statusByCode[error.workflowCode] || 'failed';
            run.lastError = error.message;
            appendBatchLog(`Phase ${phaseTag} 실패: ${error.message}`, 'error');
            persistBatchRun(run);
            renderBatchRun();
            toast(error.message, 'error', 5000);
        }
    }

    async function onBatchRefetchResult() {
        const run = ensureBatchRun();
        if (!run.storageStringId || !run.lastExpectedPhase) {
            toast('다시 읽을 Phase 결과가 없습니다.', 'error');
            return;
        }

        try {
            appendBatchLog(`storageStringId ${run.storageStringId} 결과 다시 읽기 시작`);
            const { raw } = await fetchSavedResultSnapshot(run.storageStringId);
            const savedIssue = classifySavedResult(raw);
            if (savedIssue) {
                throw makeWorkflowError(savedIssue.message, savedIssue.type);
            }

            const parsed = parseWorkflowJson(raw, run.lastExpectedPhase);
            const staleCandidates = [
                getRawForPhase(run, run.lastExpectedPhase),
                run.initialStorageRaw || '',
            ].filter(Boolean);
            if (staleCandidates.some(staleRaw => raw === staleRaw)) {
                throw makeWorkflowError('저장본이 이미 알고 있는 같은 phase 결과와 동일합니다. 새 결과 반영 여부를 확인할 수 없어 stale로 처리합니다.', 'STALE_RESULT');
            }
            const validation = validateParsedPhase(run, run.lastExpectedPhase, parsed);
            storePhaseResult(run, run.lastExpectedPhase, raw, parsed, validation);
            appendBatchLog(
                `결과 다시 읽기 검증: ${formatPhaseValidation(validation)}`,
                validation.ok ? 'success' : 'warn'
            );
            persistBatchRun(run);
            renderBatchRun();
            toast('저장 결과를 다시 읽었습니다.', validation.ok ? 'success' : 'info');
        } catch (error) {
            const statusByCode = {
                STALE_RESULT: 'stale',
                BEDROCK_READ_TIMEOUT: 'bedrock_timeout',
                MODEL_ENDPOINT_ERROR: 'model_endpoint_error',
            };
            run.status = statusByCode[error.workflowCode] || 'failed';
            run.lastError = error.message;
            appendBatchLog(`결과 다시 읽기 실패: ${error.message}`, 'error');
            persistBatchRun(run);
            renderBatchRun();
            toast(error.message, 'error', 5000);
        }
    }

    // ========================================================================
    // 모달 Show/Hide + 세그먼트 로드 + 자동 감지 폴링
    // ========================================================================
    let segmentWatcherId = null;
    // race 가드: 이전 watcher의 in-flight loadSegmentInfo()가 다음 watcher가 시작된 뒤
    // 늦게 도착해서 stale render를 트리거하는 것을 막기 위한 epoch.
    let segmentWatcherEpoch = 0;

    // 모달 열린 동안 세그먼트 변경 자동 감지
    function startSegmentWatcher() {
        stopSegmentWatcher();
        const myEpoch = ++segmentWatcherEpoch;
        segmentWatcherId = setInterval(async () => {
            // 세대가 바뀌면 (다른 watcher가 시작) 조용히 종료
            if (myEpoch !== segmentWatcherEpoch) return;
            if (!modalEl || modalEl.style.display === 'none') {
                stopSegmentWatcher();
                return;
            }
            const newId = getCurrentStringId();
            if (newId && newId !== currentStringId) {
                dverbose(`세그먼트 변경 감지: ${currentStringId} → ${newId}`);
                const targetId = newId;
                currentStringId = targetId;
                try {
                    await loadSegmentInfo(targetId);
                    // 로드 완료 시점에서 epoch나 대상 세그먼트가 바뀌었으면
                    // 이 render는 stale이므로 듬냈다.
                    if (myEpoch !== segmentWatcherEpoch) return;
                    if (currentStringId !== targetId) return;
                    renderChatHistory();
                } catch (e) {
                    console.error('[TMS-WF] 세그먼트 자동 갱신 실패:', e);
                }
            }
        }, SESSION_CHECK_INTERVAL);
    }
    function stopSegmentWatcher() {
        if (segmentWatcherId) {
            clearInterval(segmentWatcherId);
            segmentWatcherId = null;
        }
        // 변경 수례를 올려 남아 있는 in-flight tick이 스스로 종료하도록 유도
        segmentWatcherEpoch++;
    }

    async function showModal() {
        const stringId = getCurrentStringId(true); // verbose: 모달 열 때는 로그 남김
        if (!stringId) {
            toast('현재 선택된 세그먼트를 찾지 못했습니다. 세그먼트를 먼저 클릭하세요.', 'error');
            return;
        }

        // v0.7.7 (#10): LS 스키마 버전 가드 — 마이그레이션 step 실행 (현재는 infra만)
        try { ensureSchemaVersion(); } catch (e) { console.warn('schema version 가드 실패', e); }

        // v0.7.7 (#12): IDB 백업 자동 복원 — LS가 비어 있고 백업이 있을 때만 prompt
        try { await maybeRestoreFromBackup(); } catch (e) { dwarn('IDB 백업 복원 체크 실패', e); }

        // 만료된 세션 자동 정리 (백그라운드)
        try { pruneExpiredSessions(); } catch (e) { console.warn('세션 정리 실패', e); }

        currentStringId = stringId;

        const el = createModal();
        el.classList.remove('tw-hidden');
        el.style.display = 'flex';

        // 세그먼트 로드
        await loadSegmentInfo(stringId);

        // 세션 복원 — LS를 단일 source-of-truth로 강제 (다른 URL 메모리의 stale run 방지)
        renderChatHistory();
        syncBatchRunFromLs();
        setMainTab(currentMainTab);

        // 자동 감지 폴링 시작
        startSegmentWatcher();

        // 입력창 포커스
        if (currentMainTab === 'chat') {
            setTimeout(() => $('.tw-chat-input', el).focus(), 100);
        }
    }

    function hideModal() {
        if (modalEl) modalEl.style.display = 'none';
        stopSegmentWatcher();
    }

    async function loadSegmentInfo(stringId) {
        const infoEl = $('.tw-seg-info', modalEl);
        const contentEl = $('.tw-context-content', modalEl);
        infoEl.textContent = `#${stringId} 정보 로딩 중…`;
        contentEl.innerHTML = '<span class="tw-muted">로딩 중…</span>';

        try {
            const seg = await fetchSegmentDetail(stringId);
            if (!seg) {
                contentEl.innerHTML = '<span class="tw-muted">세그먼트 정보를 불러오지 못했습니다.</span>';
                return;
            }
            currentSegment = seg;

            infoEl.textContent = `#${stringId} · ${seg.context || '—'} · ${seg.file_name || ''}`;

            // 컨텍스트 렌더
            const sections = [];
            sections.push(`
<div class="tw-context-section">
    <div class="tw-context-label">원문</div>
    <div class="tw-context-value">${escapeHtml(seg.origin_string || '')}</div>
</div>`);
            if (seg.char_limit && seg.char_limit > 0) {
                sections.push(`
<div class="tw-context-section">
    <div class="tw-context-label">글자수 제한</div>
    <div class="tw-context-value">${Number(seg.char_limit) || 0}자</div>
</div>`);
            }
            if (seg.match_terms && seg.match_terms.length) {
                const terms = seg.match_terms.map(t => {
                    const s = t.trans?.['zh-Hans'] || t.trans?.zh || '?';
                    const d = t.trans?.ko || '?';
                    return `${escapeHtml(s)} → ${escapeHtml(d)}`;
                }).join('<br>');
                sections.push(`
<div class="tw-context-section">
    <div class="tw-context-label">용어집 (${seg.match_terms.length})</div>
    <div class="tw-context-value">${terms}</div>
</div>`);
            }
            if (seg.active_result?.result) {
                sections.push(`
<div class="tw-context-section">
    <div class="tw-context-label">현재 번역</div>
    <div class="tw-context-value">${escapeHtml(seg.active_result.result)}</div>
</div>`);
            }
            if (seg.context) {
                sections.push(`
<div class="tw-context-section">
    <div class="tw-context-label">Context ID</div>
    <div class="tw-context-value">${escapeHtml(seg.context)}</div>
</div>`);
            }

            // 배치 정보 (있을 때만 표시)
            const workState = getSegmentWorkState(stringId);
            if (workState.batch.hasPhase3 || workState.batch.hasRevision) {
                const lines = [];
                if (workState.batch.groupId) {
                    lines.push(`<div><b>그룹:</b> ${escapeHtml(workState.batch.groupId)}</div>`);
                }
                if (workState.batch.phase3Text) {
                    lines.push(`<div><b>Phase 3:</b> ${escapeHtml(workState.batch.phase3Text)}</div>`);
                }
                if (workState.batch.hasRevision) {
                    if (workState.batch.changed && workState.batch.revisionText) {
                        const reasons = workState.batch.reasons.length
                            ? ` <span class="tw-muted">(${escapeHtml(workState.batch.reasons.join(', '))})</span>`
                            : '';
                        lines.push(`<div><b>Phase 4+5:</b> ${escapeHtml(workState.batch.revisionText)}${reasons}</div>`);
                    } else {
                        lines.push(`<div><b>Phase 4+5:</b> <span class="tw-muted">유지 (Phase 3 그대로)</span></div>`);
                    }
                }
                sections.push(`
<div class="tw-context-section">
    <div class="tw-context-label">📦 배치 결과</div>
    <div class="tw-context-value">${lines.join('')}</div>
</div>`);
            }

            contentEl.innerHTML = sections.join('');
        } catch (e) {
            contentEl.innerHTML = `<span class="tw-muted">오류: ${escapeHtml(e.message)}</span>`;
        }
    }

    // ========================================================================
    // 채팅 흐름
    // ========================================================================
    function renderChatHistory() {
        const messagesEl = $('.tw-chat-messages', modalEl);
        const session = getSession(currentStringId);
        messagesEl.innerHTML = '';

        // v0.6.0 L1: batch import 시드 배지 노출
        // v0.7.8 (#3): runId가 있으면 클릭 가능한 태그로 표시 — review 탭 점프
        if (session.system && session.source === 'batch_import') {
            const runId = session.importedFromRunId || '';
            if (runId) {
                const sysMsg = appendMessage('system', '📦 배치 결과로 시드됨 — 아래 후보를 출발점으로 요청을 입력하세요.');
                const contentEl = $('.tw-msg-content', sysMsg);
                if (contentEl) {
                    const tag = document.createElement('a');
                    tag.className = 'tw-chat-runid-tag';
                    tag.href = '#';
                    tag.dataset.runId = String(runId);
                    tag.title = 'review 탭에서 이 run을 활성화하고 해당 행으로 점프';
                    tag.textContent = ` (run ${runId})`;
                    // 📦 ... 시드됨 [tag] — 아래 ...
                    const seedMatch = contentEl.firstChild && contentEl.firstChild.nodeType === 3
                        ? contentEl.firstChild.nodeValue : '';
                    if (seedMatch) {
                        const insertAt = seedMatch.indexOf('시드됨');
                        if (insertAt >= 0) {
                            const before = seedMatch.slice(0, insertAt + '시드됨'.length);
                            const after = seedMatch.slice(insertAt + '시드됨'.length);
                            contentEl.firstChild.nodeValue = before;
                            contentEl.appendChild(tag);
                            contentEl.appendChild(document.createTextNode(after));
                        } else {
                            contentEl.appendChild(tag);
                        }
                    }
                }
            } else {
                appendMessage('system', '📦 배치 결과로 시드됨 — 아래 후보를 출발점으로 요청을 입력하세요.');
            }
        }

        if (!session.messages.length) {
            appendMessage('system', '새 세션입니다. 번역 요청을 입력하세요.');
        } else {
            session.messages.forEach(m => appendMessage(m.role, m.content));
        }

        updateAdoptButton(session);
    }

    function appendMessage(role, content) {
        const messagesEl = $('.tw-chat-messages', modalEl);
        const msg = document.createElement('div');
        msg.className = `tw-msg tw-msg-${role}`;
        const label = role === 'user' ? '나' : role === 'ai' ? 'AI' : '';
        // v0.6.10 C2-신: AI 메시지마다 인라인 적용/복사 액션 부착
        // v0.7.8 (#1): "✓ override 굳히기" 추가 — 채팅 결과를 현재 run의 review override로 반영
        const actions = role === 'ai'
            ? `<div class="tw-msg-actions">
    <button type="button" class="tw-msg-action tw-msg-action-apply" title="이 결과를 현재 세그먼트 textarea에 적용">✓ 셀로 적용</button>
    <button type="button" class="tw-msg-action tw-msg-action-override" title="이 결과를 현재 run의 최종 후보 override로 저장 (결과 검토에 반영)">✓ override 굳히기</button>
    <button type="button" class="tw-msg-action tw-msg-action-copy" title="이 결과를 클립보드로 복사">📋 복사</button>
</div>`
            : '';
        msg.innerHTML = `
${label ? `<div class="tw-msg-role">${label}</div>` : ''}
<div class="tw-msg-content">${escapeHtml(content)}</div>${actions}`;
        messagesEl.appendChild(msg);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return msg;
    }

    function updateProgressMessage(msgEl, text) {
        $('.tw-msg-content', msgEl).textContent = text;
    }

    function updateAdoptButton(session) {
        const btn = $('.tw-btn-adopt', modalEl);
        // 마지막 메시지가 AI이면 활성화
        const last = session.messages[session.messages.length - 1];
        btn.disabled = !(last && last.role === 'ai');
    }

    async function onSend() {
        const input = $('.tw-chat-input', modalEl);
        const userMessage = input.value.trim();
        if (!userMessage) return;
        if (!currentStringId || !currentSegment) {
            toast('세그먼트 정보가 없습니다.', 'error');
            return;
        }

        const sendBtn = $('.tw-btn-send', modalEl);
        sendBtn.disabled = true;

        // 사용자 메시지 추가
        const session = getSession(currentStringId);
        session.messages.push({ role: 'user', content: userMessage });
        setSession(currentStringId, session);
        appendMessage('user', userMessage);
        input.value = '';

        // AI 진행 메시지
        const progressMsg = appendMessage('ai', '⏳ 요청 전송 중…');
        progressMsg.classList.add('tw-msg-progress');

        try {
            // 프롬프트 조립
            const activePrompt = getChatActivePrompt();
            const systemPrompt = activePrompt?.content || '';
            const segmentCtx = buildSegmentContext(currentSegment);

            // 대화 이력은 방금 추가한 user를 제외하고 과거만
            const history = session.messages.slice(0, -1);
            const prefixPrompt = buildPrefixPrompt(systemPrompt, segmentCtx, history, userMessage, session.system || null);

            // 콘솔에 최종 프롬프트 출력 (디버그)
            console.groupCollapsed('[TMS Workflow] prefix_prompt 전송');
            console.log(prefixPrompt);
            console.groupEnd();

            // API 호출
            const { projectId } = getUrlParams();
            const model = getSelectedModel();

            updateProgressMessage(progressMsg, '⏳ 작업 등록 중…');
            const taskId = await callPrefixPromptTran(projectId, currentStringId, prefixPrompt, model);

            updateProgressMessage(progressMsg, '⏳ 처리 중… (5초 간격 폴링)');
            await pollTask(taskId, {
                onProgress: (n, status, progress) => {
                    const tail = progress ? ` — ${formatTaskProgress(progress)}` : '';
                    updateProgressMessage(progressMsg, `⏳ 처리 중… [${n}차] ${status}${tail}`);
                },
            });

            updateProgressMessage(progressMsg, '⏳ 결과 조회 중…');
            const rawResult = await fetchActiveResult(currentStringId);
            const result = sanitizeChatTranslation(rawResult);
            if (rawResult && result !== rawResult) {
                dverbose('sanitize:', { before: rawResult, after: result });
            }

            if (!result) {
                updateProgressMessage(progressMsg, '⚠️ 결과가 비어있습니다. 세그먼트 상태를 확인하세요.');
                progressMsg.classList.remove('tw-msg-progress');
                return;
            }

            // 결과 메시지로 교체
            progressMsg.classList.remove('tw-msg-progress');
            $('.tw-msg-content', progressMsg).textContent = result;

            // 세션에 AI 응답 저장
            session.messages.push({ role: 'ai', content: result });
            setSession(currentStringId, session);

            // 세그먼트 정보 리프레시 (현재 번역 표시 갱신)
            currentSegment.active_result = { ...currentSegment.active_result, result };
            loadSegmentInfo(currentStringId);

            updateAdoptButton(session);
        } catch (e) {
            progressMsg.classList.remove('tw-msg-progress');
            $('.tw-msg-content', progressMsg).textContent = `❌ 오류: ${e.message}`;
            console.error('[TMS Workflow]', e);
        } finally {
            sendBtn.disabled = false;
        }
    }

    async function onResetSession() {
        if (!currentStringId) return;
        const ok = await twConfirm({
            title: '대화 이력 초기화',
            message: '현재 세그먼트의 대화 이력을 초기화하시겠습니까?\n(번역 자체는 삭제되지 않습니다)',
            danger: true,
        });
        if (!ok) return;
        clearSession(currentStringId);
        renderChatHistory();
        toast('세션 초기화됨', 'success');
    }

    // v0.6.10 C2-신: AI 메시지 인라인 액션 (셀로 적용 / 복사)
    function onChatMessageAction(e) {
        // v0.7.8 (#3): runId 태그 클릭 → review 탭 점프
        const runTag = e.target.closest('.tw-chat-runid-tag');
        if (runTag) {
            e.preventDefault();
            const runId = runTag.dataset.runId;
            if (!runId) return;
            const runs = (() => { try { return loadBatchRuns(); } catch { return {}; } })();
            if (!runs[runId]) {
                toast(`run ${runId} 가 더 이상 존재하지 않습니다 (삭제됨/만료)`, 'warn');
                return;
            }
            try {
                if (getActiveBatchRunId() !== runId) {
                    setActiveBatchRunId(runId);
                    syncBatchRunFromLs();
                }
                setMainTab('review');
                // 해당 행으로 스크롤 + flash
                const targetId = currentStringId;
                if (targetId) {
                    setTimeout(() => {
                        try { renderReviewTable._pendingFlush && renderReviewTable._pendingFlush(); } catch {}
                        const safe = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(targetId)) : String(targetId);
                        const row = $(`.tw-review-row[data-row-id="${safe}"]`, modalEl);
                        if (row) {
                            row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                            row.classList.add('tw-review-row-flash');
                            setTimeout(() => row.classList.remove('tw-review-row-flash'), 1500);
                            row.focus();
                        }
                    }, 50);
                }
            } catch (err) {
                derror('runId 태그 점프 실패', err);
                toast('점프 실패: ' + err.message, 'error');
            }
            return;
        }

        const btn = e.target.closest('.tw-msg-action');
        if (!btn) return;
        const msgEl = btn.closest('.tw-msg');
        if (!msgEl || !msgEl.classList.contains('tw-msg-ai')) return;
        if (msgEl.classList.contains('tw-msg-progress')) return;
        const contentEl = $('.tw-msg-content', msgEl);
        const text = contentEl ? contentEl.textContent : '';
        if (!text) return;

        if (btn.classList.contains('tw-msg-action-copy')) {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(
                    () => toast('복사했습니다.', 'success'),
                    () => toast('클립보드 복사 실패', 'error'),
                );
            } else {
                toast('이 환경에서는 클립보드를 사용할 수 없습니다.', 'error');
            }
            return;
        }

        // v0.7.8 (#1): override로 굳히기 — chat 결과를 review override에 영속 반영
        if (btn.classList.contains('tw-msg-action-override')) {
            if (!currentStringId) {
                toast('현재 세그먼트 ID를 알 수 없습니다.', 'error');
                return;
            }
            const session = getSession(currentStringId);
            // 우선순위: session.importedFromRunId (배치 시드된 경우) → 활성 batch run
            const runId = session.importedFromRunId || getActiveBatchRunId();
            if (!runId) {
                toast('현재 활성 batch run이 없어 override로 굳힐 수 없습니다.', 'warn');
                return;
            }
            try {
                setReviewOverride(runId, currentStringId, text);
                toast(`override로 굳혔습니다 (run ${runId})`, 'success');
                // review 탭이 열려 있으면 즉시 갱신
                if (currentMainTab === 'review') {
                    try { renderReviewTable(); } catch {}
                }
            } catch (err) {
                derror('override 굳히기 실패', err);
                toast('override 저장 실패: ' + err.message, 'error');
            }
            return;
        }

        if (btn.classList.contains('tw-msg-action-apply')) {
            if (!currentStringId) {
                toast('현재 세그먼트 ID를 알 수 없습니다.', 'error');
                return;
            }
            const textarea = findTranslationTextarea(currentStringId);
            if (!textarea) {
                toast('번역 입력창을 찾지 못했습니다. 세그먼트를 먼저 클릭하세요.', 'error');
                if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text).then(
                        () => toast('대신 클립보드에 복사했습니다.', 'info'),
                    );
                }
                return;
            }
            try {
                injectTextareaValue(textarea, text);
                try { clearAppliedFromBatch(currentStringId); } catch (err) { /* noop */ }
                toast('이 결과를 셀에 적용했습니다.', 'success');
            } catch (err) {
                console.error('[TMS-WF] inline apply 실패:', err);
                toast('적용 실패: ' + err.message, 'error');
            }
        }
    }

    function onAdoptTranslation() {
        const session = getSession(currentStringId);
        const last = session.messages[session.messages.length - 1];
        if (!last || last.role !== 'ai') {
            toast('AI 응답이 없어 채택할 번역이 없습니다.', 'error');
            return;
        }

        const translation = last.content;

        // 번역 입력 textarea 찾기
        const textarea = findTranslationTextarea(currentStringId);
        if (!textarea) {
            // 원인: 사용자가 해당 세그먼트 UI를 열지 않은 상태
            toast('번역 입력창을 찾지 못했습니다. 세그먼트를 먼저 클릭하세요.', 'error');
            console.warn('[TMS-WF] 번역 입력창 탐색 실패. 시도한 전략:',
                TRANSLATION_TEXTAREA_HINTS);
            // 대안: 클립보드에 복사
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(translation).then(() => {
                    toast('대신 클립보드에 복사했습니다.', 'info');
                });
            }
            return;
        }

        // 값 주입
        try {
            injectTextareaValue(textarea, translation);
            // v0.6.0 L3: chat에서 채택한 순간 출처가 batch→chat으로 전환되므로 applied 기록 제거
            try { clearAppliedFromBatch(currentStringId); } catch (err) { console.warn('[TMS-WF] applied 기록 제거 실패', err); }
            toast('번역 입력창에 채웠습니다. 확인 후 저장하세요.', 'success');
            dverbose('textarea 주입 완료:', translation.slice(0, 50) + '...');
            hideModal();
        } catch (e) {
            console.error('[TMS-WF] textarea 주입 실패:', e);
            toast('번역 주입 실패: ' + e.message, 'error');
        }
    }

    // ========================================================================
    // 시스템 프롬프트 설정 패널
    // ========================================================================
    function showSettingsPanel() {
        if ($('.tw-settings-overlay', modalEl)) return;

        const overlay = document.createElement('div');
        overlay.className = 'tw-settings-overlay';
        overlay.innerHTML = `
<div class="tw-settings-panel">
    <div class="tw-settings-header">
        <span class="tw-settings-header-title">⚙️ 설정</span>
        <div class="tw-settings-tabs">
            <button class="tw-settings-tab active" data-tab="prompts">📝 시스템 프롬프트</button>
            <button class="tw-settings-tab" data-tab="sessions">🧰 워크스페이스</button>
        </div>
        <button class="tw-btn tw-btn-ghost tw-btn-settings-close">닫기</button>
    </div>
    <div class="tw-settings-content tw-settings-tab-prompts">
        <div class="tw-settings-prompt-toolbar">
            <label class="tw-prompt-lock-label">
                <input type="checkbox" class="tw-prompt-lock-toggle">
                <span>채팅 · 배치 프롬프트 동기화 (잠금)</span>
            </label>
            <span class="tw-prompt-lock-hint">체크 시 한쪽 변경이 양쪽에 반영됩니다.</span>
        </div>
        <div class="tw-settings-prompt-body">
            <div class="tw-settings-list"></div>
            <div class="tw-settings-editor">
                <div class="tw-prompt-header-row">
                    <input type="text" class="tw-prompt-name" placeholder="프롬프트 이름">
                    <button class="tw-btn tw-btn-ghost tw-btn-settings-new">+ 새 프롬프트</button>
                </div>
                <textarea class="tw-prompt-content" placeholder="시스템 프롬프트 내용을 입력하세요 (예: v3.0 프롬프트)"></textarea>
                <div class="tw-settings-buttons">
                    <button class="tw-btn tw-btn-ghost tw-btn-settings-delete">🗑️ 삭제</button>
                    <button class="tw-btn tw-btn-primary tw-btn-settings-save" style="margin-left:auto">💾 저장</button>
                </div>
            </div>
        </div>
    </div>
    <div class="tw-settings-content tw-settings-tab-sessions" style="display:none; flex-direction:column; gap:16px;">
        <div class="tw-session-stats">
            <div class="tw-stat-title">📊 저장 현황</div>
            <div class="tw-stat-body"></div>
        </div>
        <div class="tw-session-actions">
            <div class="tw-stat-title">🧹 채팅 세션 관리</div>
            <div class="tw-session-buttons">
                <button class="tw-btn tw-btn-ghost tw-btn-session-prune">
                    🗓️ ${SESSION_TTL_DAYS}일 이상 된 세션 정리
                </button>
                <button class="tw-btn tw-btn-danger tw-btn-session-clear-all">
                    ⚠️ 모든 세션 삭제
                </button>
            </div>
            <div class="tw-stat-hint">💡 세션만 영향받고 시스템 프롬프트는 보존됩니다.</div>
        </div>
        <div class="tw-session-actions tw-ws-runs-section">
            <div class="tw-ws-section-head">
                <div class="tw-stat-title">🧪 Batch Run 관리</div>
                <div class="tw-ws-section-head-actions">
                    <button class="tw-btn tw-btn-ghost tw-btn-ws-runs-prune" title="최근 10개를 제외하고 30일 초과된 완료 run을 정리 (활성/실행중 run은 보호)">🧹 오래된 run 정리</button>
                    <button class="tw-btn tw-btn-ghost tw-btn-ws-runs-refresh" title="목록 갱신">🔄</button>
                </div>
            </div>
            <div class="tw-ws-runs-body"></div>
            <div class="tw-stat-hint">💡 활성 run은 좌측에 초록 줄로 표시됩니다. 정리 시 짝 override + 고아 importedFromRunId가 함께 정리됩니다.</div>
        </div>
        <div class="tw-session-actions tw-ws-overrides-section">
            <div class="tw-ws-section-head">
                <div class="tw-stat-title">✂ Override 관리</div>
                <div class="tw-ws-section-head-actions">
                    <button class="tw-btn tw-btn-ghost tw-btn-ws-overrides-prune" title="고아 override (run이 없는 항목) 일괄 삭제">🧹 고아 override 정리</button>
                </div>
            </div>
            <div class="tw-ws-overrides-body"></div>
            <div class="tw-stat-hint">💡 override는 사용자가 review 패널에서 직접 수정한 최종 후보입니다. run이 삭제되면 자동 정리되지 않습니다.</div>
        </div>
        <div class="tw-session-actions tw-ws-slots-section">
            <div class="tw-ws-section-head">
                <div class="tw-stat-title">💾 IDB 자동 백업 슬롯</div>
                <div class="tw-ws-section-head-actions">
                    <button class="tw-btn tw-btn-ghost tw-btn-ws-slots-snapshot" title="지금 즉시 IDB에 백업 1회 강제 저장">📸 지금 백업</button>
                    <button class="tw-btn tw-btn-ghost tw-btn-ws-slots-refresh" title="목록 갱신">🔄</button>
                </div>
            </div>
            <div class="tw-ws-slots-body"></div>
            <div class="tw-stat-hint">💡 ${BACKUP_SLOT_COUNT}칸 ring buffer. override ${OVERRIDE_BACKUP_THRESHOLD}회마다 / phase45 완료 시 자동 저장됩니다.</div>
        </div>
        <div class="tw-session-actions">
            <div class="tw-stat-title">📦 백업 · 복원</div>
            <div class="tw-ws-export-matrix" data-role="export-matrix">
                <label><input type="checkbox" data-export-key="sessions" checked> 💬 세션 <span class="tw-ws-matrix-count" data-count="sessions"></span></label>
                <label><input type="checkbox" data-export-key="prompts"> 📝 프롬프트 <span class="tw-ws-matrix-count" data-count="prompts"></span></label>
                <label><input type="checkbox" data-export-key="batchRuns"> 🧪 Batch Run <span class="tw-ws-matrix-count" data-count="batchRuns"></span></label>
                <label><input type="checkbox" data-export-key="overrides"> ✂ Override <span class="tw-ws-matrix-count" data-count="overrides"></span></label>
                <label title="batch run의 무거운 raw segment 제외 (권장)"><input type="checkbox" data-export-key="stripRaw" checked> raw segment 제외</label>
            </div>
            <div class="tw-session-buttons">
                <button class="tw-btn tw-btn-primary tw-btn-export-selected" title="위에서 체크된 항목만 한 파일로 백업">📤 선택 항목 백업</button>
                <button class="tw-btn tw-btn-ghost tw-btn-export-preset" data-preset="sessions">세션만</button>
                <button class="tw-btn tw-btn-ghost tw-btn-export-preset" data-preset="sessions+prompts">세션+프롬프트</button>
                <button class="tw-btn tw-btn-ghost tw-btn-export-preset" data-preset="workspace">워크스페이스 전체</button>
                <button class="tw-btn tw-btn-ghost tw-btn-session-import">📥 JSON에서 복원</button>
            </div>
            <div class="tw-stat-hint">💡 프리셋 버튼은 체크박스를 자동으로 맞추기만 하므로 다시 한 번 [📤 선택 항목 백업]을 눌러 다운로드하세요. 복원은 항목별 신규/덮어쓸/동일 카운트를 미리 보여줍니다.</div>
            <input type="file" class="tw-session-import-file" accept=".json,application/json" style="display:none">
        </div>
        <div class="tw-session-info">
            <div class="tw-stat-title">ℹ️ 자동 정리 정책</div>
            <div class="tw-session-info-body">
                • 마지막 대화로부터 <strong>${SESSION_TTL_DAYS}일</strong> 이상 지난 세션은 모달 열 때 자동 삭제됩니다.<br>
                • 자동 정리는 <strong>세션에만 적용</strong>되며 시스템 프롬프트는 영향받지 않습니다.<br>
                • 데이터는 브라우저 localStorage에 저장됩니다 (쿠키 사용 안 함).
            </div>
        </div>
    </div>
</div>`;
        modalEl.appendChild(overlay);

        // ==== 탭 전환 ====
        const tabButtons = $$('.tw-settings-tab', overlay);
        const promptsTab = $('.tw-settings-tab-prompts', overlay);
        const sessionsTab = $('.tw-settings-tab-sessions', overlay);
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                tabButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const tab = btn.dataset.tab;
                promptsTab.style.display = tab === 'prompts' ? 'flex' : 'none';
                sessionsTab.style.display = tab === 'sessions' ? 'flex' : 'none';
                if (tab === 'sessions') {
                    if (typeof refreshWorkspaceUi === 'function') refreshWorkspaceUi();
                    else refreshSessionStats();
                }
            });
        });

        // ==== 시스템 프롬프트 탭 ====
        // 잠금 토글: 채팅·배치 활성 프롬프트 동기화
        const lockToggle = $('.tw-prompt-lock-toggle', overlay);
        if (lockToggle) {
            lockToggle.checked = getPromptLockLinked();
            lockToggle.addEventListener('change', () => {
                const linked = lockToggle.checked;
                setPromptLockLinked(linked);
                if (linked) {
                    // 활성화 시점: 채팅 ID를 기준으로 양쪽 통일 (드롭다운 즉시 반영)
                    const chatId = getChatActivePromptId();
                    syncChatPromptSelects(chatId);
                    toast('채팅·배치 프롬프트가 동기화되었습니다.', 'success');
                } else {
                    toast('동기화가 해제되었습니다. 양쪽 프롬프트를 따로 선택할 수 있습니다.', 'info');
                }
                refresh(); // 뱃지 다시 그리기
            });
        }

        // 편집 진입 시 기본으로 보여줄 프롬프트: 채팅 활성 프롬프트 기준
        let currentEditingId = getChatActivePromptId();

        const listEl = $('.tw-settings-list', overlay);
        const nameInput = $('.tw-prompt-name', overlay);
        const contentTextarea = $('.tw-prompt-content', overlay);

        function refresh() {
            const prompts = loadPrompts();
            const chatActiveId = getChatActivePromptId();
            const batchActiveId = getBatchActivePromptId();
            listEl.innerHTML = prompts.map(p => {
                const badges = [];
                if (p.id === chatActiveId) badges.push('<span class="tw-prompt-badge tw-prompt-badge-chat" title="채팅 탭에서 활성">💬</span>');
                if (p.id === batchActiveId) badges.push('<span class="tw-prompt-badge tw-prompt-badge-batch" title="배치 탭에서 활성">📦</span>');
                const badgeHtml = badges.length ? `<span class="tw-prompt-badges">${badges.join('')}</span>` : '';
                return `<div class="tw-settings-list-item ${p.id === currentEditingId ? 'active' : ''}"
                              data-id="${escapeHtml(String(p.id))}">
                          <span class="tw-prompt-list-name">${escapeHtml(p.name)}</span>
                          ${badgeHtml}
                        </div>`;
            }).join('');
            $$('.tw-settings-list-item', listEl).forEach(item => {
                item.addEventListener('click', () => {
                    currentEditingId = item.dataset.id;
                    const p = prompts.find(x => x.id === currentEditingId);
                    nameInput.value = p.name;
                    contentTextarea.value = p.content;
                    $$('.tw-settings-list-item', listEl).forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                });
            });
            const p = prompts.find(x => x.id === currentEditingId) || prompts[0];
            currentEditingId = p.id;
            nameInput.value = p.name;
            contentTextarea.value = p.content;
        }
        refresh();

        $('.tw-btn-settings-close', overlay).addEventListener('click', () => {
            overlay.remove();
            renderAllPromptSelects(modalEl);
        });

        $('.tw-btn-settings-new', overlay).addEventListener('click', () => {
            const prompts = loadPrompts();
            const newId = `p_${Date.now()}`;
            prompts.push({ id: newId, name: '새 프롬프트', content: '' });
            savePrompts(prompts);
            currentEditingId = newId;
            refresh();
            nameInput.focus();
        });

        $('.tw-btn-settings-save', overlay).addEventListener('click', () => {
            const name = nameInput.value.trim() || '이름 없음';
            const content = contentTextarea.value;
            const prompts = loadPrompts();
            const p = prompts.find(x => x.id === currentEditingId);
            if (p) {
                p.name = name;
                p.content = content;
                savePrompts(prompts);
                refresh();
                toast('저장됨', 'success');
            }
        });

        $('.tw-btn-settings-delete', overlay).addEventListener('click', async () => {
            const prompts = loadPrompts();
            if (prompts.length <= 1) {
                toast('최소 1개의 프롬프트는 유지해야 합니다.', 'error');
                return;
            }

            // 삭제 대상이 채팅·배치에서 활성인지 점검
            const activeIn = [];
            if (getChatActivePromptId() === currentEditingId) activeIn.push('채팅');
            if (getBatchActivePromptId() === currentEditingId) activeIn.push('배치');

            const targetName = nameInput.value || '(이름 없음)';
            let confirmMsg = `'${targetName}' 프롬프트를 삭제하시겠습니까?`;
            if (activeIn.length) {
                confirmMsg = `⚠️ '${targetName}' 프롬프트는 현재 ${activeIn.join('과 ')} 탭에서 활성입니다.\n` +
                    `삭제하면 첫 번째 프롬프트로 자동 전환됩니다.\n\n` +
                    `계속 삭제하시겠습니까?`;
            }

            const okDeletePrompt = await twConfirm({
                title: '프롬프트 삭제',
                message: confirmMsg,
                danger: true,
            });
            if (!okDeletePrompt) return;

            const filtered = prompts.filter(x => x.id !== currentEditingId);
            savePrompts(filtered);
            // 채팅·배치 활성 ID가 삭제 대상이면 각각 첫 번째 프롬프트로 폴백
            if (getChatActivePromptId() === currentEditingId) {
                setChatActivePromptId(filtered[0].id);
            }
            if (getBatchActivePromptId() === currentEditingId) {
                setBatchActivePromptId(filtered[0].id);
            }
            currentEditingId = filtered[0].id;
            refresh();
            // 폴백된 활성 ID가 메인 모달의 드롭다운에도 반영되도록
            renderAllPromptSelects(modalEl);
            toast(activeIn.length ? '삭제됨. 활성 프롬프트가 변경되었습니다.' : '삭제됨', 'success');
        });

        // ==== 세션 관리 탭 ====
        function refreshSessionStats() {
            const ws = getWorkspaceStats();
            const sStats = getSessionStats(); // 가장 오래된 세션 정보용
            const statBody = $('.tw-stat-body', overlay);
            // LS quota 추정 (브라우저별 5~10MB. 5MB 기준 게이지 표시)
            const lsQuotaBytes = 5 * 1024 * 1024;
            const pct = Math.min(100, Math.round((ws.lsBytes / lsQuotaBytes) * 100));
            const overrideCell = ws.orphanOverrideEntryCount > 0
                ? `${ws.overrideCount}개 <span class="tw-ws-warn-badge" title="${ws.orphanOverrideRunCount}개 run의 ${ws.orphanOverrideEntryCount}개 override가 고아">⚠ orphan ${ws.orphanOverrideEntryCount}</span>`
                : `${ws.overrideCount}개`;
            statBody.innerHTML = `
                <div class="tw-stat-row"><span class="tw-stat-label">💬 채팅 세션</span><span class="tw-stat-value">${ws.sessionCount}개</span></div>
                <div class="tw-stat-row"><span class="tw-stat-label">📝 시스템 프롬프트</span><span class="tw-stat-value">${ws.promptCount}개</span></div>
                <div class="tw-stat-row"><span class="tw-stat-label">🧪 Batch Run</span><span class="tw-stat-value">${ws.runCount}개</span></div>
                <div class="tw-stat-row"><span class="tw-stat-label">✂ Override</span><span class="tw-stat-value">${overrideCell}</span></div>
                <div class="tw-stat-row"><span class="tw-stat-label">가장 오래된 세션</span><span class="tw-stat-value">${sStats.oldestDays}일 전</span></div>
                <div class="tw-stat-row"><span class="tw-stat-label">로컬스토리지 사용량</span><span class="tw-stat-value">${ws.lsKb} KB <span style="color:#666">(~${pct}% / 5MB)</span></span></div>
                <div class="tw-ws-quota-bar"><div class="tw-ws-quota-bar-fill" style="width:${pct}%"></div></div>
            `;
        }

        // v0.7.9: Batch Run 표 렌더
        function refreshRunsTable() {
            const body = $('.tw-ws-runs-body', overlay);
            if (!body) return;
            const runs = (() => { try { return loadBatchRuns(); } catch { return {}; } })();
            const overrides = (() => { try { return loadReviewOverrides(); } catch { return {}; } })();
            const activeId = getActiveBatchRunId();
            const ids = Object.keys(runs).sort((a, b) => {
                const ta = String(runs[a]?.updatedAt || runs[a]?.createdAt || '');
                const tb = String(runs[b]?.updatedAt || runs[b]?.createdAt || '');
                return tb.localeCompare(ta);
            });
            if (!ids.length) {
                body.innerHTML = `<div class="tw-ws-empty">배치 run이 없습니다.</div>`;
                return;
            }
            const rows = ids.map(id => {
                const r = runs[id] || {};
                const isActive = id === activeId;
                const created = String(r.createdAt || '').slice(0, 19).replace('T', ' ');
                const status = escapeHtml(String(r.status || '?'));
                const segCount = Array.isArray(r.segments) ? r.segments.length : (r.phase45?.parsed?.length || r.phase3?.parsed?.length || 0);
                const ovCount = overrides[id] ? Object.keys(overrides[id]).length : 0;
                const sizeKb = (() => {
                    try { return (new Blob([JSON.stringify(r)]).size / 1024).toFixed(1); } catch { return '?'; }
                })();
                const labelHtml = r.label ? `<div style="color:#aaa;font-size:11px">${escapeHtml(String(r.label))}</div>` : '';
                return `
                <tr class="${isActive ? 'tw-ws-row-active' : ''}" data-run-id="${escapeHtml(id)}">
                    <td><div style="font-family:monospace;font-size:11px">${escapeHtml(id)}</div>${labelHtml}</td>
                    <td>${escapeHtml(created)}</td>
                    <td>${status}</td>
                    <td style="text-align:right">${segCount}</td>
                    <td style="text-align:right">${ovCount}</td>
                    <td style="text-align:right">${sizeKb} KB</td>
                    <td>
                        <div class="tw-ws-actions">
                            ${isActive ? '<button type="button" class="tw-btn tw-btn-ghost tw-btn-ws-run-activate is-active" data-run-id="' + escapeHtml(id) + '" disabled title="이미 활성 run">✓ 활성</button>' : '<button type="button" class="tw-btn tw-btn-ghost tw-btn-ws-run-activate" data-run-id="' + escapeHtml(id) + '">🔁 활성</button>'}
                            <button type="button" class="tw-btn tw-btn-ghost tw-btn-ws-run-export" data-run-id="${escapeHtml(id)}" title="이 run 1개만 export">📤</button>
                            <button type="button" class="tw-btn tw-btn-danger tw-btn-ws-run-delete" data-run-id="${escapeHtml(id)}">🗑</button>
                        </div>
                    </td>
                </tr>`;
            }).join('');
            body.innerHTML = `
            <table class="tw-ws-table">
                <thead><tr>
                    <th>Run ID</th><th>생성</th><th>상태</th><th style="text-align:right">행</th>
                    <th style="text-align:right">override</th><th style="text-align:right">크기</th><th>액션</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
        }

        // v0.7.9: Override 표 렌더 (run별)
        function refreshOverridesTable() {
            const body = $('.tw-ws-overrides-body', overlay);
            if (!body) return;
            const overrides = (() => { try { return loadReviewOverrides(); } catch { return {}; } })();
            const runs = (() => { try { return loadBatchRuns(); } catch { return {}; } })();
            const ids = Object.keys(overrides);
            if (!ids.length) {
                body.innerHTML = `<div class="tw-ws-empty">override가 없습니다.</div>`;
                return;
            }
            const rows = ids.sort().map(id => {
                const bucket = overrides[id] || {};
                const n = Object.keys(bucket).length;
                const orphan = !runs[id];
                return `
                <tr class="${orphan ? 'tw-ws-row-orphan' : ''}" data-run-id="${escapeHtml(id)}">
                    <td><div style="font-family:monospace;font-size:11px">${escapeHtml(id)}</div></td>
                    <td style="text-align:right">${n}개</td>
                    <td>${orphan ? '<span class="tw-ws-warn-badge">고아 (run 없음)</span>' : '<span style="color:#4ade80;font-size:11px">✓ run 존재</span>'}</td>
                    <td>
                        <div class="tw-ws-actions">
                            <button type="button" class="tw-btn tw-btn-danger tw-btn-ws-override-clear" data-run-id="${escapeHtml(id)}" title="이 run의 override 전부 삭제">🗑 비우기</button>
                        </div>
                    </td>
                </tr>`;
            }).join('');
            body.innerHTML = `
            <table class="tw-ws-table">
                <thead><tr><th>Run ID</th><th style="text-align:right">개수</th><th>상태</th><th>액션</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
        }

        // v0.7.9: IDB 자동 백업 슬롯 표 렌더
        async function refreshSlotsTable() {
            const body = $('.tw-ws-slots-body', overlay);
            if (!body) return;
            body.innerHTML = `<div class="tw-ws-empty">로딩 중…</div>`;
            let all = [];
            try { all = await readAllBackupSlots(); } catch (e) {
                body.innerHTML = `<div class="tw-ws-empty">IDB 접근 실패: ${escapeHtml(String(e?.message || e))}</div>`;
                return;
            }
            if (!all.length) {
                body.innerHTML = `<div class="tw-ws-empty">자동 백업 슬롯이 비어 있습니다.</div>`;
                return;
            }
            all.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
            const rows = all.map(snap => {
                const slot = snap.slot ?? '?';
                const savedAt = String(snap.savedAt || '').slice(0, 19).replace('T', ' ');
                const trigger = escapeHtml(String(snap.trigger || '?'));
                const sCount = snap.sessions ? Object.keys(snap.sessions).length : 0;
                const oCount = snap.overrides ? Object.values(snap.overrides).reduce((s, b) => s + Object.keys(b || {}).length, 0) : 0;
                const rCount = snap.runs ? Object.keys(snap.runs).length : 0;
                const sizeKb = (() => {
                    try { return (new Blob([JSON.stringify(snap)]).size / 1024).toFixed(1); } catch { return '?'; }
                })();
                return `
                <tr data-slot="${slot}">
                    <td>#${slot}</td>
                    <td>${escapeHtml(savedAt) || '-'}</td>
                    <td>${trigger}</td>
                    <td style="text-align:right">${sCount} / ${rCount} / ${oCount}</td>
                    <td style="text-align:right">${sizeKb} KB</td>
                    <td>
                        <div class="tw-ws-actions">
                            <button type="button" class="tw-btn tw-btn-ghost tw-btn-ws-slot-download" data-slot="${slot}" title="JSON 다운로드">📤</button>
                            <button type="button" class="tw-btn tw-btn-danger tw-btn-ws-slot-restore" data-slot="${slot}" title="이 슬롯으로 LS 통째 덮어쓰기">♻ 복원</button>
                        </div>
                    </td>
                </tr>`;
            }).join('');
            body.innerHTML = `
            <table class="tw-ws-table">
                <thead><tr>
                    <th>Slot</th><th>저장 시각</th><th>Trigger</th>
                    <th style="text-align:right">세션 / run / override</th>
                    <th style="text-align:right">크기</th><th>액션</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
        }

        // v0.7.9: 워크스페이스 모든 패널 일괄 갱신
        function refreshWorkspaceUi() {
            try { refreshSessionStats(); } catch (e) { dwarn('stats refresh 실패', e); }
            try { refreshRunsTable(); } catch (e) { dwarn('runs refresh 실패', e); }
            try { refreshOverridesTable(); } catch (e) { dwarn('overrides refresh 실패', e); }
            refreshSlotsTable().catch(e => dwarn('slots refresh 실패', e));
        }

        // v0.7.9: Batch Run 섹션 이벤트 위임
        const runsSection = $('.tw-ws-runs-section', overlay);
        if (runsSection) {
            runsSection.addEventListener('click', async (e) => {
                const refresh = e.target.closest('.tw-btn-ws-runs-refresh');
                if (refresh) { refreshRunsTable(); refreshSessionStats(); return; }
                const prune = e.target.closest('.tw-btn-ws-runs-prune');
                if (prune) {
                    const dry = pruneOldRuns({ keepRecent: 10, maxAgeDays: 30, dryRun: true });
                    if (!dry.candidates.length) {
                        toast('정리 대상 run이 없습니다 (정책: 최근 10개 유지 / 30일 초과 / 활성·실행중 보호).', 'info');
                        return;
                    }
                    const sample = dry.candidates.slice(0, 5).map(c => `• ${c.id} (${c.status}, ${c.ageDays}일)`).join('\n');
                    const more = dry.candidates.length > 5 ? `\n…외 ${dry.candidates.length - 5}개` : '';
                    const ok = await twConfirm({
                        title: '오래된 run 정리',
                        message: `정책: 최근 10개 유지 / 30일 초과 / 활성·실행중 run 보호\n\n` +
                            `정리 대상 ${dry.candidates.length}개:\n${sample}${more}\n\n` +
                            `짝 override + 세션의 importedFromRunId도 함께 정리됩니다.\n계속하시겠습니까?`,
                        danger: true,
                    });
                    if (!ok) return;
                    const r = pruneOldRuns({ keepRecent: 10, maxAgeDays: 30, dryRun: false });
                    toast(`정리 완료: run ${r.removed} / override run ${r.removedOverrideRuns} / 세션 nullify ${r.nullifiedSessions}`, 'success');
                    refreshWorkspaceUi();
                    return;
                }
                const act = e.target.closest('.tw-btn-ws-run-activate');
                if (act) {
                    const rid = act.getAttribute('data-run-id');
                    setActiveBatchRunId(rid);
                    syncBatchRunFromLs();
                    toast(`run ${rid} 활성화`, 'success');
                    refreshRunsTable();
                    return;
                }
                const exp = e.target.closest('.tw-btn-ws-run-export');
                if (exp) {
                    const rid = exp.getAttribute('data-run-id');
                    const runs = loadBatchRuns();
                    const overrides = loadReviewOverrides();
                    const single = {
                        version: 3,
                        exported: new Date().toISOString(),
                        schemaVersion: CURRENT_SCHEMA_VERSION,
                        batchRuns: { [rid]: _stripRunForBackup(runs[rid] || {}) },
                        overrides: overrides[rid] ? { [rid]: overrides[rid] } : {},
                    };
                    downloadJson(JSON.stringify(single, null, 2), `tms_run_${rid}_${new Date().toISOString().slice(0,10)}.json`);
                    toast(`run ${rid} export 완료`, 'success');
                    return;
                }
                const del = e.target.closest('.tw-btn-ws-run-delete');
                if (del) {
                    const rid = del.getAttribute('data-run-id');
                    await onDeleteRun(rid);
                    refreshWorkspaceUi();
                    return;
                }
            });
        }

        // v0.7.9: Override 섹션 이벤트 위임
        const overridesSection = $('.tw-ws-overrides-section', overlay);
        if (overridesSection) {
            overridesSection.addEventListener('click', async (e) => {
                const prune = e.target.closest('.tw-btn-ws-overrides-prune');
                if (prune) {
                    const ws = getWorkspaceStats();
                    if (ws.orphanOverrideRunCount === 0) {
                        toast('고아 override가 없습니다.', 'info');
                        return;
                    }
                    const ok = await twConfirm({
                        title: '고아 override 정리',
                        message: `run이 없는 override를 정리합니다.\n\nrun ${ws.orphanOverrideRunCount}개 / override ${ws.orphanOverrideEntryCount}개\n\n계속하시겠습니까?`,
                        danger: true,
                    });
                    if (!ok) return;
                    const r = pruneOrphanOverrides();
                    toast(`정리 완료: run ${r.removedRuns}개 / override ${r.removedEntries}개`, 'success');
                    refreshOverridesTable();
                    refreshSessionStats();
                    return;
                }
                const clr = e.target.closest('.tw-btn-ws-override-clear');
                if (clr) {
                    const rid = clr.getAttribute('data-run-id');
                    const ok = await twConfirm({
                        title: 'override 비우기',
                        message: `run ${rid} 의 override를 모두 삭제합니다.\n\n계속하시겠습니까?`,
                        danger: true,
                    });
                    if (!ok) return;
                    const n = clearOverridesForRun(rid);
                    toast(`override ${n}개 삭제됨`, 'success');
                    refreshOverridesTable();
                    refreshSessionStats();
                    // review 패널 열려 있으면 갱신
                    if (typeof renderReviewTable === 'function' && currentMainTab === 'review') {
                        try { renderReviewTable(); } catch {}
                    }
                    return;
                }
            });
        }

        // v0.7.9: IDB 슬롯 섹션 이벤트 위임
        const slotsSection = $('.tw-ws-slots-section', overlay);
        if (slotsSection) {
            slotsSection.addEventListener('click', async (e) => {
                const refresh = e.target.closest('.tw-btn-ws-slots-refresh');
                if (refresh) { refreshSlotsTable(); return; }
                const snap = e.target.closest('.tw-btn-ws-slots-snapshot');
                if (snap) {
                    triggerBackupAsync('manual');
                    toast('IDB 백업을 시작했습니다 (백그라운드).', 'info');
                    setTimeout(() => refreshSlotsTable(), 400);
                    return;
                }
                const dl = e.target.closest('.tw-btn-ws-slot-download');
                if (dl) {
                    const slot = Number(dl.getAttribute('data-slot'));
                    try {
                        const all = await readAllBackupSlots();
                        const s = all.find(x => x && x.slot === slot);
                        if (!s) { toast(`slot ${slot} 비어 있음`, 'warn'); return; }
                        downloadJson(JSON.stringify(s, null, 2), `tms_idb_slot${slot}_${(s.savedAt || '').slice(0,10)}.json`);
                        toast(`slot ${slot} 다운로드`, 'success');
                    } catch (err) { toast(`다운로드 실패: ${err.message}`, 'error'); }
                    return;
                }
                const rs = e.target.closest('.tw-btn-ws-slot-restore');
                if (rs) {
                    const slot = Number(rs.getAttribute('data-slot'));
                    const ok = await twConfirm({
                        title: 'IDB 슬롯 복원',
                        message: `slot ${slot} 의 스냅샷으로 LS의 sessions / overrides / batchRuns 를 통째 덮어씁니다.\n\n현재 데이터는 사라집니다 (복원 직전 IDB에 자동 1회 백업 후 진행).\n\n계속하시겠습니까?`,
                        danger: true,
                    });
                    if (!ok) return;
                    try {
                        triggerBackupAsync('pre-restore'); // 안전망
                        await new Promise(r => setTimeout(r, 200));
                        const r = await restoreFromBackupSlot(slot, 'overwrite');
                        toast(`복원 완료: 세션 ${r.sessions} / run ${r.runs} / override ${r.overrides}`, 'success');
                        refreshWorkspaceUi();
                        // 활성 run 메모리 동기화
                        try { syncBatchRunFromLs(); renderBatchRun(); } catch {}
                    } catch (err) { toast(`복원 실패: ${err.message}`, 'error'); }
                    return;
                }
            });
        }

        $('.tw-btn-session-prune', overlay).addEventListener('click', () => {
            const removed = pruneExpiredSessions();
            if (removed > 0) {
                toast(`오래된 세션 ${removed}개 삭제됨`, 'success');
            } else {
                toast(`${SESSION_TTL_DAYS}일 이상 된 세션이 없습니다.`, 'info');
            }
            refreshSessionStats();
        });

        // v0.7.10: export 체크박스 매트릭스 + 프리셋
        const exportMatrix = $('.tw-ws-export-matrix', overlay);
        function getExportMatrix() {
            const get = (key) => {
                const el = exportMatrix && exportMatrix.querySelector(`input[data-export-key="${key}"]`);
                return !!(el && el.checked);
            };
            return {
                sessions: get('sessions'),
                prompts: get('prompts'),
                batchRuns: get('batchRuns'),
                overrides: get('overrides'),
                stripRaw: get('stripRaw'),
            };
        }
        function setExportMatrix(state) {
            for (const [k, v] of Object.entries(state)) {
                const el = exportMatrix && exportMatrix.querySelector(`input[data-export-key="${k}"]`);
                if (el) el.checked = !!v;
            }
        }
        function refreshExportMatrixCounts() {
            if (!exportMatrix) return;
            const ws = (() => { try { return getWorkspaceStats(); } catch { return null; } })();
            if (!ws) return;
            const counts = {
                sessions: ws.sessionCount,
                prompts: ws.promptCount,
                batchRuns: ws.runCount,
                overrides: ws.overrideCount,
            };
            for (const [k, v] of Object.entries(counts)) {
                const el = exportMatrix.querySelector(`[data-count="${k}"]`);
                if (el) el.textContent = `(${v})`;
            }
        }
        refreshExportMatrixCounts();
        // 매트릭스 카운트는 워크스페이스 진입 시 한 번 더 갱신되도록 refreshWorkspaceUi에 hook
        const _origRefreshWs = refreshWorkspaceUi;
        refreshWorkspaceUi = function patchedRefreshWorkspaceUi() {
            try { _origRefreshWs(); } catch (e) { dwarn('ws refresh 실패', e); }
            try { refreshExportMatrixCounts(); } catch {}
        };

        $('.tw-btn-export-selected', overlay).addEventListener('click', () => {
            const m = getExportMatrix();
            if (!m.sessions && !m.prompts && !m.batchRuns && !m.overrides) {
                toast('백업할 항목을 1개 이상 선택하세요.', 'warn');
                return;
            }
            const json = exportSessionsJson({
                includeSessions: m.sessions,
                includePrompts: m.prompts,
                includeBatchRuns: m.batchRuns,
                includeOverrides: m.overrides,
                stripRawSegments: m.stripRaw,
            });
            const parts = [];
            if (m.sessions) parts.push('s');
            if (m.prompts) parts.push('p');
            if (m.batchRuns) parts.push('r');
            if (m.overrides) parts.push('o');
            const tag = parts.join('') || 'empty';
            const fname = `tms_backup_${tag}_${new Date().toISOString().slice(0,10)}.json`;
            downloadJson(json, fname);
            const labels = [];
            if (m.sessions) labels.push('세션');
            if (m.prompts) labels.push('프롬프트');
            if (m.batchRuns) labels.push('run');
            if (m.overrides) labels.push('override');
            toast(`백업 다운로드: ${labels.join(' + ')}` + (m.batchRuns && m.stripRaw ? ' (raw 제외)' : ''), 'success');
        });

        overlay.querySelectorAll('.tw-btn-export-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.getAttribute('data-preset');
                if (preset === 'sessions') {
                    setExportMatrix({ sessions: true, prompts: false, batchRuns: false, overrides: false });
                } else if (preset === 'sessions+prompts') {
                    setExportMatrix({ sessions: true, prompts: true, batchRuns: false, overrides: false });
                } else if (preset === 'workspace') {
                    setExportMatrix({ sessions: true, prompts: true, batchRuns: true, overrides: true });
                }
                toast(`프리셋 적용: ${btn.textContent.trim()}`, 'info');
            });
        });

        function downloadJson(json, filename) {
            const blob = new Blob([json], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
        }

        const importFileInput = $('.tw-session-import-file', overlay);
        $('.tw-btn-session-import', overlay).addEventListener('click', () => {
            importFileInput.click();
        });
        importFileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                const preview = JSON.parse(text);
                const hasSessions = !!preview.sessions;
                const hasPrompts = !!preview.prompts;
                const hasOverrides = !!preview.overrides; // v0.7.8 (#2)
                const hasBatchRuns = !!preview.batchRuns; // v0.7.8 (#2)
                const sessionCount = hasSessions ? Object.keys(preview.sessions).length : 0;
                const promptCount = hasPrompts ? preview.prompts.length : 0;
                const overrideCount = hasOverrides
                    ? Object.values(preview.overrides).reduce((s, b) => s + Object.keys(b || {}).length, 0)
                    : 0;
                const batchRunCount = hasBatchRuns ? Object.keys(preview.batchRuns).length : 0;

                if (!hasSessions && !hasPrompts && !hasOverrides && !hasBatchRuns) {
                    toast('유효하지 않은 백업 파일입니다.', 'error');
                    importFileInput.value = '';
                    return;
                }

                // v0.7.10: 항목별 신규/덮어쓸/동일 카운트 미리보기
                let diff = null;
                try { diff = diffImportPreview(preview); } catch (e) { dwarn('diff 실패', e); }
                const fmtDiff = (label, total, d) => {
                    if (!d) return `• ${label} ${total}개`;
                    return `• ${label} ${total}개 → 신규 ${d.added} / 덮어쓸 ${d.overwrite} / 동일 ${d.same}`;
                };
                const previewLines = [];
                if (hasSessions) previewLines.push(fmtDiff('세션', sessionCount, diff && diff.sessions));
                if (hasPrompts) previewLines.push(fmtDiff('프롬프트', promptCount, diff && diff.prompts));
                if (hasBatchRuns) previewLines.push(fmtDiff('batch run', batchRunCount, diff && diff.batchRuns));
                if (hasOverrides) previewLines.push(fmtDiff('override entry', overrideCount, diff && diff.overrides));

                // 사용자에게 복원 범위 선택 요청
                let restorePrompts = false;
                if (hasPrompts) {
                    restorePrompts = await twConfirm({
                        title: '프롬프트 복원 여부',
                        message: `이 백업에는 다음이 포함되어 있습니다:\n\n` + previewLines.join('\n') +
                            `\n\n프롬프트도 함께 복원하시겠습니까?`,
                        confirmLabel: '세션 + 프롬프트',
                        cancelLabel: '세션만',
                    });
                }

                // v0.7.8 (#2): workspace 백업이면 overrides/batchRuns 복원 여부 추가 prompt
                let restoreOverrides = false;
                let restoreBatchRuns = false;
                if (hasOverrides || hasBatchRuns) {
                    restoreBatchRuns = await twConfirm({
                        title: '워크스페이스 복원 여부',
                        message: `이 백업에 포함된 워크스페이스 데이터를 복원하시겠습니까?\n\n` +
                            (hasBatchRuns ? fmtDiff('batch run', batchRunCount, diff && diff.batchRuns) + ' (raw segment 제외)\n' : '') +
                            (hasOverrides ? fmtDiff('override entry', overrideCount, diff && diff.overrides) + '\n' : '') +
                            `\n기존 데이터는 동일 키 기준으로 덮어씌워집니다.`,
                        confirmLabel: '복원',
                        cancelLabel: '건너뜀',
                        danger: true,
                    });
                    restoreOverrides = restoreBatchRuns && hasOverrides;
                }

                // 세션 복원 최종 확인 — diff 요약 재표시
                if (hasSessions) {
                    const lines = [];
                    if (diff && diff.sessions) {
                        lines.push(fmtDiff('세션', sessionCount, diff.sessions));
                    } else {
                        lines.push(`세션 ${sessionCount}개`);
                    }
                    if (restorePrompts) lines.push(fmtDiff('프롬프트', promptCount, diff && diff.prompts));
                    if (restoreBatchRuns) lines.push(fmtDiff('batch run', batchRunCount, diff && diff.batchRuns));
                    if (restoreOverrides) lines.push(fmtDiff('override entry', overrideCount, diff && diff.overrides));
                    const msg = lines.join('\n') + `\n\n동일 키는 덮어쓰기됩니다 (값이 같으면 변화 없음).\n계속하시겠습니까?`;
                    const okRestore = await twConfirm({ title: '복원 확인', message: msg, danger: true });
                    if (!okRestore) {
                        importFileInput.value = '';
                        return;
                    }
                }

                const result = importSessionsJson(text, {
                    restoreSessions: hasSessions,
                    restorePrompts: restorePrompts,
                    restoreOverrides: restoreOverrides,
                    restoreBatchRuns: restoreBatchRuns,
                });

                const parts = [];
                if (result.sessionsCount > 0) parts.push(`세션 ${result.sessionsCount}개`);
                if (result.promptsCount > 0) parts.push(`프롬프트 ${result.promptsCount}개`);
                if (result.batchRunsCount > 0) parts.push(`batch run ${result.batchRunsCount}개`);
                if (result.overridesCount > 0) parts.push(`override ${result.overridesCount}개`);
                toast(`복원 완료: ${parts.join(', ')}`, 'success');

                refreshSessionStats();
                // 프롬프트도 복원됐으면 드롭다운 갱신
                if (result.promptsCount > 0) {
                    renderAllPromptSelects(modalEl);
                    refresh(); // 프롬프트 편집 화면도 갱신
                }
            } catch (err) {
                toast('복원 실패: ' + err.message, 'error');
                console.error('[TMS-WF] import error', err);
            }
            importFileInput.value = '';
        });

        $('.tw-btn-session-clear-all', overlay).addEventListener('click', async () => {
            const stats = getSessionStats();
            if (stats.count === 0) {
                toast('삭제할 세션이 없습니다.', 'info');
                return;
            }
            const ok = await twConfirm({
                title: '모든 세션 삭제',
                message: `정말로 ${stats.count}개의 모든 세션을 삭제하시겠습니까?\n\n⚠️ 세션만 삭제되며 시스템 프롬프트는 보존됩니다.\n이 작업은 되돌릴 수 없습니다.`,
                danger: true,
            });
            if (!ok) return;
            clearAllSessions();
            toast('모든 세션이 삭제되었습니다. (프롬프트는 보존됨)', 'success');
            refreshSessionStats();
            if (currentStringId) renderChatHistory();
        });

        // 초기화 시 통계 로드
        refreshWorkspaceUi();
    }

    // ========================================================================
    // 단축키 등록 (Alt+Z)
    // ========================================================================
    document.addEventListener('keydown', (e) => {
        // Alt+Z (Mac에선 Option+Z, key가 'Ω'일 수 있음)
        const isAltZ = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
                       (e.key === 'z' || e.key === 'Z' || e.key === 'Ω' || e.code === 'KeyZ');
        if (!isAltZ) return;

        const tgt = e.target;
        const inOwnModal = modalEl && modalEl.contains(tgt);

        // 정책 C: 번역 입력창(textarea)은 허용, 다른 입력 필드는 차단
        if (!inOwnModal) {
            const isInput = tgt.tagName === 'INPUT' || tgt.isContentEditable;
            const isOtherTextarea = tgt.tagName === 'TEXTAREA';
            // INPUT이면 차단 (검색창 등)
            if (isInput) {
                dverbose('Alt+Z - INPUT/contentEditable이라 무시:', tgt.tagName);
                return;
            }
            // TEXTAREA는 허용 (번역 입력창에서 바로 호출 가능)
            // 우리 모달 안의 textarea도 이 경로로 들어오지 않음 (inOwnModal=true라 위에서 걸림)
            if (isOtherTextarea) {
                dverbose('Alt+Z - TEXTAREA에서 호출 허용');
            }
        }

        e.preventDefault();
        e.stopPropagation();

        dverbose('Alt+Z 감지 → 모달 토글 시도');
        try {
            if (modalEl && modalEl.style.display !== 'none' && !modalEl.classList.contains('tw-hidden')) {
                dverbose('모달 숨기기');
                hideModal();
            } else {
                dverbose('모달 열기 시도');
                showModal().catch(err => {
                    console.error('[TMS-WF] showModal 실패:', err);
                    alert('TMS Workflow 모달 오픈 실패: ' + err.message);
                });
            }
        } catch (err) {
            console.error('[TMS-WF] 에러:', err);
            alert('TMS Workflow 에러: ' + err.message);
        }
    }, true);

    // 진단용: window에 함수 노출
    window.tmsWorkflow = {
        open: () => showModal(),
        close: () => hideModal(),
        getCurrentStringId: () => getCurrentStringId(true),
        getParams: () => getUrlParams(),
        getSegment: async (id) => {
            const sid = id || getCurrentStringId();
            if (!sid) return null;
            return await fetchSegmentDetail(sid);
        },
    };

    // v0.6.6 (D3): node 테스트 환경에서만 내부 순수 함수를 노출 (브라우저에서는 영향 없음)
    if (typeof globalThis !== 'undefined' && globalThis.__TMS_TEST_HOOK__) {
        globalThis.__TMS_TEST_EXPORTS__ = {
            // validators
            validatePhase3Compact, validatePhase45Compact, computeTranslationWarnings,
            extractPlaceholders, analyzeIdCoverage, normalizeId,
            // diff
            diffWords, tokenizeForDiff, renderDiffHtml,
            // override LS
            getReviewOverride, setReviewOverride, clearReviewOverride,
            loadReviewOverrides, saveReviewOverrides, countReviewOverridesForRun,
            gcOrphanReviewOverrides,
            // v0.6.7 (C2/C3/D1): export/compare/log 헬퍼
            findPriorRunsForCurrent, buildRunCompareRows,
            buildCsvFromRun, buildJsonExportFromRun,
            buildFilteredLogLines,
            // v0.6.9 (G1-d): 배치 패널 카드 통계
            buildBatchSummaryStats,
            // misc
            escapeHtml, LS_KEYS,
        };
    }

    console.log('%c[TMS Workflow v0.6.9] 로드됨. Alt+Z로 모달 오픈 (배치 패널 가시성: Run 헤더 + Phase stepper + 수집/검증 카드 → 검토 탭 점프)', 'background:#4ade80;color:#000;padding:2px 6px;border-radius:3px');
    console.log('%c[TMS Workflow] 진단: window.tmsWorkflow.open() / .getCurrentStringId() / .getParams()', 'color:#888');
})();
