// ==UserScript==
// @name         TMS CAT Tool - 대화형 번역 워크플로우
// @namespace    https://github.com/huymorady/TMS_Script
// @version      0.2.1
// @description  Alt+Z로 대화형 AI 번역 워크플로우 모달 오픈 (TMS의 prefix_prompt_tran API 활용)
// @match        https://tms.skyunion.net/*
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
        ACTIVE_PROMPT_ID: 'tms_workflow_active_prompt_v1',
        SESSIONS: 'tms_workflow_sessions_v1',
        MODEL: 'tms_workflow_model_v1',
        MODAL_POS: 'tms_workflow_modal_pos_v1',
        MODAL_SIZE: 'tms_workflow_modal_size_v1',
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
        };
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
        const data = await res.json();
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
        const data = await apiJson(
            `/api/translate/projects/${projectId}/prefix_prompt_tran/`,
            {
                method: 'POST',
                body: JSON.stringify({
                    language_id_list: [parseInt(getUrlParams().languageId, 10)],
                    string_id_list: [parseInt(stringId, 10)],
                    prefix_prompt: prefixPrompt,
                    is_associated: true,
                    model,
                }),
            }
        );
        return data.data.task_id;
    }

    async function pollTask(taskId, { maxAttempts = 20, interval = 5000, onProgress } = {}) {
        for (let i = 0; i < maxAttempts; i++) {
            await sleep(interval);
            const data = await apiJson(`/api/translate/task_results/${taskId}/`);
            const status = data.data.status;
            if (onProgress) onProgress(i + 1, status);
            if (status === 'SUCCESS') return data.data;
            if (status === 'FAILURE') throw new Error(`작업 실패: ${data.data.traceback || '알 수 없음'}`);
        }
        throw new Error('폴링 시간 초과 (100초)');
    }

    async function fetchActiveResult(stringId) {
        const seg = await fetchSegmentDetail(stringId);
        return seg?.active_result?.result || '';
    }

    // ========================================================================
    // 번역 입력창 탐색 & 값 주입 (SPA가 변경을 감지하도록)
    // ========================================================================

    // 현재 활성/선택된 세그먼트 row의 번역 입력 textarea 찾기
    // TMS는 Vue 기반으로 textarea가 동적으로 렌더됨. 여러 전략 시도.
    function findTranslationTextarea(stringId) {
        // 전략 1: 힌트 셀렉터로 직접 찾기
        for (const sel of TRANSLATION_TEXTAREA_HINTS) {
            const el = document.querySelector(sel);
            if (el && el.tagName === 'TEXTAREA') return el;
        }

        // 전략 2: 현재 포커스된 textarea (가장 확실)
        const focused = document.activeElement;
        if (focused && focused.tagName === 'TEXTAREA' &&
            !modalEl?.contains(focused)) {
            return focused;
        }

        // 전략 3: 화면에 보이는 textarea 중 원문이 아닌 것 (편집 가능한 것)
        const allTextareas = document.querySelectorAll('textarea');
        for (const ta of allTextareas) {
            if (modalEl?.contains(ta)) continue; // 우리 모달 내부는 제외
            if (ta.disabled || ta.readOnly) continue;
            // 화면에 보이는지 확인
            const rect = ta.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            return ta;
        }

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
        return sessions[stringId] || { messages: [], updated: Date.now() };
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
    function getActivePromptId() {
        return lsGet(LS_KEYS.ACTIVE_PROMPT_ID, 'default');
    }
    function setActivePromptId(id) {
        lsSet(LS_KEYS.ACTIVE_PROMPT_ID, id);
    }
    function getActivePrompt() {
        const prompts = loadPrompts();
        const id = getActivePromptId();
        return prompts.find(p => p.id === id) || prompts[0];
    }

    // ========================================================================
    // 현재 세그먼트 ID 추출
    // ========================================================================
    function getCurrentStringId() {
        // 전략 1: URL에서 active 세그먼트 힌트가 있으면 사용 (없는 듯)
        // 전략 2: DOM에서 '선택된' 세그먼트 찾기
        // TMS UI는 현재 선택된 세그먼트 row에 특정 클래스가 붙음.
        // 일반적으로 'active' 또는 'selected' 혹은 hover 상태.
        // 정확한 셀렉터는 기존 shortcuts 스크립트의 SEL 상수 참고.

        // 전략 3: 현재 focus된 textarea(번역 입력)의 속성 추적
        const focused = document.activeElement;
        if (focused && focused.tagName === 'TEXTAREA') {
            // textarea의 상위 row에서 string_id 추출 시도
            let row = focused.closest('tr, [data-string-id], [data-id]');
            while (row) {
                const id = row.dataset?.stringId || row.dataset?.id || row.id;
                if (id && /^\d+$/.test(id)) return parseInt(id, 10);
                // id가 'string-5829127' 같은 형태일 수도
                const m = (row.id || '').match(/(\d{5,})/);
                if (m) return parseInt(m[1], 10);
                row = row.parentElement?.closest('tr, [data-string-id], [data-id]');
            }
        }

        // 전략 4: 최근 results_history 조회 로그에서 추출 (API Logger 있으면)
        if (window.tmsLogs) {
            const recent = window.tmsLogs.all().slice(-50).reverse();
            for (const log of recent) {
                const url = log.url || '';
                const m = url.match(/belong_to=(\d+)/) || url.match(/\/strings\/(\d+)\//);
                if (m) return parseInt(m[1], 10);
            }
        }

        return null;
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
    function buildPrefixPrompt(systemPrompt, segmentContext, history, userMessage) {
        const sections = [];

        if (systemPrompt && systemPrompt.trim()) {
            sections.push(`=== 시스템 지침 ===\n${systemPrompt.trim()}`);
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
        sections.push(OUTPUT_RULE);

        return sections.join('\n\n---\n\n');
    }

    // ========================================================================
    // 모달 UI
    // ========================================================================
    let modalEl = null;
    let currentStringId = null;
    let currentSegment = null;

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
<div class="tw-body">
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
                    <select class="tw-prompt-select"></select>
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
.tw-settings-list { width: 200px; background: #252525; border-radius: 6px; padding: 8px;
    overflow-y: auto; }
.tw-settings-list-item {
    padding: 6px 10px; cursor: pointer; border-radius: 4px; margin-bottom: 2px;
    font-size: 12px; color: #ccc;
}
.tw-settings-list-item:hover { background: #2a2a2a; }
.tw-settings-list-item.active { background: #4ade80; color: #000; font-weight: 500; }
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
        // 프롬프트 셀렉트
        const promptSelect = $('.tw-prompt-select', el);
        renderPromptSelect(promptSelect);

        // 모델 셀렉트
        const modelSelect = $('.tw-model-select', el);
        modelSelect.innerHTML = MODELS.map(m =>
            `<option value="${m}">${m}</option>`).join('');
        modelSelect.value = lsGet(LS_KEYS.MODEL, MODELS[0]);
        modelSelect.addEventListener('change', () => lsSet(LS_KEYS.MODEL, modelSelect.value));
    }

    function renderPromptSelect(selectEl) {
        const prompts = loadPrompts();
        const activeId = getActivePromptId();
        selectEl.innerHTML = prompts.map(p =>
            `<option value="${p.id}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
        ).join('');
        selectEl.onchange = () => setActivePromptId(selectEl.value);
    }

    // ========================================================================
    // 이벤트 핸들러
    // ========================================================================
    function attachHandlers(el) {
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

    // ========================================================================
    // 모달 Show/Hide + 세그먼트 로드 + 자동 감지 폴링
    // ========================================================================
    let segmentWatcherId = null;

    // 모달 열린 동안 세그먼트 변경 자동 감지
    function startSegmentWatcher() {
        stopSegmentWatcher();
        segmentWatcherId = setInterval(async () => {
            if (!modalEl || modalEl.style.display === 'none') {
                stopSegmentWatcher();
                return;
            }
            const newId = getCurrentStringId();
            if (newId && newId !== currentStringId) {
                console.log(`[TMS-WF] 세그먼트 변경 감지: ${currentStringId} → ${newId}`);
                currentStringId = newId;
                try {
                    await loadSegmentInfo(newId);
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
    }

    async function showModal() {
        const stringId = getCurrentStringId();
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

        // 세션 복원
        renderChatHistory();

        // 자동 감지 폴링 시작
        startSegmentWatcher();

        // 입력창 포커스
        setTimeout(() => $('.tw-chat-input', el).focus(), 100);
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
            const activePrompt = getActivePrompt();
            const systemPrompt = activePrompt?.content || '';
            const segmentCtx = buildSegmentContext(currentSegment);

            // 대화 이력은 방금 추가한 user를 제외하고 과거만
            const history = session.messages.slice(0, -1);
            const prefixPrompt = buildPrefixPrompt(systemPrompt, segmentCtx, history, userMessage);

            // 콘솔에 최종 프롬프트 출력 (디버그)
            console.groupCollapsed('[TMS Workflow] prefix_prompt 전송');
            console.log(prefixPrompt);
            console.groupEnd();

            // API 호출
            const { projectId } = getUrlParams();
            const model = $('.tw-model-select', modalEl).value;

            updateProgressMessage(progressMsg, '⏳ 작업 등록 중…');
            const taskId = await callPrefixPromptTran(projectId, currentStringId, prefixPrompt, model);

            updateProgressMessage(progressMsg, '⏳ 처리 중… (5초 간격 폴링)');
            await pollTask(taskId, {
                onProgress: (n, status) => {
                    updateProgressMessage(progressMsg, `⏳ 처리 중… [${n}차] ${status}`);
                },
            });

            updateProgressMessage(progressMsg, '⏳ 결과 조회 중…');
            const result = await fetchActiveResult(currentStringId);

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
        let currentEditingId = getActivePromptId();

        const listEl = $('.tw-settings-list', overlay);
        const nameInput = $('.tw-prompt-name', overlay);
        const contentTextarea = $('.tw-prompt-content', overlay);

        function refresh() {
            const prompts = loadPrompts();
            listEl.innerHTML = prompts.map(p =>
                `<div class="tw-settings-list-item ${p.id === currentEditingId ? 'active' : ''}" 
                      data-id="${p.id}">${escapeHtml(p.name)}</div>`
            ).join('');
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
            renderPromptSelect($('.tw-prompt-select', modalEl));
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
            if (!confirm(`'${nameInput.value}' 프롬프트를 삭제하시겠습니까?`)) return;
            const filtered = prompts.filter(x => x.id !== currentEditingId);
            savePrompts(filtered);
            if (getActivePromptId() === currentEditingId) {
                setActivePromptId(filtered[0].id);
            }
            currentEditingId = filtered[0].id;
            refresh();
            toast('삭제됨', 'success');
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
                    renderPromptSelect($('.tw-prompt-select', modalEl));
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
        getCurrentStringId: () => getCurrentStringId(),
        getParams: () => getUrlParams(),
        getSegment: async (id) => {
            const sid = id || getCurrentStringId();
            if (!sid) return null;
            return await fetchSegmentDetail(sid);
        },
    };

    console.log('%c[TMS Workflow v0.2.1] 로드됨. Alt+Z로 모달 오픈', 'background:#4ade80;color:#000;padding:2px 6px;border-radius:3px');
    console.log('%c[TMS Workflow] 진단: window.tmsWorkflow.open() / .getCurrentStringId() / .getParams()', 'color:#888');
})();
