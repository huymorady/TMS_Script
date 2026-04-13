// ==UserScript==
// @name         CAT Tool - 번역 조회 팝업
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Alt+Q → 팝업 열기/닫기 / Alt+W → 현재 세그먼트 매칭 삽입 / Alt+Shift+W → 전체 세그먼트 일괄 삽입
// @match        *://tms.skyunion.net/*
// @updateURL    https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-lookup.user.js
// @downloadURL  https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-lookup.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── 데이터 저장소 ───
  let lookupData = {}; // { '원문': '번역문', ... }
  let dataCount = 0;

  // ─── 팝업 UI 생성 ───
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
      display: none;
      position: fixed;
      top: 60px;
      right: 20px;
      width: 420px;
      max-height: 70vh;
      background: #2a2a2e;
      border: 1px solid #555;
      border-radius: 8px;
      z-index: 99999;
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      color: #e0e0e0;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
    }
    #cat-lookup-panel.visible {
      display: flex;
    }
    #cat-lookup-panel.collapsed #cat-lookup-body { display: none; }
    #cat-lookup-panel.collapsed { max-height: none; }
    #cat-lookup-body {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #cat-lookup-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      background: #3a3a3e;
      border-radius: 8px 8px 0 0;
      font-weight: bold;
      font-size: 14px;
      cursor: grab;
      user-select: none;
    }
    #cat-lookup-header:active { cursor: grabbing; }
    #cat-lookup-panel.collapsed #cat-lookup-header { border-radius: 8px; }
    #cat-lookup-title { cursor: pointer; }
    #cat-lookup-header button {
      background: none;
      border: none;
      color: #e0e0e0;
      cursor: pointer;
      font-size: 16px;
      padding: 2px 6px;
      border-radius: 4px;
    }
    #cat-lookup-header button:hover {
      background: #555;
    }
    #cat-lookup-input {
      margin: 10px 14px;
      height: 150px;
      background: #1e1e22;
      border: 1px solid #555;
      border-radius: 6px;
      color: #e0e0e0;
      padding: 10px;
      font-size: 12px;
      font-family: monospace;
      resize: vertical;
      white-space: pre;
      overflow-x: auto;
      word-wrap: normal;
    }
    #cat-lookup-input:focus {
      outline: none;
      border-color: #5ac8a0;
    }
    #cat-lookup-parse {
      margin: 0 14px 10px;
      padding: 8px;
      background: #5ac8a0;
      color: #1e1e22;
      border: none;
      border-radius: 6px;
      font-weight: bold;
      cursor: pointer;
      font-size: 13px;
    }
    #cat-lookup-parse:hover {
      background: #4ab890;
    }
    #cat-lookup-status {
      padding: 0 14px;
      font-size: 12px;
      color: #aaa;
    }
    #cat-lookup-preview {
      margin: 8px 14px 14px;
      max-height: 200px;
      overflow-y: auto;
      font-size: 11px;
    }
    #cat-lookup-preview table {
      width: 100%;
      border-collapse: collapse;
    }
    #cat-lookup-preview th, #cat-lookup-preview td {
      padding: 4px 8px;
      border: 1px solid #444;
      text-align: left;
    }
    #cat-lookup-preview th {
      background: #3a3a3e;
      font-size: 11px;
    }
    #cat-lookup-preview td {
      font-size: 11px;
      word-break: break-all;
    }
    .cat-lookup-match {
      background: #2d4a3e !important;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  // ─── 이벤트: 파싱 버튼 ───
  document.getElementById('cat-lookup-parse').addEventListener('click', parseInput);
  document.getElementById('cat-lookup-close').addEventListener('click', () => {
    panel.classList.remove('visible');
  });
  document.getElementById('cat-lookup-clear').addEventListener('click', () => {
    lookupData = {};
    dataCount = 0;
    document.getElementById('cat-lookup-input').value = '';
    document.getElementById('cat-lookup-count').textContent = '0';
    document.getElementById('cat-lookup-status').textContent = '데이터가 초기화되었습니다.';
    document.getElementById('cat-lookup-preview').innerHTML = '';
    console.log('[번역 조회] 데이터 초기화');
  });

  // ─── 헤더 드래그 이동 ───
  const lookupHeader = document.getElementById('cat-lookup-header');
  let lkDragging = false;
  let lkDragStartX, lkDragStartY, lkPanelStartX, lkPanelStartY;

  lookupHeader.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    lkDragging = true;
    lkDragStartX = e.clientX;
    lkDragStartY = e.clientY;
    const rect = panel.getBoundingClientRect();
    lkPanelStartX = rect.left;
    lkPanelStartY = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!lkDragging) return;
    const dx = e.clientX - lkDragStartX;
    const dy = e.clientY - lkDragStartY;
    panel.style.left = (lkPanelStartX + dx) + 'px';
    panel.style.top = (lkPanelStartY + dy) + 'px';
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    lkDragging = false;
  });

  // ─── 헤더 제목 클릭 → 접기/펼치기 ───
  document.getElementById('cat-lookup-title').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  // ─── 마크다운 테이블 파싱 ───
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

    // 헤더 행에서 '원문'과 '번역문' 열 인덱스 자동 감지
    const headerCells = lines[0].split('|').map(c => c.trim()).filter(c => c !== '');
    let srcIdx = -1;
    let tgtIdx = -1;

    for (let i = 0; i < headerCells.length; i++) {
      if (headerCells[i] === '원문') srcIdx = i;
      if (headerCells[i] === '번역문') tgtIdx = i;
    }

    if (srcIdx === -1 || tgtIdx === -1) {
      document.getElementById('cat-lookup-status').textContent =
        '⚠ 헤더에서 "원문"과 "번역문" 열을 찾을 수 없습니다.';
      return;
    }

    let parsed = 0;
    const newData = {};

    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split('|').map(c => c.trim()).filter(c => c !== '');

      // 구분선(---) 건너뛰기
      if (cells.some(c => /^[-:]+$/.test(c))) continue;

      if (cells.length > Math.max(srcIdx, tgtIdx)) {
        const source = cells[srcIdx];
        const target = cells[tgtIdx];

        if (source && target) {
          newData[source] = target;
          parsed++;
        }
      }
    }

    // 기존 데이터에 추가 (덮어쓰기)
    Object.assign(lookupData, newData);
    dataCount = Object.keys(lookupData).length;

    document.getElementById('cat-lookup-count').textContent = dataCount;
    document.getElementById('cat-lookup-status').textContent =
      `✅ ${parsed}건 파싱 완료 (총 ${dataCount}건 저장)`;

    // 미리보기 테이블 생성
    updatePreview();

    console.log(`[번역 조회] ${parsed}건 파싱, 총 ${dataCount}건 저장`);
  }

  // ─── 미리보기 테이블 업데이트 ───
  function updatePreview() {
    const entries = Object.entries(lookupData);
    if (entries.length === 0) {
      document.getElementById('cat-lookup-preview').innerHTML = '';
      return;
    }

    let html = '<table><tr><th>원문</th><th>번역문</th></tr>';
    // 최근 20건만 표시
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

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ─── 단축키 처리 ───
  document.addEventListener(
    'keydown',
    function (e) {
      if (!e.altKey || e.ctrlKey) return;

      // Alt+Shift+W: 전체 세그먼트 일괄 삽입
      if (e.shiftKey && (e.key === 'W' || e.key === 'w')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        insertAll();
        return;
      }

      if (e.shiftKey) return;

      // Alt+Q: 팝업 토글
      if (e.key === 'q' || e.key === 'Q') {
        e.preventDefault();
        e.stopImmediatePropagation();
        panel.classList.toggle('visible');
        if (panel.classList.contains('visible')) {
          document.getElementById('cat-lookup-input').focus();
        }
        return;
      }

      // Alt+W: 현재 세그먼트 매칭 삽입
      if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        e.stopImmediatePropagation();
        insertCurrent();
        return;
      }
    },
    true
  );

  // ─── 텍스트 정규화 (매칭용) ───
  // <br>, <br/>, <br />, \n을 모두 통일하고 앞뒤 공백 제거
  function normalize(text) {
    return text
      .replace(/<br\s*\/?>/gi, '\n')  // <br>, <br/>, <br /> → \n
      .replace(/\r\n/g, '\n')          // \r\n → \n
      .replace(/\r/g, '\n')            // \r → \n
      .trim();
  }

  // ─── 정규화된 키로 번역문 검색 ───
  function findTranslation(sourceText) {
    // 1순위: 완전 일치
    if (lookupData[sourceText]) return lookupData[sourceText];

    // 2순위: 정규화 후 비교
    const normalizedSource = normalize(sourceText);
    for (const [key, value] of Object.entries(lookupData)) {
      if (normalize(key) === normalizedSource) return value;
    }

    return null;
  }

  // ─── 현재 세그먼트 매칭 삽입 ───
  function insertCurrent() {
    if (dataCount === 0) {
      console.log('[번역 조회] 저장된 데이터가 없습니다.');
      return;
    }

    const active = document.activeElement;
    if (!active || active.tagName !== 'TEXTAREA') {
      console.log('[번역 조회] 번역 입력창에 포커스가 없습니다.');
      return;
    }

    // 같은 행의 원문 찾기
    const sourceText = getSourceForTextarea(active);
    if (!sourceText) {
      console.log('[번역 조회] 원문을 찾을 수 없습니다.');
      return;
    }

    const translation = findTranslation(sourceText);
    if (!translation) {
      console.log(`[번역 조회] 매칭 실패: "${sourceText}"`);
      return;
    }

    // 번역문 삽입
    setTextareaValue(active, translation);
    console.log(`[번역 조회] 매칭 삽입: "${sourceText}" → "${translation}"`);
  }

  // ─── 전체 세그먼트 일괄 삽입 ───
  function insertAll() {
    if (dataCount === 0) {
      console.log('[번역 조회] 저장된 데이터가 없습니다.');
      return;
    }

    const origins = document.querySelectorAll('.origin_string');
    const textareas = document.querySelectorAll('textarea.n-input__textarea-el');

    let matched = 0;
    let skipped = 0;

    const count = Math.min(origins.length, textareas.length);
    for (let i = 0; i < count; i++) {
      const sourceText = origins[i].textContent.trim();
      const textarea = textareas[i];

      // 이미 번역문이 입력되어 있으면 건너뛰기
      if (textarea.value.trim()) {
        skipped++;
        continue;
      }

      const translation = findTranslation(sourceText);
      if (translation) {
        setTextareaValue(textarea, translation);
        matched++;
      }
    }

    console.log(`[번역 조회] 일괄 삽입 완료: ${matched}건 매칭, ${skipped}건 건너뛰기 (이미 입력됨)`);
  }

  // ─── textarea에서 같은 행의 원문 찾기 ───
  function getSourceForTextarea(textarea) {
    // 방법 1: DOM 구조 기반
    const row = textarea.closest('[data-v-9a359d1f]')
      || textarea.closest('.n-input')?.parentElement?.parentElement;
    if (row) {
      const origin = row.querySelector('.origin_string')
        || row.parentElement?.querySelector('.origin_string');
      if (origin) return origin.textContent.trim();
    }

    // 방법 2: 인덱스 기반
    const allTextareas = document.querySelectorAll('textarea.n-input__textarea-el');
    const allOrigins = document.querySelectorAll('.origin_string');
    const idx = Array.from(allTextareas).indexOf(textarea);
    if (idx >= 0 && idx < allOrigins.length) {
      return allOrigins[idx].textContent.trim();
    }

    return null;
  }

  // ─── textarea 값 설정 (Vue/React 반응성 대응) ───
  function setTextareaValue(textarea, value) {
    // <br>, <br/>, <br /> → 실제 줄바꿈으로 변환
    const converted = value.replace(/<br\s*\/?>/gi, '\n');

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeSetter.call(textarea, converted);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  console.log('[번역 조회] v1.5 로드 완료');
  console.log('  Alt+Q       → 팝업 열기/닫기');
  console.log('  Alt+W       → 현재 세그먼트 매칭 삽입');
  console.log('  Alt+Shift+W → 전체 세그먼트 일괄 삽입');
})();