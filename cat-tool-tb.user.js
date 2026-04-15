// ==UserScript==
// @name         CAT Tool - TB 도구
// @namespace    http://tampermonkey.net/
// @version      4.5
// @description  Alt+B → TB 목록/검수/QA 팝업 (14개 QA 체크 항목, 접기/드래그)
// @match        *://tms.skyunion.net/*
// @updateURL    https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-tb.user.js
// @downloadURL  https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-tb.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════
  //  상수 정의
  // ═══════════════════════════════════════

  const LOG_PREFIX = '[TB 도구]';

  // DOM 셀렉터
  const SEL = {
    ORIGIN: 'div.origin_string[data-type="origin_string"]',
    TEXTAREA: 'textarea.n-input__textarea-el',
    TB_SPAN: 'div.origin_string[data-type="origin_string"] span.vb[data-tooltip]',
  };

  // 태그 추출 정규식 (단축키 스크립트와 동일)
  const TAG_PATTERN = new RegExp(
    '\\{\\d+\\}'
    + '|\\{[a-zA-Z_][a-zA-Z0-9_]*\\}'
    + '|%[sd]'
    + '|%\\d+\\$[sd]'
    + '|<br\\s*/?>'
    + '|</?[a-zA-Z][^>]*>'
    + '|\\\\n'
    + '|\\[/?[a-zA-Z][^\\]]*\\]'
  , 'g');

  // 숫자 추출 정규식 (태그 내부 제외를 위해 태그를 먼저 제거 후 사용)
  const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;

  // 괄호 짝 정의
  const BRACKET_PAIRS = [
    ['(', ')'],
    ['[', ']'],
    ['（', '）'],
    ['【', '】'],
    ['「', '」'],
    ['『', '』'],
  ];

  // 따옴표 짝 정의
  const QUOTE_PAIRS = [
    ['\u201C', '\u201D'],  // " "
    ['\u2018', '\u2019'],  // ' '
    ['「', '」'],
    ['『', '』'],
  ];

  // QA 오류 유형 라벨
  const QA_LABELS = {
    UNTRANSLATED: '미번역',
    IDENTICAL: '원문동일',
    LEADING_SPACE: '앞 공백',
    TRAILING_SPACE: '뒤 공백',
    CONSECUTIVE_SPACE: '연속 공백',
    NUMBER_MISMATCH: '숫자 불일치',
    BRACKET_MISMATCH: '괄호 불일치',
    QUOTE_MISMATCH: '따옴표 불일치',
    TAG_MISMATCH: '태그 불일치',
    TAG_ORDER: '태그 순서',
    NEWLINE_MISMATCH: '줄바꿈 불일치',
    PERIOD_MISMATCH: '마침표 불일치',
    REPEAT_CHAR: '반복 문자',
    PLACEHOLDER_SPACE: '플레이스홀더 공백',
  };

  // ═══════════════════════════════════════
  //  공통 유틸리티 함수
  // ═══════════════════════════════════════

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 세그먼트로 스크롤 이동 + 포커스 + 선택적 텍스트 하이라이트 */
  function navigateToSegment(originEl, textarea, selectStart, selectEnd) {
    originEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      textarea.focus();
      textarea.click();
      // 문제 위치 하이라이트 — click 후 웹앱이 포커스를 잡은 뒤 다시 선택
      if (selectStart !== undefined && selectEnd !== undefined) {
        setTimeout(() => {
          textarea.focus();
          textarea.setSelectionRange(selectStart, selectEnd);
        }, 150);
      }
    }, 300);
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

  /** 원문/번역문 쌍 배열 가져오기 (같은 행에서 짝을 맞춤) */
  function getSegmentPairs() {
    const origins = document.querySelectorAll(SEL.ORIGIN);
    const textareas = document.querySelectorAll(SEL.TEXTAREA);
    const pairs = [];

    // textarea 개수 기준으로 매칭 (origin이 더 많을 수 있음)
    const count = textareas.length;
    for (let i = 0; i < count; i++) {
      if (i >= origins.length) break;
      pairs.push({
        index: i,
        segNum: i + 1,
        originEl: origins[i],
        textarea: textareas[i],
        sourceText: origins[i].textContent.trim(),
        targetText: textareas[i].value,
      });
    }
    return pairs;
  }

  /** 텍스트에서 태그를 제거한 순수 텍스트 반환 */
  function stripTags(text) {
    return text.replace(TAG_PATTERN, '');
  }

  /** 텍스트에서 숫자 배열 추출 (태그 내부 제외) */
  function extractNumbers(text) {
    const stripped = stripTags(text);
    return (stripped.match(NUMBER_PATTERN) || []).sort();
  }

  /** 텍스트에서 태그 배열 추출 */
  function extractTags(text) {
    return (text.match(TAG_PATTERN) || []).sort();
  }

  /** 줄바꿈 개수 세기 */
  function countNewlines(text) {
    return (text.match(/\n/g) || []).length;
  }

  // ═══════════════════════════════════════
  //  팝업 UI
  // ═══════════════════════════════════════

  const panel = document.createElement('div');
  panel.id = 'cat-tb-panel';
  panel.innerHTML = `
    <div id="cat-tb-header">
      <span id="cat-tb-title">📖 TB/QA 도구 (<span id="cat-tb-count">0</span>건)</span>
      <div>
        <button id="cat-tb-refresh" title="새로고침">🔄</button>
        <button id="cat-tb-copy" title="클립보드 복사">📋</button>
        <button id="cat-tb-close" title="닫기">✕</button>
      </div>
    </div>
    <div id="cat-tb-body">
      <div id="cat-tb-tabs">
        <button class="cat-tb-tab active" data-tab="list">목록</button>
        <button class="cat-tb-tab" data-tab="validate">TB검수 (<span id="cat-tb-issue-count">0</span>)</button>
        <button class="cat-tb-tab" data-tab="qa">QA (<span id="cat-tb-qa-count">0</span>)</button>
      </div>
      <div id="cat-tb-tab-list" class="cat-tb-tab-content active"></div>
      <div id="cat-tb-tab-validate" class="cat-tb-tab-content"></div>
      <div id="cat-tb-tab-qa" class="cat-tb-tab-content"></div>
      <div id="cat-tb-status"></div>
    </div>
  `;

  // ─── 스타일 ───
  const style = document.createElement('style');
  style.textContent = `
    #cat-tb-panel {
      display: none; position: fixed; top: 60px; left: 20px;
      width: 480px; max-height: 75vh; background: #2a2a2e;
      border: 1px solid #555; border-radius: 8px; z-index: 99999;
      font-family: -apple-system, sans-serif; font-size: 13px;
      color: #e0e0e0; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      flex-direction: column;
    }
    #cat-tb-panel.visible { display: flex; }
    #cat-tb-panel.collapsed #cat-tb-body { display: none; }
    #cat-tb-panel.collapsed { max-height: none; }
    #cat-tb-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 14px; background: #3a3a3e; border-radius: 8px 8px 0 0;
      font-weight: bold; font-size: 14px; cursor: grab; user-select: none;
    }
    #cat-tb-header:active { cursor: grabbing; }
    #cat-tb-panel.collapsed #cat-tb-header { border-radius: 8px; }
    #cat-tb-title { cursor: pointer; }
    #cat-tb-header button {
      background: none; border: none; color: #e0e0e0; cursor: pointer;
      font-size: 15px; padding: 2px 6px; border-radius: 4px;
    }
    #cat-tb-header button:hover { background: #555; }
    #cat-tb-body { display: flex; flex-direction: column; overflow: hidden; }
    #cat-tb-tabs {
      display: flex; border-bottom: 1px solid #444; padding: 0 14px; background: #333;
    }
    .cat-tb-tab {
      background: none; border: none; color: #aaa; padding: 8px 12px;
      cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .cat-tb-tab:hover { color: #e0e0e0; }
    .cat-tb-tab.active { color: #5ac8a0; border-bottom-color: #5ac8a0; font-weight: bold; }
    .cat-tb-tab-content {
      display: none; overflow-y: auto; max-height: calc(75vh - 120px); padding: 8px 14px;
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
    .cat-tb-warn { color: #d9a94e; }
    .cat-tb-copied-flash { animation: cat-tb-flash 0.6s ease; }
    @keyframes cat-tb-flash {
      0% { background: #2d4a3e; } 50% { background: #3d6a5e; } 100% { background: transparent; }
    }
    #cat-tb-status { padding: 6px 14px 10px; font-size: 11px; color: #aaa; }
    .cat-tb-no-data { padding: 20px; text-align: center; color: #888; }
    .cat-tb-all-good { padding: 20px; text-align: center; color: #5ac8a0; font-size: 14px; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  // ═══════════════════════════════════════
  //  UI 이벤트
  // ═══════════════════════════════════════

  // 드래그
  makeDraggable(document.getElementById('cat-tb-header'), panel);

  // 접기/펼치기
  document.getElementById('cat-tb-title').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  // 탭 전환
  document.querySelectorAll('.cat-tb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.cat-tb-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.cat-tb-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('cat-tb-tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // 버튼 이벤트
  document.getElementById('cat-tb-close').addEventListener('click', () => {
    panel.classList.remove('visible');
  });
  document.getElementById('cat-tb-refresh').addEventListener('click', runAll);
  document.getElementById('cat-tb-copy').addEventListener('click', copyToClipboard);

  // 단축키: Alt+B
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.shiftKey) return;
    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (panel.classList.contains('visible')) {
        panel.classList.remove('visible');
      } else {
        runAll();
        panel.classList.add('visible');
      }
    }
  }, true);

  function runAll() {
    displayList();
    displayValidation();
    displayQA();
  }

  // ═══════════════════════════════════════
  //  목록 탭
  // ═══════════════════════════════════════

  function extractTbTerms() {
    const spans = document.querySelectorAll(SEL.TB_SPAN);
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
    console.log(`${LOG_PREFIX} ${count}건 TB 용어 추출 완료`);
    if (window.catToast) window.catToast(`📖 TB 용어 ${count}건 추출`);
  }

  // ═══════════════════════════════════════
  //  TB 검수 탭
  // ═══════════════════════════════════════

  function displayValidation() {
    const pairs = getSegmentPairs();
    const issues = [];

    for (const seg of pairs) {
      if (!seg.targetText.trim()) continue;

      const tbSpans = seg.originEl.querySelectorAll('span.vb[data-tooltip]');
      if (tbSpans.length === 0) continue;

      for (const span of tbSpans) {
        const source = span.textContent.trim();
        const target = span.getAttribute('data-tooltip');

        if (source && target && !seg.targetText.includes(target)) {
          issues.push({
            segNum: seg.segNum,
            source, expectedTarget: target,
            originEl: seg.originEl, textarea: seg.textarea,
          });
        }
      }
    }

    const issueCount = issues.length;
    document.getElementById('cat-tb-issue-count').textContent = issueCount;
    const contentEl = document.getElementById('cat-tb-tab-validate');

    if (issueCount === 0) {
      contentEl.innerHTML = '<div class="cat-tb-all-good">✅ 모든 TB 용어가 올바르게 반영되었습니다!</div>';
      return;
    }

    let html = '<table><tr><th>#</th><th>원문 용어</th><th>TB 번역어</th><th>상태</th></tr>';
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      html += `<tr class="cat-tb-issue-row" data-issue-idx="${i}">`;
      html += `<td class="cat-tb-seg-num">${issue.segNum}</td>`;
      html += `<td>${escapeHtml(issue.source)}</td>`;
      html += `<td>${escapeHtml(issue.expectedTarget)}</td>`;
      html += `<td class="cat-tb-missing">미반영</td></tr>`;
    }
    html += '</table>';
    contentEl.innerHTML = html;

    // 클릭 이벤트
    contentEl.querySelectorAll('.cat-tb-issue-row').forEach(row => {
      row.addEventListener('click', () => {
        const issue = issues[parseInt(row.dataset.issueIdx)];
        navigateToSegment(issue.originEl, issue.textarea);
        navigator.clipboard.writeText(issue.expectedTarget).then(() => {
          document.getElementById('cat-tb-status').textContent =
            `✅ "${issue.expectedTarget}" 클립보드에 복사됨 → Ctrl+V로 붙여넣기`;
          if (window.catToast) window.catToast(`📋 "${issue.expectedTarget}" 복사됨 → Ctrl+V`);
          row.classList.add('cat-tb-copied-flash');
          setTimeout(() => row.classList.remove('cat-tb-copied-flash'), 600);
        });
      });
    });

    console.log(`${LOG_PREFIX} TB 검수: ${issueCount}건 미반영`);
  }

  // ═══════════════════════════════════════
  //  QA 탭
  // ═══════════════════════════════════════

  function runQAChecks() {
    const pairs = getSegmentPairs();
    const issues = [];

    for (const seg of pairs) {
      const src = seg.sourceText;
      const tgt = seg.targetText;

      // 1. 미번역 (원문이 있는데 번역문이 비어있음)
      if (src && !tgt.trim()) {
        issues.push({ ...seg, type: QA_LABELS.UNTRANSLATED, detail: '번역문이 비어있습니다.' });
        continue; // 미번역이면 나머지 체크 의미 없음
      }

      if (!tgt.trim()) continue; // 원문도 번역문도 비어있으면 건너뛰기

      // 2. 원문과 번역문 동일
      if (src === tgt) {
        issues.push({ ...seg, type: QA_LABELS.IDENTICAL, detail: '원문과 번역문이 동일합니다.' });
      }

      // 3. 앞 공백
      if (tgt !== tgt.trimStart()) {
        const spaceLen = tgt.length - tgt.trimStart().length;
        issues.push({ ...seg, type: QA_LABELS.LEADING_SPACE, detail: '번역문 앞에 불필요한 공백이 있습니다.', selectStart: 0, selectEnd: spaceLen });
      }

      // 4. 뒤 공백
      if (tgt !== tgt.trimEnd()) {
        const trimmed = tgt.trimEnd();
        issues.push({ ...seg, type: QA_LABELS.TRAILING_SPACE, detail: '번역문 뒤에 불필요한 공백이 있습니다.', selectStart: trimmed.length, selectEnd: tgt.length });
      }

      // 5. 연속 공백 (줄바꿈 제외한 공백이 2개 이상)
      const consMatch = /[^\S\n]{2,}/.exec(tgt);
      if (consMatch) {
        issues.push({ ...seg, type: QA_LABELS.CONSECUTIVE_SPACE, detail: '연속 공백이 포함되어 있습니다.', selectStart: consMatch.index, selectEnd: consMatch.index + consMatch[0].length });
      }

      // 6. 숫자 불일치 (태그 내부 숫자 제외, 빈도 기반 비교)
      const srcNums = extractNumbers(src);
      const tgtNums = extractNumbers(tgt);

      // 빈도 맵 생성
      const srcFreq = {};
      const tgtFreq = {};
      for (const n of srcNums) srcFreq[n] = (srcFreq[n] || 0) + 1;
      for (const n of tgtNums) tgtFreq[n] = (tgtFreq[n] || 0) + 1;

      const allKeys = new Set([...Object.keys(srcFreq), ...Object.keys(tgtFreq)]);
      const diffs = [];
      for (const key of allKeys) {
        const sCount = srcFreq[key] || 0;
        const tCount = tgtFreq[key] || 0;
        if (sCount !== tCount) {
          if (tCount === 0) diffs.push(`"${key}" 누락`);
          else if (sCount === 0) diffs.push(`"${key}" 추가됨`);
          else diffs.push(`"${key}" 원문${sCount}개→번역문${tCount}개`);
        }
      }

      if (diffs.length > 0) {
        issues.push({ ...seg, type: QA_LABELS.NUMBER_MISMATCH, detail: diffs.join(', ') });
      }

      // 7. 괄호 짝 불일치
      for (const [open, close] of BRACKET_PAIRS) {
        const openCount = (tgt.match(new RegExp('\\' + open, 'g')) || []).length;
        const closeCount = (tgt.match(new RegExp('\\' + close, 'g')) || []).length;
        if (openCount !== closeCount) {
          issues.push({
            ...seg, type: QA_LABELS.BRACKET_MISMATCH,
            detail: `${open}${close} 짝 불일치: ${open}=${openCount}개, ${close}=${closeCount}개`,
          });
        }
      }

      // 8. 따옴표 짝 불일치
      for (const [open, close] of QUOTE_PAIRS) {
        if (open === close) continue; // 같은 문자 쌍은 건너뛰기
        const openCount = (tgt.match(new RegExp(open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        const closeCount = (tgt.match(new RegExp(close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        if (openCount !== closeCount) {
          issues.push({
            ...seg, type: QA_LABELS.QUOTE_MISMATCH,
            detail: `${open}${close} 짝 불일치: ${open}=${openCount}개, ${close}=${closeCount}개`,
          });
        }
      }

      // 9. 태그 개수 불일치
      const srcTags = extractTags(src);
      const tgtTags = extractTags(tgt);
      const srcTagsSorted = [...srcTags].sort();
      const tgtTagsSorted = [...tgtTags].sort();
      if (srcTagsSorted.join(',') !== tgtTagsSorted.join(',')) {
        const missingTags = [...srcTagsSorted];
        const extraTags = [...tgtTagsSorted];
        // 빈도 기반 차이 계산
        for (const t of srcTagsSorted) {
          const idx = extraTags.indexOf(t);
          if (idx >= 0) { extraTags.splice(idx, 1); missingTags.splice(missingTags.indexOf(t), 1); }
        }
        let detail = '';
        if (missingTags.length) detail += `누락: ${missingTags.join(', ')}`;
        if (extraTags.length) detail += `${detail ? ' / ' : ''}추가: ${extraTags.join(', ')}`;
        if (!detail) detail = '태그 개수가 다릅니다.';
        issues.push({ ...seg, type: QA_LABELS.TAG_MISMATCH, detail });
      }

      // 10. 태그 순서 불일치 (개수는 같지만 순서가 다른 경우)
      if (srcTagsSorted.join(',') === tgtTagsSorted.join(',') && srcTags.join(',') !== tgtTags.join(',')) {
        issues.push({
          ...seg, type: QA_LABELS.TAG_ORDER,
          detail: `원문: ${srcTags.join(' ')} → 번역문: ${tgtTags.join(' ')}`,
        });
      }

      // 11. 줄바꿈 개수 불일치
      const srcNewlines = countNewlines(src);
      const tgtNewlines = countNewlines(tgt);
      if (srcNewlines !== tgtNewlines) {
        issues.push({
          ...seg, type: QA_LABELS.NEWLINE_MISMATCH,
          detail: `원문: ${srcNewlines}개 → 번역문: ${tgtNewlines}개`,
        });
      }

      // 12. 문장 끝 마침표 불일치
      const srcEndsWithPeriod = /[。.]\s*$/.test(src);
      const tgtEndsWithPeriod = /[。.]\s*$/.test(tgt);
      if (srcEndsWithPeriod !== tgtEndsWithPeriod) {
        issues.push({
          ...seg, type: QA_LABELS.PERIOD_MISMATCH,
          detail: srcEndsWithPeriod ? '원문은 마침표로 끝나지만 번역문은 아닙니다.' : '번역문만 마침표로 끝납니다.',
        });
      }

      // 13. 반복 문자 (한글 1글자 이상 반복)
      const repeatRegex = /([가-힣]{1,4})\1/g;
      let repMatch;
      while ((repMatch = repeatRegex.exec(tgt)) !== null) {
        issues.push({
          ...seg, type: QA_LABELS.REPEAT_CHAR,
          detail: `"${repMatch[1]}" 반복 → "${repMatch[0]}"`,
          selectStart: repMatch.index,
          selectEnd: repMatch.index + repMatch[0].length,
        });
      }

      // 14. 플레이스홀더 앞뒤 공백 불일치
      const placeholderPattern = /\{[^}]+\}|%[sd]|%\d+\$[sd]/g;
      let phMatch;
      while ((phMatch = placeholderPattern.exec(src)) !== null) {
        const ph = phMatch[0];
        const phIdx = tgt.indexOf(ph);
        if (phIdx < 0) continue; // 태그 누락은 별도 체크

        // 원문에서 플레이스홀더 앞뒤 공백 확인
        const srcBefore = phMatch.index > 0 ? src[phMatch.index - 1] === ' ' : false;
        const srcAfter = phMatch.index + ph.length < src.length ? src[phMatch.index + ph.length] === ' ' : false;

        // 번역문에서 플레이스홀더 앞뒤 공백 확인
        const tgtBefore = phIdx > 0 ? tgt[phIdx - 1] === ' ' : false;
        const tgtAfter = phIdx + ph.length < tgt.length ? tgt[phIdx + ph.length] === ' ' : false;

        const diffs = [];
        if (srcBefore !== tgtBefore) diffs.push(`앞 공백 ${srcBefore ? '있음→없음' : '없음→있음'}`);
        if (srcAfter !== tgtAfter) diffs.push(`뒤 공백 ${srcAfter ? '있음→없음' : '없음→있음'}`);

        if (diffs.length > 0) {
          issues.push({
            ...seg, type: QA_LABELS.PLACEHOLDER_SPACE,
            detail: `${ph}: ${diffs.join(', ')}`,
            selectStart: phIdx,
            selectEnd: phIdx + ph.length,
          });
        }
      }
    }

    return issues;
  }

  function displayQA() {
    const issues = runQAChecks();
    const issueCount = issues.length;

    document.getElementById('cat-tb-qa-count').textContent = issueCount;
    const contentEl = document.getElementById('cat-tb-tab-qa');

    if (issueCount === 0) {
      contentEl.innerHTML = '<div class="cat-tb-all-good">✅ QA 체크 완료: 문제가 발견되지 않았습니다!</div>';
      console.log(`${LOG_PREFIX} QA 체크 완료: 문제 없음`);
      return;
    }

    let html = '<table><tr><th>#</th><th>유형</th><th>상세</th></tr>';
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      html += `<tr class="cat-tb-issue-row" data-qa-idx="${i}">`;
      html += `<td class="cat-tb-seg-num">${issue.segNum}</td>`;
      html += `<td class="cat-tb-warn">${escapeHtml(issue.type)}</td>`;
      html += `<td>${escapeHtml(issue.detail)}</td>`;
      html += `</tr>`;
    }
    html += '</table>';
    contentEl.innerHTML = html;

    // 클릭 시 세그먼트 이동 + 문제 위치 하이라이트
    contentEl.querySelectorAll('.cat-tb-issue-row').forEach(row => {
      row.addEventListener('click', () => {
        const issue = issues[parseInt(row.dataset.qaIdx)];
        navigateToSegment(issue.originEl, issue.textarea, issue.selectStart, issue.selectEnd);
        row.classList.add('cat-tb-copied-flash');
        setTimeout(() => row.classList.remove('cat-tb-copied-flash'), 600);
      });
    });

    console.log(`${LOG_PREFIX} QA 체크: ${issueCount}건 발견`);
    if (window.catToast) window.catToast(`⚠ QA: ${issueCount}건 발견`);
  }

  // ═══════════════════════════════════════
  //  클립보드 복사
  // ═══════════════════════════════════════

  function copyToClipboard() {
    const activeTab = document.querySelector('.cat-tb-tab.active')?.dataset.tab;
    if (activeTab === 'validate') copyValidation();
    else if (activeTab === 'qa') copyQA();
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
    const rows = document.querySelectorAll('#cat-tb-tab-validate .cat-tb-issue-row');
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

  function copyQA() {
    const rows = document.querySelectorAll('#cat-tb-tab-qa .cat-tb-issue-row');
    if (rows.length === 0) {
      document.getElementById('cat-tb-status').textContent = '⚠ 복사할 QA 결과가 없습니다.';
      return;
    }
    let text = '세그먼트\t유형\t상세\n';
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      text += `${cells[0].textContent}\t${cells[1].textContent}\t${cells[2].textContent}\n`;
    });
    navigator.clipboard.writeText(text).then(() => {
      document.getElementById('cat-tb-status').textContent =
        `✅ ${rows.length}건 QA 결과가 클립보드에 복사되었습니다.`;
    });
  }

  // ═══════════════════════════════════════
  //  로드 완료
  // ═══════════════════════════════════════

  console.log(`${LOG_PREFIX} v4.5 로드 완료`);
  console.log('  Alt+B → TB/QA 도구 팝업 열기/닫기 (목록 + TB검수 + QA)');
})();
