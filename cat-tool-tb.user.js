// ==UserScript==
// @name         CAT Tool - TB 도구
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Alt+B → TB 목록/검수 팝업 (접기, 드래그 이동, 검수 항목 클릭 시 이동+복사)
// @match        *://tms.skyunion.net/*
// @updateURL    https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-tb.user.js
// @downloadURL  https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-tb.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── 팝업 UI ───
  const panel = document.createElement('div');
  panel.id = 'cat-tb-panel';
  panel.innerHTML = `
    <div id="cat-tb-header">
      <span id="cat-tb-title">📖 TB 도구 (<span id="cat-tb-count">0</span>건)</span>
      <div>
        <button id="cat-tb-refresh" title="새로고침">🔄</button>
        <button id="cat-tb-copy" title="클립보드 복사">📋</button>
        <button id="cat-tb-close" title="닫기">✕</button>
      </div>
    </div>
    <div id="cat-tb-body">
      <div id="cat-tb-tabs">
        <button class="cat-tb-tab active" data-tab="list">목록</button>
        <button class="cat-tb-tab" data-tab="validate">검수 (<span id="cat-tb-issue-count">0</span>)</button>
      </div>
      <div id="cat-tb-tab-list" class="cat-tb-tab-content active"></div>
      <div id="cat-tb-tab-validate" class="cat-tb-tab-content"></div>
      <div id="cat-tb-status"></div>
    </div>
  `;

  // ─── 스타일 ───
  const style = document.createElement('style');
  style.textContent = `
    #cat-tb-panel {
      display: none;
      position: fixed;
      top: 60px;
      left: 20px;
      width: 420px;
      max-height: 75vh;
      background: #2a2a2e;
      border: 1px solid #555;
      border-radius: 8px;
      z-index: 99999;
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      color: #e0e0e0;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      flex-direction: column;
    }
    #cat-tb-panel.visible { display: flex; }
    #cat-tb-panel.collapsed #cat-tb-body { display: none; }
    #cat-tb-panel.collapsed { max-height: none; }

    #cat-tb-header {
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
    #cat-tb-header:active { cursor: grabbing; }
    #cat-tb-panel.collapsed #cat-tb-header { border-radius: 8px; }
    #cat-tb-title { cursor: pointer; }
    #cat-tb-header button {
      background: none;
      border: none;
      color: #e0e0e0;
      cursor: pointer;
      font-size: 15px;
      padding: 2px 6px;
      border-radius: 4px;
    }
    #cat-tb-header button:hover { background: #555; }

    #cat-tb-body { display: flex; flex-direction: column; overflow: hidden; }

    #cat-tb-tabs {
      display: flex;
      border-bottom: 1px solid #444;
      padding: 0 14px;
      background: #333;
    }
    .cat-tb-tab {
      background: none;
      border: none;
      color: #aaa;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .cat-tb-tab:hover { color: #e0e0e0; }
    .cat-tb-tab.active { color: #5ac8a0; border-bottom-color: #5ac8a0; font-weight: bold; }

    .cat-tb-tab-content {
      display: none;
      overflow-y: auto;
      max-height: calc(75vh - 120px);
      padding: 8px 14px;
    }
    .cat-tb-tab-content.active { display: block; }

    .cat-tb-tab-content table { width: 100%; border-collapse: collapse; }
    .cat-tb-tab-content th {
      padding: 6px 8px; border: 1px solid #444; background: #3a3a3e;
      font-size: 12px; text-align: left; position: sticky; top: 0;
    }
    .cat-tb-tab-content td {
      padding: 5px 8px; border: 1px solid #444; font-size: 12px; word-break: break-all;
    }
    .cat-tb-tab-content tr:hover td { background: #3a3a3e; }

    .cat-tb-issue-row { cursor: pointer; }
    .cat-tb-issue-row:hover td { background: #2d4a3e !important; }
    .cat-tb-seg-num { color: #4a90d9; font-weight: bold; white-space: nowrap; }
    .cat-tb-missing { color: #e06060; }
    .cat-tb-copied-flash { animation: cat-tb-flash 0.6s ease; }
    @keyframes cat-tb-flash {
      0% { background: #2d4a3e; }
      50% { background: #3d6a5e; }
      100% { background: transparent; }
    }

    #cat-tb-status { padding: 6px 14px 10px; font-size: 11px; color: #aaa; }
    .cat-tb-no-data { padding: 20px; text-align: center; color: #888; }
    .cat-tb-all-good { padding: 20px; text-align: center; color: #5ac8a0; font-size: 14px; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  // ═══════════════════════════════════════
  //  헤더 드래그 이동
  // ═══════════════════════════════════════

  const header = document.getElementById('cat-tb-header');
  let isDragging = false;
  let dragStartX, dragStartY, panelStartX, panelStartY;

  header.addEventListener('mousedown', (e) => {
    // 버튼 클릭은 드래그로 처리하지 않음
    if (e.target.closest('button')) return;

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = panel.getBoundingClientRect();
    panelStartX = rect.left;
    panelStartY = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    panel.style.left = (panelStartX + dx) + 'px';
    panel.style.top = (panelStartY + dy) + 'px';
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });

  // ═══════════════════════════════════════
  //  헤더 제목 클릭 → 접기/펼치기
  // ═══════════════════════════════════════

  let clickTimer = null;
  document.getElementById('cat-tb-title').addEventListener('click', (e) => {
    // 드래그 후 클릭 방지 (이동 거리가 작을 때만 토글)
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      panel.classList.toggle('collapsed');
    }, 200);
  });

  // ─── 탭 전환 ───
  document.querySelectorAll('.cat-tb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.cat-tb-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.cat-tb-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('cat-tb-tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // ─── 버튼 이벤트 ───
  document.getElementById('cat-tb-close').addEventListener('click', () => {
    panel.classList.remove('visible');
  });
  document.getElementById('cat-tb-refresh').addEventListener('click', () => {
    runAll();
  });
  document.getElementById('cat-tb-copy').addEventListener('click', () => {
    copyToClipboard();
  });

  // ─── 단축키: Alt+B ───
  document.addEventListener(
    'keydown',
    function (e) {
      if (!e.altKey || e.ctrlKey || e.shiftKey) return;
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (panel.classList.contains('visible')) {
          panel.classList.remove('visible');
        } else {
          runAll();
          panel.classList.add('visible');
        }
        return;
      }
    },
    true
  );

  function runAll() {
    displayList();
    displayValidation();
  }

  // ═══════════════════════════════════════
  //  목록 탭
  // ═══════════════════════════════════════

  function extractTbTerms() {
    const spans = document.querySelectorAll('.origin_string span.vb[data-tooltip]');
    const terms = {};
    for (const span of spans) {
      const source = span.textContent.trim();
      const target = span.getAttribute('data-tooltip');
      if (source && target) terms[source] = target;
    }
    return terms;
  }

  function displayList() {
    const terms = extractTbTerms();
    const entries = Object.entries(terms);
    const count = entries.length;

    document.getElementById('cat-tb-count').textContent = count;
    const contentEl = document.getElementById('cat-tb-tab-list');
    const statusEl = document.getElementById('cat-tb-status');

    if (count === 0) {
      contentEl.innerHTML = '<div class="cat-tb-no-data">현재 파일에서 TB 용어를 찾을 수 없습니다.</div>';
      statusEl.textContent = '';
      return;
    }

    entries.sort((a, b) => a[0].localeCompare(b[0], 'zh'));

    let html = '<table><tr><th>원문</th><th>TB 번역어</th></tr>';
    for (const [src, tgt] of entries) {
      html += `<tr><td>${escapeHtml(src)}</td><td>${escapeHtml(tgt)}</td></tr>`;
    }
    html += '</table>';

    contentEl.innerHTML = html;
    statusEl.textContent = `총 ${count}건의 TB 용어가 추출되었습니다.`;
    console.log(`[TB 도구] ${count}건 TB 용어 추출 완료`);
  }

  // ═══════════════════════════════════════
  //  검수 탭
  // ═══════════════════════════════════════

  function displayValidation() {
    const origins = document.querySelectorAll('.origin_string');
    const textareas = document.querySelectorAll('textarea.n-input__textarea-el');
    const issues = [];

    const cnt = Math.min(origins.length, textareas.length);
    for (let i = 0; i < cnt; i++) {
      const originEl = origins[i];
      const textarea = textareas[i];
      const translationText = textarea.value;

      if (!translationText.trim()) continue;

      const tbSpans = originEl.querySelectorAll('span.vb[data-tooltip]');
      if (tbSpans.length === 0) continue;

      for (const span of tbSpans) {
        const source = span.textContent.trim();
        const target = span.getAttribute('data-tooltip');

        if (source && target && !translationText.includes(target)) {
          issues.push({
            segIndex: i,
            segNum: i + 1,
            source: source,
            expectedTarget: target,
            originEl: originEl,
            textarea: textarea,
          });
        }
      }
    }

    const issueCount = issues.length;
    document.getElementById('cat-tb-issue-count').textContent = issueCount;

    const contentEl = document.getElementById('cat-tb-tab-validate');

    if (issueCount === 0) {
      contentEl.innerHTML = '<div class="cat-tb-all-good">✅ 모든 TB 용어가 올바르게 반영되었습니다!</div>';
      console.log('[TB 도구] 검수 완료: 문제 없음');
      return;
    }

    let html = '<table><tr><th>#</th><th>원문 용어</th><th>TB 번역어</th><th>상태</th></tr>';
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      html += `<tr class="cat-tb-issue-row" data-issue-idx="${i}">`;
      html += `<td class="cat-tb-seg-num">${issue.segNum}</td>`;
      html += `<td>${escapeHtml(issue.source)}</td>`;
      html += `<td>${escapeHtml(issue.expectedTarget)}</td>`;
      html += `<td class="cat-tb-missing">미반영</td>`;
      html += `</tr>`;
    }
    html += '</table>';

    contentEl.innerHTML = html;

    // 클릭 시 세그먼트 이동 + TB 번역어 클립보드 복사
    contentEl.querySelectorAll('.cat-tb-issue-row').forEach(row => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.issueIdx);
        const issue = issues[idx];

        // 세그먼트로 이동
        navigateToSegment(issue.originEl, issue.textarea);

        // TB 번역어를 클립보드에 복사
        navigator.clipboard.writeText(issue.expectedTarget).then(() => {
          document.getElementById('cat-tb-status').textContent =
            `✅ "${issue.expectedTarget}" 클립보드에 복사됨 → Ctrl+V로 붙여넣기`;
          console.log(`[TB 도구] "${issue.expectedTarget}" 클립보드 복사`);

          // 플래시 효과
          row.classList.add('cat-tb-copied-flash');
          setTimeout(() => row.classList.remove('cat-tb-copied-flash'), 600);
        });
      });
    });

    console.log(`[TB 도구] 검수 완료: ${issueCount}건 미반영`);
  }

  // ═══════════════════════════════════════
  //  세그먼트 이동
  // ═══════════════════════════════════════

  function navigateToSegment(originEl, textarea) {
    originEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      textarea.focus();
      textarea.click();
    }, 300);
  }

  // ═══════════════════════════════════════
  //  클립보드 복사
  // ═══════════════════════════════════════

  function copyToClipboard() {
    const activeTab = document.querySelector('.cat-tb-tab.active')?.dataset.tab;
    if (activeTab === 'validate') copyValidation();
    else copyList();
  }

  function copyList() {
    const terms = extractTbTerms();
    const entries = Object.entries(terms);
    if (entries.length === 0) {
      document.getElementById('cat-tb-status').textContent = '⚠ 복사할 TB 용어가 없습니다.';
      return;
    }
    entries.sort((a, b) => a[0].localeCompare(b[0], 'zh'));
    let text = '원문\tTB 번역어\n';
    for (const [src, tgt] of entries) text += `${src}\t${tgt}\n`;
    navigator.clipboard.writeText(text).then(() => {
      document.getElementById('cat-tb-status').textContent =
        `✅ ${entries.length}건 클립보드에 복사되었습니다. (탭 구분 형식)`;
    });
  }

  function copyValidation() {
    const rows = document.querySelectorAll('.cat-tb-issue-row');
    if (rows.length === 0) {
      document.getElementById('cat-tb-status').textContent = '⚠ 복사할 검수 결과가 없습니다.';
      return;
    }
    let text = '세그먼트\t원문 용어\tTB 번역어\t상태\n';
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      text += `${cells[0].textContent}\t${cells[1].textContent}\t${cells[2].textContent}\t${cells[3].textContent}\n`;
    });
    navigator.clipboard.writeText(text).then(() => {
      document.getElementById('cat-tb-status').textContent =
        `✅ ${rows.length}건 검수 결과가 클립보드에 복사되었습니다.`;
    });
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  console.log('[TB 도구] v3.0 로드 완료');
  console.log('  Alt+B → TB 도구 팝업 열기/닫기 (목록 + 검수)');
  console.log('  헤더 제목 클릭 → 접기/펼치기');
  console.log('  헤더 드래그 → 위치 이동');
  console.log('  검수 항목 클릭 → 세그먼트 이동 + TB 번역어 클립보드 복사');
})();
