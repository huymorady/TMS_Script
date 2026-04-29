// ==UserScript==
// @name         TMS CAT Tool - 대화형 번역 워크플로우
// @namespace    https://github.com/huymorady/TMS_Script
// @version      0.6.6
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
    };

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
    // 실제 사용되는 batchRun.status는 5개만 존재. 이전 워크플로우에서 설정했던 phase_*,
    // reviewing, apply_ready, bedrock_timeout, model_endpoint_error 등 dead state는 제거.
    // 향후 새 상태 추가 시 이 맵과 isBatchBusy() 면절 메소드도 함께 업데이트할 것.
    const BATCH_STATUS_LABELS = {
        idle: '대기 중',
        collecting: '수집 중',
        ready: '수집 완료',
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
        // 폴백: 간단한 자체 토스트
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = `
            position:fixed; top:20px; right:20px; z-index:999999;
            padding:10px 16px; border-radius:6px; color:#fff;
            font-size:13px; font-family:system-ui;
            background:${type === 'error' ? '#e74c3c' : type === 'success' ? '#27ae60' : '#3498db'};
            box-shadow:0 4px 12px rgba(0,0,0,0.2);
        `;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), ms);
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
            const snippet = String(text || '').slice(0, 200).replace(/\s+/g, ' ').trim();
            const looksLikeLogin = /<form[^>]*login|<title[^>]*\bsign\s*in|csrf|\u767b\u5f55|\ub85c\uadf8\uc778/i.test(text);
            const hint = looksLikeLogin ? ' (로그인 세션 만료 가능성)' : '';
            throw new Error(`API 응답이 JSON이 아닙니다 [${res.status}] content-type=${contentType || 'none'}${hint}: ${snippet}`);
        }

        let data;
        try {
            data = await res.json();
        } catch (error) {
            throw new Error(`API JSON 파싱 실패 [${res.status}]: ${error.message}`);
        }
        if (!res.ok || data.result === false) {
            throw new Error(`API 오류: ${res.status} ${data.message || ''}`);
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
                console.log(`[TMS-WF] #${stringId} string-item에서 번역 textarea 발견`);
                return explicitTextarea;
            }
        }

        // 1순위: 활성 string-item 내부의 번역 textarea
        const activeItem = findActiveStringItem();
        if (activeItem) {
            // .info-row 안의 번역 textarea (우측 번역 패널)
            const ta = findTranslationTextareaInItem(activeItem);
            if (ta) {
                console.log('[TMS-WF] 활성 string-item에서 번역 textarea 발견');
                return ta;
            }
        }

        // 2순위: 현재 포커스된 textarea (사용자가 방금 클릭한 것)
        const focused = document.activeElement;
        if (focused && focused.tagName === 'TEXTAREA' &&
            !modalEl?.contains(focused) && !focused.readOnly && !focused.disabled) {
            console.log('[TMS-WF] 포커스된 textarea 사용');
            return focused;
        }

        console.warn('[TMS-WF] 활성 번역 textarea를 찾지 못함');
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
            console.log(`[TMS-WF] ${SESSION_TTL_DAYS}일 이상 된 세션 ${removed}개 자동 정리됨`);
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

    // Export: 세션만 / 프롬프트만 / 전체 선택 가능
    function exportSessionsJson(opts = {}) {
        const { includeSessions = true, includePrompts = false } = opts;
        const data = {
            version: 2,
            exported: new Date().toISOString(),
        };
        if (includeSessions) data.sessions = loadSessions();
        if (includePrompts) data.prompts = loadPrompts();
        return JSON.stringify(data, null, 2);
    }

    // Import: 세션과 프롬프트를 선택적으로 복원
    // 반환: { sessionsCount, promptsCount, hasSessions, hasPrompts }
    function importSessionsJson(jsonStr, opts = {}) {
        const {
            restoreSessions = true,
            restorePrompts = false,
            mergeSessions = false, // true면 기존 세션에 병합, false면 덮어쓰기
        } = opts;

        const data = JSON.parse(jsonStr);
        const hasSessions = !!data.sessions;
        const hasPrompts = !!data.prompts;
        if (!hasSessions && !hasPrompts) {
            throw new Error('잘못된 형식: sessions 또는 prompts 필드가 없습니다.');
        }

        let sessionsCount = 0;
        let promptsCount = 0;

        if (restoreSessions && hasSessions) {
            if (mergeSessions) {
                const existing = loadSessions();
                const merged = { ...existing, ...data.sessions };
                saveSessions(merged);
            } else {
                saveSessions(data.sessions);
            }
            sessionsCount = Object.keys(data.sessions).length;
        }

        if (restorePrompts && hasPrompts) {
            savePrompts(data.prompts);
            promptsCount = data.prompts.length;
        }

        return { sessionsCount, promptsCount, hasSessions, hasPrompts };
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
            if (verbose) console.warn('[TMS-WF] 활성 .string-item을 찾지 못함');
            return null;
        }

        const stringId = extractStringIdFromItem(activeItem);
        if (stringId) {
            if (verbose) {
                console.log(`[TMS-WF] 활성 세그먼트 string_id: ${stringId} (DOM row#${activeItem.id})`);
            }
            return stringId;
        }

        if (verbose) {
            console.warn('[TMS-WF] data-key에서 string_id 추출 실패:', activeItem.dataset?.key);
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
    }
    function clearReviewOverride(runId, stringId) {
        if (!runId) return;
        const all = loadReviewOverrides();
        const bucket = all[runId];
        if (!bucket) return;
        delete bucket[normalizeId(stringId)];
        if (!Object.keys(bucket).length) delete all[runId];
        saveReviewOverrides(all);
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
        run.updatedAt = new Date().toISOString();
        const runs = loadBatchRuns();
        runs[run.runId] = run;
        saveBatchRuns(runs);
        setActiveBatchRunId(run.runId);
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
    const reviewView = { filter: 'all', sort: 'id' };

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
            <div class="tw-batch-status">대기 중</div>
        </div>
        <div class="tw-batch-card">
            <div class="tw-context-label">파일 정보</div>
            <div class="tw-batch-file-info tw-context-value">아직 수집 전입니다.</div>
        </div>
        <div class="tw-batch-card">
            <div class="tw-context-label">검증 요약</div>
            <div class="tw-batch-validation tw-context-value">Phase 결과가 여기에 표시됩니다.</div>
        </div>
        <div class="tw-batch-warning tw-muted"></div>
        <div class="tw-context-label">수집 세그먼트</div>
        <div class="tw-batch-segments"></div>
    </div>
    <div class="tw-batch-chat-panel">
        <div class="tw-batch-timeline"></div>
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
    <div class="tw-review-summary tw-muted">아직 Phase 3 결과가 없습니다.</div>
    <div class="tw-review-toolbar">
        <button class="tw-btn tw-btn-primary tw-btn-review-apply-selected">선택 입력</button>
        <button class="tw-btn tw-btn-ghost tw-btn-review-apply-edited" title="Phase 4+5에서 수정된 행만 일괄 입력">수정만 입력</button>
        <button class="tw-btn tw-btn-ghost tw-btn-review-apply-all">전체 입력</button>
        <span class="tw-review-filter-group">
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
        </span>
        <span class="tw-review-apply-status tw-muted">입력은 textarea 값 주입까지만 수행합니다.</span>
        <button class="tw-btn tw-btn-ghost tw-btn-review-gc" title="현재 활성 batch run 외에 남아있는 직접 수정 데이터 정리">override 정리</button>
    </div>
    <div class="tw-review-table"></div>
</div>
<div class="tw-log-panel tw-tab-content" data-tab-content="logs">
    <div class="tw-log-header">
        <div class="tw-panel-title">JSON/로그</div>
        <button class="tw-btn tw-btn-ghost tw-btn-log-copy">📋 전체 복사</button>
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

        return el;
    }

    function injectStyles() {
        if ($('#tms-workflow-styles')) return;
        const style = document.createElement('style');
        style.id = 'tms-workflow-styles';
        style.textContent = `
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
    display: flex; align-items: center; padding: 10px 14px;
    background: #2a2a2a; border-bottom: 1px solid #3a3a3a;
    border-radius: 10px 10px 0 0; cursor: move; user-select: none;
    flex-shrink: 0;
}
.tw-title { font-weight: 600; color: #4ade80; margin-right: 12px; }
.tw-seg-info { flex: 1; color: #888; font-size: 12px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
.tw-header-right { display: flex; gap: 4px; }
.tw-main-tabs {
    display: flex; gap: 4px; padding: 8px 10px 0;
    background: #202020; border-bottom: 1px solid #333;
    flex-shrink: 0;
}
.tw-main-tab {
    background: transparent; color: #999; border: 1px solid transparent;
    border-bottom: none; padding: 7px 12px; border-radius: 6px 6px 0 0;
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
    width: 280px; flex-shrink: 0; padding: 12px;
    border-right: 1px solid #3a3a3a; overflow-y: auto;
    background: #252525;
}
.tw-panel-title { font-weight: 600; color: #4ade80; margin-bottom: 10px; font-size: 12px; }
.tw-context-content { font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.tw-muted { color: #888; }
.tw-context-section { margin-bottom: 12px; }
.tw-context-label { color: #4ade80; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.tw-context-value { background: #1a1a1a; padding: 6px 8px; border-radius: 4px; color: #ddd; }
.tw-chat-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.tw-chat-messages { flex: 1; overflow-y: auto; padding: 14px; }
.tw-msg { margin-bottom: 14px; max-width: 90%; word-wrap: break-word; }
.tw-msg-user { margin-left: auto; }
.tw-msg-ai { margin-right: auto; }
.tw-msg-role { font-size: 11px; color: #888; margin-bottom: 4px; }
.tw-msg-user .tw-msg-role { text-align: right; }
.tw-msg-content { padding: 10px 14px; border-radius: 8px; white-space: pre-wrap;
    line-height: 1.5; }
.tw-msg-user .tw-msg-content { background: #2563eb; color: #fff; }
.tw-msg-ai .tw-msg-content { background: #2a2a2a; color: #e0e0e0; border: 1px solid #3a3a3a; }
.tw-msg-system .tw-msg-content { background: transparent; color: #888; font-style: italic;
    text-align: center; padding: 4px; font-size: 11px; }
.tw-msg-system { max-width: 100%; }
.tw-msg-progress { color: #fbbf24; }
.tw-chat-input-wrap { padding: 10px 12px; border-top: 1px solid #3a3a3a;
    background: #252525; flex-shrink: 0; }
.tw-input-controls { display: flex; gap: 12px; margin-bottom: 8px; font-size: 12px; color: #aaa; }
.tw-ctrl { display: flex; align-items: center; gap: 6px; }
.tw-prompt-select, .tw-model-select {
    background: #1a1a1a; color: #e0e0e0; border: 1px solid #3a3a3a;
    padding: 4px 8px; border-radius: 4px; font-size: 12px; min-width: 140px;
}
.tw-chat-input {
    width: 100%; min-height: 70px; max-height: 180px; resize: vertical;
    background: #1a1a1a; color: #e0e0e0; border: 1px solid #3a3a3a;
    border-radius: 6px; padding: 8px 10px; font-size: 13px; font-family: inherit;
    line-height: 1.4;
}
.tw-chat-input:focus { outline: none; border-color: #4ade80; }
.tw-chat-buttons { display: flex; gap: 8px; justify-content: flex-end;
    margin-top: 8px; align-items: center; }
.tw-btn-reset { margin-right: auto; }
.tw-review-panel, .tw-log-panel {
    flex-direction: column; padding: 14px; gap: 12px; background: #202020;
}
.tw-batch-panel {
    flex-direction: row; padding: 0; gap: 0; background: #202020; min-width: 0;
}
.tw-batch-sidebar {
    width: 290px; flex-shrink: 0; padding: 12px; border-right: 1px solid #3a3a3a;
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
    padding: 10px 12px; border-top: 1px solid #3a3a3a;
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
    min-height: 20px; color: #fbbf24; background: #2a2212; border: 1px solid #5a4214;
    border-radius: 6px; padding: 8px 10px;
}
.tw-batch-warning:empty { display: none; }
.tw-batch-segments {
    flex: 1; overflow: auto; background: #181818; border: 1px solid #333;
    border-radius: 6px; padding: 10px; font-size: 12px; line-height: 1.5;
}
.tw-review-summary { flex-shrink: 0; }
.tw-review-toolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px; border: 1px solid #333; border-radius: 8px;
    background: linear-gradient(135deg, #202820 0%, #181818 70%);
}
.tw-review-apply-status { margin-left: auto; font-size: 12px; }
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
/* v0.6.6 (B3): warn-only chip (final 셀에 부착) */
.tw-review-warn-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.tw-review-warn-chip {
    display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 9999px;
    font-size: 11px; font-weight: 500; line-height: 1.4; cursor: help;
    background: rgba(250, 204, 21, 0.14); color: #fde047; border: 1px solid rgba(250, 204, 21, 0.35);
}
.tw-review-warn-chip.tw-review-warn-tb { background: rgba(244, 114, 182, 0.14); color: #f9a8d4; border-color: rgba(244, 114, 182, 0.35); }
.tw-review-warn-chip.tw-review-warn-order { background: rgba(96, 165, 250, 0.14); color: #93c5fd; border-color: rgba(96, 165, 250, 0.35); }
.tw-review-table {
    flex: 1; overflow: auto; border: 1px solid #333; border-radius: 10px; background: #151515;
}
.tw-review-row {
    display: grid; grid-template-columns: 34px 78px 54px minmax(120px, 0.8fr) minmax(130px, 0.95fr) minmax(120px, 0.85fr) minmax(150px, 1fr) 178px;
    gap: 8px; padding: 10px 12px; border-bottom: 1px solid #303030; align-items: start;
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
.tw-review-flag-chip.tw-review-flag-edit { background: #2a1f33; color: #d8b4fe; border-color: #4a2f5a; }
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
@container (max-width: 760px) {
    .tw-context-panel { width: 220px; }
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
            `<option value="${p.id}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
        ).join('');
        selectEl.onchange = () => syncChatPromptSelects(selectEl.value);
    }

    function renderBatchPromptSelect(selectEl) {
        if (!selectEl) return;
        const prompts = loadPrompts();
        const activeId = getBatchActivePromptId();
        selectEl.innerHTML = prompts.map(p =>
            `<option value="${p.id}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
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

        // 설정 버튼
        $('.tw-btn-settings', el).addEventListener('click', showSettingsPanel);

        $('.tw-btn-batch-collect', el).addEventListener('click', onBatchCollect);
        $('.tw-btn-phase12', el).addEventListener('click', () => onRunBatchPhase('1+2'));
        $('.tw-btn-phase3', el).addEventListener('click', () => onRunBatchPhase('3'));
        $('.tw-btn-phase45', el).addEventListener('click', () => onRunBatchPhase('4+5'));
        $('.tw-btn-batch-refetch', el).addEventListener('click', onBatchRefetchResult);
        $('.tw-btn-batch-reset', el).addEventListener('click', onBatchReset);
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

        $('.tw-review-table', el).addEventListener('click', async (e) => {
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
                    if (!confirm(`#${id} 직접 수정을 되돌리고 배치 결과로 복원하시겠습니까?`)) return;
                    clearReviewOverride(run.runId, id);
                    appendBatchLog(`#${id} 직접 수정 되돌림`, 'info');
                    renderReviewTable();
                }
                return;
            }
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

    function renderBatchRun() {
        if (!modalEl) return;
        const run = batchRun || restoreActiveBatchRun();
        if (run && !batchRun) batchRun = run;

        const statusEl = $('.tw-batch-status', modalEl);
        const fileInfoEl = $('.tw-batch-file-info', modalEl);
        const validationEl = $('.tw-batch-validation', modalEl);
        const warningEl = $('.tw-batch-warning', modalEl);
        const segmentsEl = $('.tw-batch-segments', modalEl);
        if (!statusEl || !fileInfoEl || !validationEl || !warningEl || !segmentsEl) return;

        if (!run) {
            statusEl.textContent = '대기 중';
            fileInfoEl.textContent = '아직 수집 전입니다.';
            validationEl.textContent = 'Phase 결과가 여기에 표시됩니다.';
            warningEl.textContent = '';
            segmentsEl.innerHTML = '<span class="tw-muted">현재 페이지 수집을 먼저 실행하세요.</span>';
            updateBatchButtons(null);
            renderBatchTimeline(null);
            renderLogOutput();
            renderReviewTable();
            return;
        }

        statusEl.textContent = BATCH_STATUS_LABELS[run.status] || run.status || '대기 중';
        fileInfoEl.textContent = [
            `projectId=${run.projectId} / fileId=${run.fileId} / languageId=${run.languageId}`,
            `page=${run.page} / pageSize=${run.pageSize}`,
            `segments=${run.segments?.length || 0}`,
            `storageStringId=${run.storageStringId || '-'}`,
            `model=${run.model || '-'}`,
        ].join('\n');

        validationEl.textContent = [
            `Phase 1+2: ${formatPhaseValidation(run.phase12?.validation)}`,
            `Phase 3: ${formatPhaseValidation(run.phase3?.validation)}`,
            `Phase 4+5: ${formatPhaseValidation(run.phase45?.validation)}`,
            run.lastError ? `마지막 오류: ${run.lastError}` : null,
        ].filter(Boolean).join('\n');

        warningEl.textContent = run.storageStringId
            ? `주의: Phase 실행 결과는 storageStringId ${run.storageStringId}의 번역 칸에 저장됩니다. 테스트 후 수동 정리가 필요해요.`
            : '';

        if (run.segments?.length) {
            const preview = run.segments.slice(0, 12).map(seg => {
                const text = String(seg.origin_string || '').replace(/\s+/g, ' ').slice(0, 80);
                return `<div><b>#${escapeHtml(seg.id)}</b> ${escapeHtml(text)}</div>`;
            }).join('');
            const rest = run.segments.length > 12 ? `<div class="tw-muted">... 외 ${run.segments.length - 12}개</div>` : '';
            segmentsEl.innerHTML = preview + rest;
        } else {
            segmentsEl.innerHTML = '<span class="tw-muted">현재 페이지 수집을 먼저 실행하세요.</span>';
        }

        updateBatchButtons(run);
        renderBatchTimeline(run);
        renderLogOutput();
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

    function onBatchReset() {
        const run = batchRun || restoreActiveBatchRun();
        if (run) {
            const ok = confirm(
                '현재 배치 실행 기록(JSON/로그/검증 상태)을 초기화할까요?\n\n' +
                '이미 TMS 번역 칸에 저장된 storageStringId 결과는 삭제되지 않습니다.'
            );
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

        const logLines = (run.logs || []).map(log => `[${log.at}] ${log.type.toUpperCase()} ${log.message}`);
        const jsonBlocks = [];
        if (run.lastError) jsonBlocks.push(`\n\n=== Last error ===\n${run.lastError}`);
        if (run.validations && Object.keys(run.validations).length) {
            jsonBlocks.push(`\n\n=== Validation object ===\n${JSON.stringify(run.validations, null, 2)}`);
        }
        if (run.phase12?.raw) jsonBlocks.push(`\n\n=== Phase 1+2 raw ===\n${run.phase12.raw}`);
        if (run.phase3?.raw) jsonBlocks.push(`\n\n=== Phase 3 raw ===\n${run.phase3.raw}`);
        if (run.phase45?.raw) jsonBlocks.push(`\n\n=== Phase 4+5 raw ===\n${run.phase45.raw}`);
        output.textContent = (logLines.join('\n') || '아직 로그가 없습니다.') + jsonBlocks.join('');
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
            console.error('[TMS-WF] log copy 실패', error);
            toast('클립보드 복사 실패: ' + error.message, 'error');
        }
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

    // v0.6.2: 최종 후보 인라인 수정 — 해당 행의 최종 후보 셀을 textarea로 전환
    function openInlineFinalEditor(stringId) {
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
            console.warn('[TMS-WF] applied-from-batch 기록 실패', err);
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
        // v0.6.5: 입력 후 applied 배지/필터 갱신
        if (success > 0 || failures.length > 0) renderReviewTable();
    }

    // v0.6.6 (B1): 고아 override 정리 클릭 핸들러
    function onReviewOverrideGc() {
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
        const msg = `직접 수정 데이터 정리\n` +
            `- 알려지지 않은 run: ${orphanRunIds.length}개 (항목 ${orphanItems}개)\n` +
            (prunedActive ? `- 활성 run 내 phase3에 없는 항목: ${prunedActive}개\n` : '') +
            `\n총 ${removableItems}개 항목을 삭제합니다. 진행하시겠습니까?`;
        if (!confirm(msg)) return;
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
            if (!confirm(`#${id}에 이미 ${existing.messages.length}개의 chat 메시지가 있습니다.\n배치 결과로 새로 시드하면 기존 대화는 사라집니다. 계속하시겠습니까?`)) {
                return;
            }
        }

        try {
            importBatchResultToChat(id, run);
        } catch (err) {
            toast(`시드 실패: ${err.message}`, 'error');
            return;
        }

        currentStringId = id;
        try { await loadSegmentInfo(id); } catch (err) { console.warn('[TMS-WF] loadSegmentInfo 실패', err); }
        setMainTab('chat');
        renderChatHistory();
        appendBatchLog(`#${id} chat 다듬기 모드로 시드됨`, 'info');
        toast(`#${id} chat 다듬기 모드로 전환됨`, 'success');
    }

    function renderReviewTable() {
        if (!modalEl) return;
        const summaryEl = $('.tw-review-summary', modalEl);
        const tableEl = $('.tw-review-table', modalEl);
        if (!summaryEl || !tableEl) return;
        const run = batchRun || restoreActiveBatchRun();

        if (!run?.phase3?.parsed) {
            summaryEl.textContent = '아직 Phase 3 결과가 없습니다.';
            tableEl.innerHTML = '';
            return;
        }
        if (!run.phase3.validation?.ok) {
            summaryEl.textContent = 'Phase 3 검증이 실패해 결과 검토를 표시하지 않습니다. JSON/로그 탭에서 세부 오류를 확인하세요.';
            tableEl.innerHTML = '';
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
        const filtered = descriptors.filter(d => {
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
        const filterTag = reviewView.filter !== 'all' ? ` · 필터(${reviewView.filter}) ${shownCount}/${totalCount}` : '';
        // v0.6.6 (B3): warn 요약
        const warnTotals = {
            charLimit: warnCharLimitIds.size,
            order: warnOrderIds.size,
            tb: warnTbIds.size,
        };
        const warnTag = (warnTotals.charLimit + warnTotals.order + warnTotals.tb) > 0
            ? ` · ⚠ 길이 ${warnTotals.charLimit} / 순서 ${warnTotals.order} / 용어 ${warnTotals.tb}`
            : '';
        summaryEl.textContent = `번역 ${translations.length}개 · Phase 4+5 ${usePhase45 ? `수정 ${changedCount}개` : '미적용 또는 검증 실패'} · ${appliedSummary}${warnTag}${filterTag}`;
        const rows = filtered.map(d => {
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
<div class="tw-review-row" data-row-id="${escapeHtml(id)}">
    <div class="tw-review-cell tw-review-check" data-label="선택"><input class="tw-review-select" type="checkbox" data-id="${escapeHtml(id)}"></div>
    <div class="tw-review-cell" data-label="ID">#${escapeHtml(id)}${chatBadge}${appliedBadge}</div>
    <div class="tw-review-cell" data-label="그룹">${escapeHtml(item.gid || '')}</div>
    <div class="tw-review-cell tw-review-source tw-review-text" data-label="원문">${escapeHtml(seg?.origin_string || '')}</div>
    <div class="tw-review-cell tw-review-text" data-label="Phase 3">${escapeHtml(item.t || '')}</div>
    <div class="tw-review-cell" data-label="Phase 4+5">${revisionHtml}<span class="${flagChipClass}">${escapeHtml(flagChipText)}</span></div>
    <div class="tw-review-cell" data-label="최종 후보"><div class="tw-review-final-wrap" data-final-id="${escapeHtml(id)}"><div class="tw-review-final-view tw-review-text">${escapeHtml(finalText)}</div>${overrideChip}${warnChipsHtml}</div></div>
    <div class="tw-review-cell tw-review-actions" data-label="동작"><button class="tw-btn tw-btn-primary tw-btn-apply-final" data-id="${escapeHtml(id)}" title="현재 textarea에 입력">입력</button><button class="tw-btn tw-btn-ghost tw-btn-edit-final" data-id="${escapeHtml(id)}" title="최종 후보를 직접 수정">✏️</button><button class="tw-btn tw-btn-ghost tw-btn-copy-final" data-id="${escapeHtml(id)}" title="최종 후보 복사">📋</button><button class="tw-btn tw-btn-ghost tw-btn-chat-refine" data-id="${escapeHtml(id)}" title="chat 탭에서 다듬기">💬</button>${hasOverride ? `<button class="tw-btn tw-btn-ghost tw-btn-revert-final" data-id="${escapeHtml(id)}" title="직접 수정 되돌리기">↺</button>` : ''}</div>
</div>`;
        }).join('');

        tableEl.innerHTML = `
<div class="tw-review-row tw-review-head">
    <div><input class="tw-review-select-all" type="checkbox" title="전체 선택"></div><div>ID</div><div>그룹</div><div>원문</div><div>Phase 3</div><div>Phase 4+5</div><div>최종 후보</div><div>동작</div>
</div>${rows}`;
        updateReviewApplyStatus('입력은 textarea 값 주입까지만 수행합니다.');
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
                const ok = confirm(
                    `이 run에 직접 수정한 최종 후보가 ${overrideCount}개 있습니다.\n` +
                    `Phase ${phaseTag}을(를) 다시 실행하면 새 결과가 표시되지만 직접 수정값은 유지되어 우선 적용됩니다.\n` +
                    `계속하시겠습니까? (취소하면 실행이 중단됩니다)`
                );
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
                console.log(`[TMS-WF] 세그먼트 변경 감지: ${currentStringId} → ${newId}`);
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
    <div class="tw-context-value">${seg.char_limit}자</div>
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
        if (session.system && session.source === 'batch_import') {
            const tag = session.importedFromRunId ? ` (run ${session.importedFromRunId})` : '';
            appendMessage('system', `📦 배치 결과로 시드됨${tag} — 아래 후보를 출발점으로 요청을 입력하세요.`);
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
        msg.innerHTML = `
${label ? `<div class="tw-msg-role">${label}</div>` : ''}
<div class="tw-msg-content">${escapeHtml(content)}</div>`;
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
                console.log('[TMS-WF] sanitize:', { before: rawResult, after: result });
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

    function onResetSession() {
        if (!currentStringId) return;
        if (!confirm('현재 세그먼트의 대화 이력을 초기화하시겠습니까?\n(번역 자체는 삭제되지 않습니다)')) return;
        clearSession(currentStringId);
        renderChatHistory();
        toast('세션 초기화됨', 'success');
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
            console.log('[TMS-WF] textarea 주입 완료:', translation.slice(0, 50) + '...');
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
            <button class="tw-settings-tab" data-tab="sessions">💾 세션 관리</button>
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
            <div class="tw-stat-title">🧹 세션 관리</div>
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
        <div class="tw-session-actions">
            <div class="tw-stat-title">📦 백업 · 복원</div>
            <div class="tw-session-buttons">
                <button class="tw-btn tw-btn-ghost tw-btn-export-sessions">
                    📤 세션만 백업
                </button>
                <button class="tw-btn tw-btn-ghost tw-btn-export-all">
                    📤 전체 백업 (세션 + 프롬프트)
                </button>
                <button class="tw-btn tw-btn-ghost tw-btn-session-import">
                    📥 JSON에서 복원
                </button>
            </div>
            <div class="tw-stat-hint">💡 복원 시 JSON에 포함된 내용만 덮어씁니다 (세션만 있으면 프롬프트는 보존).</div>
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
                if (tab === 'sessions') refreshSessionStats();
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
                              data-id="${p.id}">
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

        $('.tw-btn-settings-delete', overlay).addEventListener('click', () => {
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

            if (!confirm(confirmMsg)) return;

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
            const stats = getSessionStats();
            const statBody = $('.tw-stat-body', overlay);
            statBody.innerHTML = `
                <div class="tw-stat-row">
                    <span class="tw-stat-label">저장된 세션</span>
                    <span class="tw-stat-value">${stats.count}개</span>
                </div>
                <div class="tw-stat-row">
                    <span class="tw-stat-label">총 크기</span>
                    <span class="tw-stat-value">${stats.sizeKb} KB</span>
                </div>
                <div class="tw-stat-row">
                    <span class="tw-stat-label">가장 오래된 세션</span>
                    <span class="tw-stat-value">${stats.oldestDays}일 전</span>
                </div>
            `;
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

        // 세션만 백업
        $('.tw-btn-export-sessions', overlay).addEventListener('click', () => {
            const json = exportSessionsJson({ includeSessions: true, includePrompts: false });
            downloadJson(json, `tms_sessions_${new Date().toISOString().slice(0,10)}.json`);
            toast('세션 백업 파일 다운로드됨 (프롬프트 제외)', 'success');
        });

        // 전체 백업 (세션 + 프롬프트)
        $('.tw-btn-export-all', overlay).addEventListener('click', () => {
            const json = exportSessionsJson({ includeSessions: true, includePrompts: true });
            downloadJson(json, `tms_backup_full_${new Date().toISOString().slice(0,10)}.json`);
            toast('전체 백업 파일 다운로드됨 (세션 + 프롬프트)', 'success');
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
                const sessionCount = hasSessions ? Object.keys(preview.sessions).length : 0;
                const promptCount = hasPrompts ? preview.prompts.length : 0;

                if (!hasSessions && !hasPrompts) {
                    toast('유효하지 않은 백업 파일입니다.', 'error');
                    importFileInput.value = '';
                    return;
                }

                // 사용자에게 복원 범위 선택 요청
                let restorePrompts = false;
                if (hasPrompts) {
                    restorePrompts = confirm(
                        `이 백업에는 다음이 포함되어 있습니다:\n` +
                        (hasSessions ? `• 세션 ${sessionCount}개\n` : '') +
                        `• 시스템 프롬프트 ${promptCount}개\n\n` +
                        `⚠️ 프롬프트도 함께 복원하시겠습니까?\n` +
                        `  [확인] = 세션 + 프롬프트 모두 복원\n` +
                        `  [취소] = 세션만 복원 (기존 프롬프트 보존)`
                    );
                }

                // 세션 복원 최종 확인
                if (hasSessions) {
                    const msg = restorePrompts
                        ? `세션 ${sessionCount}개와 프롬프트 ${promptCount}개를 복원합니다.\n기존 데이터는 덮어씌워집니다.`
                        : `세션 ${sessionCount}개를 복원합니다.\n(기존 프롬프트는 보존됩니다)\n기존 세션은 덮어씌워집니다.`;
                    if (!confirm(msg)) {
                        importFileInput.value = '';
                        return;
                    }
                }

                const result = importSessionsJson(text, {
                    restoreSessions: hasSessions,
                    restorePrompts: restorePrompts,
                });

                const parts = [];
                if (result.sessionsCount > 0) parts.push(`세션 ${result.sessionsCount}개`);
                if (result.promptsCount > 0) parts.push(`프롬프트 ${result.promptsCount}개`);
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

        $('.tw-btn-session-clear-all', overlay).addEventListener('click', () => {
            const stats = getSessionStats();
            if (stats.count === 0) {
                toast('삭제할 세션이 없습니다.', 'info');
                return;
            }
            if (!confirm(`정말로 ${stats.count}개의 모든 세션을 삭제하시겠습니까?\n\n⚠️ 세션만 삭제되며 시스템 프롬프트는 보존됩니다.\n이 작업은 되돌릴 수 없습니다.`)) return;
            clearAllSessions();
            toast('모든 세션이 삭제되었습니다. (프롬프트는 보존됨)', 'success');
            refreshSessionStats();
            if (currentStringId) renderChatHistory();
        });

        // 초기화 시 통계 로드
        refreshSessionStats();
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
                console.log('[TMS-WF] Alt+Z - INPUT/contentEditable이라 무시:', tgt.tagName);
                return;
            }
            // TEXTAREA는 허용 (번역 입력창에서 바로 호출 가능)
            // 우리 모달 안의 textarea도 이 경로로 들어오지 않음 (inOwnModal=true라 위에서 걸림)
            if (isOtherTextarea) {
                console.log('[TMS-WF] Alt+Z - TEXTAREA에서 호출 허용');
            }
        }

        e.preventDefault();
        e.stopPropagation();

        console.log('[TMS-WF] Alt+Z 감지 → 모달 토글 시도');
        try {
            if (modalEl && modalEl.style.display !== 'none' && !modalEl.classList.contains('tw-hidden')) {
                console.log('[TMS-WF] 모달 숨기기');
                hideModal();
            } else {
                console.log('[TMS-WF] 모달 열기 시도');
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
            // misc
            escapeHtml, LS_KEYS,
        };
    }

    console.log('%c[TMS Workflow v0.6.6] 로드됨. Alt+Z로 모달 오픈 (override GC + 추가 검증 룰 + chat 시드 강화)', 'background:#4ade80;color:#000;padding:2px 6px;border-radius:3px');
    console.log('%c[TMS Workflow] 진단: window.tmsWorkflow.open() / .getCurrentStringId() / .getParams()', 'color:#888');
})();
