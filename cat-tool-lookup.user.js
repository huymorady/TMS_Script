// ==UserScript==
// @name         CAT Tool - 번역 조회 팝업
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Alt+Q → 팝업 열기/닫기 / Alt+W → 현재 세그먼트 매칭 삽입 / Alt+Shift+W → 전체 일괄 삽입
// @match        *://tms.skyunion.net/*
// @updateURL    https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-lookup.user.js
// @downloadURL  https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-lookup.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════
  //  상수 정의
  // ═══════════════════════════════════════

  const LOG_PREFIX = '[번역 조회]';

  // DOM 셀렉터
  const SEL = {
    ORIGIN: '.origin_string',
    TEXTAREA: 'textarea.n-input__textarea-el',
    ROW: '[data-v-9a359d1f]',
  };

  // sessionStorage 키
  const STORAGE_KEY = 'cat-lookup-data';

  // 헤더 별칭 (괄호 안 부가정보 — 예: "(zh-CN)", "(ko-KR)" — 는 자동 제거 후 비교)
  // 배열의 첫 번째 원소가 "대표 이름"으로 미리보기 등 UI에 표시됨
  const HEADER_ALIASES = {
    SOURCE: ['원문'],
    TARGET: ['번역문', '최종 수정안'],
  };

  // ═══════════════════════════════════════
  //  공통 유틸리티 함수
  // ═══════════════════════════════════════

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 앞뒤 따옴표 제거 ("..." 또는 '...') */
  function stripQuotes(s) {
    return s.replace(/^["']|["']$/g, '');
  }

  /**
   * 텍스트 정규화 (매칭용 키 생성)
   *
   * 다음 변형들을 모두 같은 키로 흡수해서 매칭 성공률을 높임:
   *  - <br> ↔ \n 통일
   *  - \r\n / \r → \n 통일
   *  - 빈 줄(연속된 \n) 압축 — 엑셀 원본의 <br>+\n 이중 줄바꿈 대응
   *  - 각 줄의 양 끝 공백 제거 — 엑셀 셀의 들여쓰기 공백, 줄 끝 trailing space 대응
   *  - 빈 줄 자체는 제거
   *
   * 단어 사이 공백은 보존 (의도적 차이를 흡수하지 않음)
   */
  function normalize(text) {
    return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line)
      .join('\n');
  }

  /**
   * 헤더 셀에서 괄호 안 부가정보를 제거하고 별칭과 비교
   * 예) "원문 (zh-CN)"  → "원문"     → SOURCE 매칭
   *     "최종 수정안 (ko-KR)" → "최종 수정안" → TARGET 매칭
   *     "번역문"        → "번역문"   → TARGET 매칭
   *
   * 괄호는 반각 () 와 전각 () 모두 인식.
   * 공백은 모두 단일 공백으로 압축한 뒤 양 끝 trim.
   */
  function matchHeaderAlias(cell, aliases) {
    if (!cell) return false;
    const normalized = cell
      .replace(/[\(（][^)）]*[\)）]/g, '') // 괄호와 그 내용 제거 (반각/전각 모두)
      .replace(/\s+/g, ' ')
      .trim();
    return aliases.some(alias => normalized === alias);
  }

  /**
   * 원문의 <br> 사용 패턴에 따라 번역문을 변환
   *
   * 1) 원문에 <br>이 텍스트로 노출되어 있으면:
   *    - 번역문의 <br>도 보존 (작성자가 의도적으로 노출시킨 마커)
   *    - 추가로 각 <br> 뒤에 진짜 줄바꿈도 삽입 → 원문의 시각적 줄 구조와 일치시킴
   *    - 단, 번역문에 이미 <br> 뒤에 줄바꿈이 있으면 중복 추가하지 않음
   *
   * 2) 원문에 <br>이 없으면 (진짜 줄바꿈만 있거나 단일 라인):
   *    - 기존처럼 <br> → \n으로 변환
   */
  function convertTranslationForOrigin(translation, origin) {
    const originHasBrText = origin && /<br\s*\/?>/i.test(origin);
    if (originHasBrText) {
      return translation.replace(/<br\s*\/?>(\r?\n)?/gi, (match, existingNewline) => {
        return existingNewline ? match : match + '\n';
      });
    }
    return translation.replace(/<br\s*\/?>/gi, '\n');
  }

  /** textarea 값 설정 (Vue/React 반응성 대응) */
  function setTextareaValue(textarea, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeSetter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 드래그 가능 패널 설정 */
  function makeDraggable(headerEl, panelEl) {
    let dragging = false, startX, startY, panelX, panelY;
    headerEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = panelEl.getBoundingClientRect();
      panelX = rect.left; panelY = rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panelEl.style.left = (panelX + e.clientX - startX) + 'px';
      panelEl.style.top = (panelY + e.clientY - startY) + 'px';
      panelEl.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  /** textarea에서 같은 행의 원문 찾기 */
  function findOriginForTextarea(textarea) {
    // 방법 1: DOM 구조 기반
    const row = textarea.closest(SEL.ROW)
      || textarea.closest('.n-input')?.parentElement?.parentElement;
    if (row) {
      const origin = row.querySelector(SEL.ORIGIN)
        || row.parentElement?.querySelector(SEL.ORIGIN);
      if (origin) return origin.textContent.trim();
    }

    // 방법 2: 인덱스 기반
    const allTextareas = document.querySelectorAll(SEL.TEXTAREA);
    const allOrigins = document.querySelectorAll(SEL.ORIGIN);
    const idx = Array.from(allTextareas).indexOf(textarea);
    if (idx >= 0 && idx < allOrigins.length) {
      return allOrigins[idx].textContent.trim();
    }

    return null;
  }

  // ═══════════════════════════════════════
  //  데이터 관리
  // ═══════════════════════════════════════

  let lookupData = {};       // 원본 키 → 번역문 (UI 표시용)
  let normalizedIndex = {};  // 정규화된 키 → 번역문 (매칭용)
  let dataCount = 0;

  /** lookupData에서 normalizedIndex 재구축 */
  function rebuildIndex() {
    normalizedIndex = {};
    for (const [key, value] of Object.entries(lookupData)) {
      const normKey = normalize(key);
      if (normKey) normalizedIndex[normKey] = value;
    }
  }

  /** sessionStorage 저장 */
  function saveToSession() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(lookupData));
    } catch (e) {
      console.log(`${LOG_PREFIX} sessionStorage 저장 실패`);
    }
  }

  /** sessionStorage에서 복원 */
  function restoreFromSession() {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        lookupData = JSON.parse(saved);
        dataCount = Object.keys(lookupData).length;
        rebuildIndex();
        console.log(`${LOG_PREFIX} sessionStorage에서 ${dataCount}건 복원`);
      }
    } catch (e) {
      console.log(`${LOG_PREFIX} sessionStorage 복원 실패`);
    }
  }

  /** 데이터 초기화 */
  function clearData() {
    lookupData = {};
    normalizedIndex = {};
    dataCount = 0;
    saveToSession();
    document.getElementById('cat-lookup-input').value = '';
    document.getElementById('cat-lookup-count').textContent = '0';
    document.getElementById('cat-lookup-status').textContent = '데이터가 초기화되었습니다.';
    document.getElementById('cat-lookup-preview').innerHTML = '';
    console.log(`${LOG_PREFIX} 데이터 초기화`);
  }

  /** 정규화 인덱스로 번역문 검색 (O(1)) */
  function findTranslation(sourceText) {
    // 1순위: 원본 키 완전 일치 (가장 빠른 경로)
    if (lookupData[sourceText]) return lookupData[sourceText];

    // 2순위: 정규화 인덱스 조회
    const normSource = normalize(sourceText);
    if (normalizedIndex[normSource]) return normalizedIndex[normSource];

    return null;
  }

  // 시작 시 데이터 복원
  restoreFromSession();

  // ═══════════════════════════════════════
  //  팝업 UI
  // ═══════════════════════════════════════

  const panel = document.createElement('div');
  panel.id = 'cat-lookup-panel';
  panel.innerHTML = `
    <div id="cat-lookup-header">
      <span id="cat-lookup-title">📋 번역 조회 (<span id="cat-lookup-count">0</span>건)</span>
      <div>
        <button id="cat-lookup-clear" title="데이터 초기화">🗑</button>
        <button id="cat-lookup-close" title="닫기">✕</button>
      </div>
    </div>
    <div id="cat-lookup-body">
      <textarea id="cat-lookup-input" wrap="off" placeholder="마크다운 테이블을 여기에 붙여넣기&#10;&#10;| Text_key | 원문 | 번역문 |&#10;| :--- | :--- | :--- |&#10;| key1 | 中文原文 | 한국어 번역 |"></textarea>
      <button id="cat-lookup-parse">파싱하기</button>
      <div id="cat-lookup-status"></div>
      <div id="cat-lookup-preview"></div>
    </div>
  `;

  // ─── 스타일 ───
  const style = document.createElement('style');
  style.textContent = `
    #cat-lookup-panel {
      display: none; position: fixed; top: 60px; right: 20px;
      width: 420px; max-height: 70vh; background: #2a2a2e;
      border: 1px solid #555; border-radius: 8px; z-index: 99999;
      font-family: -apple-system, sans-serif; font-size: 13px;
      color: #e0e0e0; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      flex-direction: column;
    }
    #cat-lookup-panel.visible { display: flex; }
    #cat-lookup-panel.collapsed #cat-lookup-body { display: none; }
    #cat-lookup-panel.collapsed { max-height: none; }
    #cat-lookup-body { display: flex; flex-direction: column; overflow: hidden; }
    #cat-lookup-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 14px; background: #3a3a3e; border-radius: 8px 8px 0 0;
      font-weight: bold; font-size: 14px; cursor: grab; user-select: none;
    }
    #cat-lookup-header:active { cursor: grabbing; }
    #cat-lookup-panel.collapsed #cat-lookup-header { border-radius: 8px; }
    #cat-lookup-title { cursor: pointer; }
    #cat-lookup-header button {
      background: none; border: none; color: #e0e0e0; cursor: pointer;
      font-size: 16px; padding: 2px 6px; border-radius: 4px;
    }
    #cat-lookup-header button:hover { background: #555; }
    #cat-lookup-input {
      margin: 10px 14px; height: 150px; background: #1e1e22;
      border: 1px solid #555; border-radius: 6px; color: #e0e0e0;
      padding: 10px; font-size: 12px; font-family: monospace;
      resize: vertical; white-space: pre; overflow-x: auto; word-wrap: normal;
    }
    #cat-lookup-input:focus { outline: none; border-color: #5ac8a0; }
    #cat-lookup-parse {
      margin: 0 14px 10px; padding: 8px; background: #5ac8a0;
      color: #1e1e22; border: none; border-radius: 6px;
      font-weight: bold; cursor: pointer; font-size: 13px;
    }
    #cat-lookup-parse:hover { background: #4ab890; }
    #cat-lookup-status { padding: 0 14px; font-size: 12px; color: #aaa; }
    #cat-lookup-preview {
      margin: 8px 14px 14px; max-height: 200px; overflow-y: auto; font-size: 11px;
    }
    #cat-lookup-preview table { width: 100%; border-collapse: collapse; }
    #cat-lookup-preview th, #cat-lookup-preview td {
      padding: 4px 8px; border: 1px solid #444; text-align: left;
    }
    #cat-lookup-preview th { background: #3a3a3e; font-size: 11px; }
    #cat-lookup-preview td { font-size: 11px; word-break: break-all; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  // ═══════════════════════════════════════
  //  UI 이벤트
  // ═══════════════════════════════════════

  // 드래그
  makeDraggable(document.getElementById('cat-lookup-header'), panel);

  // 접기/펼치기
  document.getElementById('cat-lookup-title').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  // 버튼 이벤트
  document.getElementById('cat-lookup-parse').addEventListener('click', parseInput);
  document.getElementById('cat-lookup-close').addEventListener('click', () => {
    panel.classList.remove('visible');
  });
  document.getElementById('cat-lookup-clear').addEventListener('click', clearData);

  // ═══════════════════════════════════════
  //  단축키
  // ═══════════════════════════════════════

  document.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey) return;

    // Alt+Shift+W: 전체 일괄 삽입
    if (e.shiftKey && (e.key === 'W' || e.key === 'w')) {
      e.preventDefault(); e.stopImmediatePropagation();
      insertAll();
      return;
    }

    if (e.shiftKey) return;

    // Alt+Q: 팝업 토글
    if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault(); e.stopImmediatePropagation();
      panel.classList.toggle('visible');
      if (panel.classList.contains('visible')) {
        document.getElementById('cat-lookup-input').focus();
      }
      return;
    }

    // Alt+W: 현재 세그먼트 매칭 삽입
    if (e.key === 'w' || e.key === 'W') {
      e.preventDefault(); e.stopImmediatePropagation();
      insertCurrent();
      return;
    }
  }, true);

  // ═══════════════════════════════════════
  //  기능: 마크다운 테이블 파싱
  // ═══════════════════════════════════════

  function parseInput() {
    const raw = document.getElementById('cat-lookup-input').value.trim();
    if (!raw) {
      document.getElementById('cat-lookup-status').textContent = '⚠ 내용을 붙여넣어 주세요.';
      return;
    }

    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
    if (lines.length < 2) {
      document.getElementById('cat-lookup-status').textContent = '⚠ 유효한 테이블을 찾을 수 없습니다.';
      return;
    }

    // 헤더 행에서 열 인덱스 자동 감지 (별칭 + 괄호 부가정보 허용)
    const headerCells = lines[0].split('|').map(c => c.trim()).filter(c => c !== '');
    let srcIdx = -1;
    let tgtIdx = -1;

    for (let i = 0; i < headerCells.length; i++) {
      if (srcIdx === -1 && matchHeaderAlias(headerCells[i], HEADER_ALIASES.SOURCE)) {
        srcIdx = i;
        continue;
      }
      if (tgtIdx === -1 && matchHeaderAlias(headerCells[i], HEADER_ALIASES.TARGET)) {
        tgtIdx = i;
      }
    }

    if (srcIdx === -1 || tgtIdx === -1) {
      const srcList = HEADER_ALIASES.SOURCE.join(' / ');
      const tgtList = HEADER_ALIASES.TARGET.join(' / ');
      document.getElementById('cat-lookup-status').textContent =
        `⚠ 헤더에서 원문 열(${srcList})과 번역문 열(${tgtList})을 찾을 수 없습니다.`;
      return;
    }

    let parsed = 0;
    const newData = {};

    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split('|').map(c => c.trim()).filter(c => c !== '');

      // 구분선(---) 건너뛰기
      if (cells.some(c => /^[-:]+$/.test(c))) continue;

      if (cells.length > Math.max(srcIdx, tgtIdx)) {
        const source = stripQuotes(cells[srcIdx]);
        const target = stripQuotes(cells[tgtIdx]);

        if (source && target) {
          newData[source] = target;
          parsed++;
        }
      }
    }

    // 기존 데이터에 추가
    Object.assign(lookupData, newData);
    dataCount = Object.keys(lookupData).length;
    rebuildIndex();
    saveToSession();

    document.getElementById('cat-lookup-count').textContent = dataCount;
    document.getElementById('cat-lookup-status').textContent =
      `✅ ${parsed}건 파싱 완료 (총 ${dataCount}건 저장) — 원문="${headerCells[srcIdx]}", 번역문="${headerCells[tgtIdx]}"`;

    updatePreview();

    console.log(`${LOG_PREFIX} ${parsed}건 파싱, 총 ${dataCount}건 저장 (헤더: "${headerCells[srcIdx]}" / "${headerCells[tgtIdx]}")`);
    if (window.catToast) window.catToast(`📋 ${parsed}건 파싱 완료 (총 ${dataCount}건)`);
  }

  // ═══════════════════════════════════════
  //  기능: 미리보기 테이블
  // ═══════════════════════════════════════

  function updatePreview() {
    const entries = Object.entries(lookupData);
    if (entries.length === 0) {
      document.getElementById('cat-lookup-preview').innerHTML = '';
      return;
    }

    const srcLabel = HEADER_ALIASES.SOURCE[0];
    const tgtLabel = HEADER_ALIASES.TARGET[0];

    let html = `<table><tr><th>${srcLabel}</th><th>${tgtLabel}</th></tr>`;
    const show = entries.slice(-20);
    for (const [src, tgt] of show) {
      html += `<tr><td>${escapeHtml(src)}</td><td>${escapeHtml(tgt)}</td></tr>`;
    }
    if (entries.length > 20) {
      html += `<tr><td colspan="2" style="text-align:center;color:#888;">... 외 ${entries.length - 20}건</td></tr>`;
    }
    html += '</table>';
    document.getElementById('cat-lookup-preview').innerHTML = html;
  }

  // ═══════════════════════════════════════
  //  기능: 매칭 삽입
  // ═══════════════════════════════════════

  function insertCurrent() {
    if (dataCount === 0) {
      console.log(`${LOG_PREFIX} 저장된 데이터가 없습니다.`);
      return;
    }

    const active = document.activeElement;
    if (!active || active.tagName !== 'TEXTAREA') {
      console.log(`${LOG_PREFIX} 번역 입력창에 포커스가 없습니다.`);
      return;
    }

    const sourceText = findOriginForTextarea(active);
    if (!sourceText) {
      console.log(`${LOG_PREFIX} 원문을 찾을 수 없습니다.`);
      return;
    }

    const translation = findTranslation(sourceText);
    if (!translation) {
      console.log(`${LOG_PREFIX} 매칭 실패: "${sourceText}"`);
      if (window.catToast) window.catToast(`❌ 매칭 실패: "${sourceText.substring(0, 20)}..."`);
      return;
    }

    setTextareaValue(active, convertTranslationForOrigin(translation, sourceText));
    console.log(`${LOG_PREFIX} 매칭 삽입: "${sourceText}" → "${translation}"`);
    if (window.catToast) window.catToast('✅ 매칭 삽입 완료');
  }

  function insertAll() {
    if (dataCount === 0) {
      console.log(`${LOG_PREFIX} 저장된 데이터가 없습니다.`);
      return;
    }

    const origins = document.querySelectorAll(SEL.ORIGIN);
    const textareas = document.querySelectorAll(SEL.TEXTAREA);

    let matched = 0;
    let skipped = 0;

    const count = Math.min(origins.length, textareas.length);
    for (let i = 0; i < count; i++) {
      const sourceText = origins[i].textContent.trim();
      const textarea = textareas[i];

      if (textarea.value.trim()) {
        skipped++;
        continue;
      }

      const translation = findTranslation(sourceText);
      if (translation) {
        setTextareaValue(textarea, convertTranslationForOrigin(translation, sourceText));
        matched++;
      }
    }

    console.log(`${LOG_PREFIX} 일괄 삽입 완료: ${matched}건 매칭, ${skipped}건 건너뛰기`);
    if (window.catToast) window.catToast(`✅ 일괄 삽입: ${matched}건 매칭, ${skipped}건 건너뛰기`);
  }

  // ═══════════════════════════════════════
  //  복원된 데이터 UI 반영
  // ═══════════════════════════════════════

  if (dataCount > 0) {
    document.getElementById('cat-lookup-count').textContent = dataCount;
    document.getElementById('cat-lookup-status').textContent =
      `🔄 이전 세션에서 ${dataCount}건 복원됨`;
    updatePreview();
  }

  // ═══════════════════════════════════════
  //  로드 완료
  // ═══════════════════════════════════════

  console.log(`${LOG_PREFIX} v2.4 로드 완료`);
  console.log('  Alt+Q       → 팝업 열기/닫기');
  console.log('  Alt+W       → 현재 세그먼트 매칭 삽입');
  console.log('  Alt+Shift+W → 전체 세그먼트 일괄 삽입');
  console.log(`  지원 헤더(원문):   ${HEADER_ALIASES.SOURCE.join(' / ')} (+ "(zh-CN)" 같은 괄호 부가정보 허용)`);
  console.log(`  지원 헤더(번역문): ${HEADER_ALIASES.TARGET.join(' / ')} (+ "(ko-KR)" 같은 괄호 부가정보 허용)`);
})();
