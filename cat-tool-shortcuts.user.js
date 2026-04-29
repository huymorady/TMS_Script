// ==UserScript==
// @name         CAT Tool - 단축키 모음
// @namespace    http://tampermonkey.net/
// @version      6.4
// @description  Alt+` → TB 추가 / Alt+1~6 → TM 검색/사전/CAT 체크 / Alt+S → 맞춤법 / Alt+T → 태그 / Alt+H → 도움말
// @match        *://tms.skyunion.net/*
// @updateURL    https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-shortcuts.user.js
// @downloadURL  https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-shortcuts.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════
  //  상수 정의
  // ═══════════════════════════════════════

  const LOG_PREFIX = '[CAT 단축키]';

  // DOM 셀렉터
  const SEL = {
    ORIGIN: '.origin_string',
    TEXTAREA: 'textarea.n-input__textarea-el',
    ROW: '[data-v-9a359d1f]',
    DROPDOWN_LABEL: '.n-dropdown-option-body_label, [class*="dropdown-option"] [class*="label"]',
    DROPDOWN_OPTION: '[data-dropdown-option]',
    BUTTON_ICON: 'span.n-button__icon',
    CAT_CONTAINER: '#resultList',
    CAT_CHECK_BTN: 'tbody td.\\!px-\\[2px\\] button.n-button--default-type',
    MODAL_INPUT: '.n-modal-container input.n-input__input-el, .n-modal input.n-input__input-el',
    SEARCH_INPUT: '.n-input-group input.n-input__input-el',
    RADIO_INPUT: '.n-radio-group input.n-radio-input',
    TABS: '.n-tabs-tab',
  };

  // 메뉴 텍스트
  const MENU = {
    ADD_TB: '添加术语表',
    SEARCH_TM: '搜索记忆库',
    GLOBAL_SEARCH: 'globalSearch',
    GLOBAL_SEARCH_TEXT: '全局搜索',
    SEARCH_BTN: '搜索',
  };

  // TB 기본값
  const TB_DEFAULT_NOTE = '용어';

  // 사전 URL
  const DICT_URLS = {
    2: 'https://zh.dict.naver.com/#/search?query=',
    3: 'https://en.dict.naver.com/#/search?query=',
    4: 'https://ko.dict.naver.com/#/search?query=',
  };
  const DICT_NAMES = { 2: '중국어', 3: '영어', 4: '한국어' };

  // 맞춤법 검사기 URL
  const SPELLER_URL = 'https://nara-speller.co.kr/speller/?auto=true';

  // === SHARED TOKEN PATTERN ===
  // cat-tool-chat.user.js / cat-tool-tb.user.js와 동일한 union. 세 곳 함께 유지.
  const TAG_PATTERN = new RegExp(
    '\\{[^{}]+\\}'                  // {value1}, {0}, {한글}, {user.name}
    + '|%\\d+\\$[sd@]'              // %1$s, %2$d, %1$@
    + '|%[@sd]'                       // %s, %d, %@
    + '|\\\\[nrt]'                  // \n \r \t 리터럴
    + '|</?[a-zA-Z][^>]*>'            // <br>, <color>, <b>, <size>, <sprite> 등
    + '|\\[/?[a-zA-Z][^\\]]*\\]'   // [color], [b], [url] 등
  , 'g');

  // ═══════════════════════════════════════
  //  상태 관리
  // ═══════════════════════════════════════

  let tagQueue = [];
  let tagIndex = 0;
  let tagSourceEl = null;
  let imeFixInProgress = false;
  let helpPanel = null;

  // ═══════════════════════════════════════
  //  공통 유틸리티 함수
  // ═══════════════════════════════════════

  /**
   * textarea에서 같은 행의 원문 요소 찾기
   */
  function findOriginForTextarea(textarea) {
    // 방법 1: DOM 구조 기반
    const row = textarea.closest(SEL.ROW)
      || textarea.closest('.n-input')?.parentElement?.parentElement;
    if (row) {
      const origin = row.querySelector(SEL.ORIGIN)
        || row.parentElement?.querySelector(SEL.ORIGIN);
      if (origin) return origin;
    }

    // 방법 2: 인덱스 기반
    const allTextareas = document.querySelectorAll(SEL.TEXTAREA);
    const allOrigins = document.querySelectorAll(SEL.ORIGIN);
    const idx = Array.from(allTextareas).indexOf(textarea);
    if (idx >= 0 && idx < allOrigins.length) {
      return allOrigins[idx];
    }

    return null;
  }

  /**
   * textarea에서 같은 행의 번역문 텍스트 가져오기
   */
  function getTranslationForOrigin(originEl) {
    const row = originEl.closest(SEL.ROW) || originEl.parentElement;
    if (row) {
      const textarea = row.querySelector(SEL.TEXTAREA);
      if (textarea && textarea.value.trim()) return textarea.value.trim();
    }

    // 인덱스 기반 fallback
    const allOrigins = document.querySelectorAll(SEL.ORIGIN);
    const allTextareas = document.querySelectorAll(SEL.TEXTAREA);
    const originToFind = originEl.classList.contains('origin_string')
      ? originEl : originEl.closest(SEL.ORIGIN);
    const idx = Array.from(allOrigins).indexOf(originToFind);
    if (idx >= 0 && idx < allTextareas.length && allTextareas[idx].value.trim()) {
      return allTextareas[idx].value.trim();
    }

    return '';
  }

  /**
   * 현재 선택된 텍스트 가져오기 (일반 선택 + textarea 내부 선택)
   */
  function getSelectedText() {
    let text = window.getSelection().toString().trim();
    if (!text) {
      const active = document.activeElement;
      if (active && active.tagName === 'TEXTAREA' && active.selectionStart !== active.selectionEnd) {
        text = active.value.substring(active.selectionStart, active.selectionEnd).trim();
      }
    }
    return text;
  }

  /**
   * 텍스트 선택 여부 확인 (일반 + textarea 내부)
   */
  function hasTextSelection() {
    if (!window.getSelection().isCollapsed) return true;
    const active = document.activeElement;
    return active && active.tagName === 'TEXTAREA' && active.selectionStart !== active.selectionEnd;
  }

  /**
   * 커서 위치에 텍스트 삽입
   */
  function insertTextAtCursor(text) {
    const active = document.activeElement;

    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      active.value = active.value.substring(0, start) + text + active.value.substring(end);
      active.selectionStart = active.selectionEnd = start + text.length;
      active.dispatchEvent(new Event('input', { bubbles: true }));
      console.log(`${LOG_PREFIX} "${text}" 입력 완료 (textarea)`);
      return;
    }

    if (active && active.isContentEditable) {
      document.execCommand('insertText', false, text);
      console.log(`${LOG_PREFIX} "${text}" 입력 완료 (contentEditable)`);
      return;
    }

    console.log(`${LOG_PREFIX} 포커스된 입력 필드가 없습니다.`);
  }

  /**
   * input 요소에 값 설정 (Vue/React 반응성 대응)
   */
  function setInputValue(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * textarea 요소에 값 설정 (Vue/React 반응성 대응)
   */
  function setTextareaValue(textarea, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeSetter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * 문자열 내 부분 문자열 등장 횟수
   */
  function countOccurrences(str, substr) {
    let count = 0, pos = 0;
    while ((pos = str.indexOf(substr, pos)) !== -1) { count++; pos += substr.length; }
    return count;
  }

  /**
   * 드롭다운 메뉴에서 특정 텍스트를 가진 요소가 나타날 때까지 대기
   */
  function waitForElement(text, timeout = 2000) {
    return new Promise((resolve) => {
      const found = findMenuButton(text);
      if (found) { resolve(found); return; }

      const observer = new MutationObserver(() => {
        const el = findMenuButton(text);
        if (el) { observer.disconnect(); resolve(el); }
      });

      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(findMenuButton(text)); }, timeout);
    });
  }

  /**
   * 드롭다운 옵션 중 해당 텍스트 요소 찾기
   */
  function findMenuButton(text) {
    const labels = document.querySelectorAll(SEL.DROPDOWN_LABEL);
    for (const label of labels) {
      if (label.textContent.trim() === text) {
        return label.closest(SEL.DROPDOWN_OPTION) || label.closest('[class*="dropdown-option"]') || label;
      }
    }

    const allElements = document.querySelectorAll('div, span, li, a');
    for (const el of allElements) {
      if (el.textContent.trim() === text && el.children.length === 0 && el.offsetParent !== null) {
        return el.closest(SEL.DROPDOWN_OPTION) || el;
      }
    }
    return null;
  }

  /**
   * 드래그 가능 패널 설정
   */
  function makeDraggable(headerEl, panelEl) {
    let dragging = false, startX, startY, panelX, panelY;

    headerEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = panelEl.getBoundingClientRect();
      panelX = rect.left; panelY = rect.top;
      panelEl.style.transform = 'none';
      panelEl.style.left = panelX + 'px';
      panelEl.style.top = panelY + 'px';
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

  // ═══════════════════════════════════════
  //  1단계: 키 이벤트 리스너 (document-start)
  // ═══════════════════════════════════════

  // ─── Ctrl+Enter: IME 확정 + 줄 끝 공백 제거 후 저장 ───
  document.addEventListener(
    'keydown',
    function (e) {
      if (e.ctrlKey && e.key === 'Enter' && !imeFixInProgress) {
        const active = document.activeElement;
        if (active && active.tagName === 'TEXTAREA') {
          e.preventDefault();
          e.stopImmediatePropagation();

          active.blur();
          active.focus();

          const original = active.value;
          const cleaned = original.replace(/ +$/gm, '');
          if (original !== cleaned) {
            setTextareaValue(active, cleaned);
            console.log(`${LOG_PREFIX} 줄 끝 공백 제거 완료`);
          }

          console.log(`${LOG_PREFIX} IME 조합 확정 후 저장 실행`);
          showToast('💾 저장 중...');

          imeFixInProgress = true;
          setTimeout(() => {
            active.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
            }));
            imeFixInProgress = false;
          }, 50);
        }
      }
    },
    true
  );

  // ─── Alt 키 조합 핸들러 ───
  document.addEventListener(
    'keydown',
    function (e) {
      if (!e.altKey || e.ctrlKey) return;

      const active = document.activeElement;
      const hasSelection = hasTextSelection();

      // ─── Alt+Shift+S: 전체 맞춤법 검사 ───
      if (e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault(); e.stopImmediatePropagation();
        spellCheckAll();
        return;
      }

      // ─── Alt+Shift+W: 전체 세그먼트 일괄 삽입 (번역 조회) ───
      // (번역 조회 스크립트에서 처리)

      if (e.shiftKey) return;

      // ─── Alt+H: 도움말 ───
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault(); e.stopImmediatePropagation();
        initHelpPanel();
        helpPanel.classList.toggle('visible');
        return;
      }

      // ─── Alt+S: 현재 세그먼트 맞춤법 검사 ───
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault(); e.stopImmediatePropagation();
        spellCheckCurrent();
        return;
      }

      // ─── Alt+T: 태그 삽입 ───
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault(); e.stopImmediatePropagation();
        insertNextTag();
        return;
      }

      // ─── Alt+`: TB 추가 (드래그 필수) ───
      if (e.key === '`' || e.key === '~') {
        if (!hasSelection) return;
        e.preventDefault(); e.stopImmediatePropagation();
        handleTbAdd();
        return;
      }

      // ─── Alt+1~6 ───
      const num = parseInt(e.key);
      if (num >= 1 && num <= 6) {
        e.preventDefault(); e.stopImmediatePropagation();

        if (hasSelection) {
          const selectedText = getSelectedText();
          const isFromTextarea = (active && active.tagName === 'TEXTAREA');

          if (num === 1) {
            triggerGlobalSearch(selectedText, isFromTextarea);
          } else if (DICT_URLS[num]) {
            window.open(DICT_URLS[num] + encodeURIComponent(selectedText), '_blank');
            showToast(`📖 ${DICT_NAMES[num]} 사전: "${selectedText}"`);
            console.log(`${LOG_PREFIX} ${DICT_NAMES[num]} 사전 검색: "${selectedText}"`);
          }
        } else {
          clickCatCheckButton(num);
        }
        return;
      }
    },
    true
  );

  // ═══════════════════════════════════════
  //  기능 함수: TB 추가
  // ═══════════════════════════════════════

  function handleTbAdd() {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    const originEl = selection.anchorNode.parentElement?.closest(SEL.ORIGIN)
      || selection.anchorNode.parentElement;

    let translationText = '';
    if (originEl) {
      translationText = getTranslationForOrigin(originEl);
    }

    triggerContextMenu(MENU.ADD_TB, 'TB 추가', translationText, selectedText);
  }

  function triggerContextMenu(menuText, label, autoFillTranslation, autoFillSource) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      console.log(`${LOG_PREFIX} ${label}: 선택된 텍스트가 없습니다.`);
      return;
    }

    console.log(`${LOG_PREFIX} ${label} 실행 - 선택: "${selection.toString()}"`);

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y) || selection.anchorNode.parentElement;

    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, view: window,
    }));

    waitForElement(menuText).then((btn) => {
      if (btn) {
        btn.click();
        console.log(`${LOG_PREFIX} ${menuText} 클릭 완료`);
        if (menuText === MENU.ADD_TB) {
          fillTbPopup(autoFillTranslation, autoFillSource);
        }
      } else {
        console.log(`${LOG_PREFIX} ${menuText} 버튼을 찾지 못했습니다.`);
      }
    });
  }

  function fillTbPopup(translationText, sourceText) {
    const checkPopup = (attempts = 0) => {
      const inputs = document.querySelectorAll(SEL.MODAL_INPUT);

      if (inputs.length < 3 && attempts < 20) {
        setTimeout(() => checkPopup(attempts + 1), 100);
        return;
      }
      if (inputs.length < 3) {
        console.log(`${LOG_PREFIX} TB 팝업 입력 필드를 찾지 못했습니다.`);
        return;
      }

      setInputValue(inputs[0], TB_DEFAULT_NOTE);

      if (sourceText) {
        setInputValue(inputs[1], sourceText);
      }
      if (translationText) {
        setInputValue(inputs[2], translationText);
      }
      showToast(`✅ TB 추가: ${sourceText || '(원문)'} → ${translationText || '(번역문 없음)'}`);
      console.log(`${LOG_PREFIX} TB 팝업 자동 입력 완료`);
    };
    setTimeout(() => checkPopup(), 300);
  }

  // ═══════════════════════════════════════
  //  기능 함수: TM 검색 (全局搜索)
  // ═══════════════════════════════════════

  function triggerGlobalSearch(searchText, reverseDirection) {
    const tabs = document.querySelectorAll(SEL.TABS);
    let globalSearchTab = null;
    for (const tab of tabs) {
      if (tab.getAttribute('data-name') === MENU.GLOBAL_SEARCH || tab.textContent.trim() === MENU.GLOBAL_SEARCH_TEXT) {
        globalSearchTab = tab;
        break;
      }
    }

    if (!globalSearchTab) {
      console.log(`${LOG_PREFIX} 全局搜索 탭을 찾지 못했습니다.`);
      return;
    }

    globalSearchTab.click();
    console.log(`${LOG_PREFIX} 全局搜索 탭 클릭 완료 (방향: ${reverseDirection ? 'ko→zh' : 'zh→ko'})`);
    showToast(`🔍 TM 검색: "${searchText}" (${reverseDirection ? 'ko→zh' : 'zh→ko'})`);
    fillTmSearch(searchText, reverseDirection);
  }

  function fillTmSearch(searchText, reverseDirection) {
    const checkSearch = (attempts = 0) => {
      const searchInputs = document.querySelectorAll(SEL.SEARCH_INPUT);

      if (searchInputs.length === 0 && attempts < 20) {
        setTimeout(() => checkSearch(attempts + 1), 100);
        return;
      }
      if (searchInputs.length === 0) {
        console.log(`${LOG_PREFIX} TM 검색 입력란을 찾지 못했습니다.`);
        return;
      }

      // 검색 방향 라디오 버튼 선택
      const radios = document.querySelectorAll(SEL.RADIO_INPUT);
      const targetValue = reverseDirection ? '1' : '0';
      for (const radio of radios) {
        if (radio.value === targetValue && !radio.checked) {
          radio.closest('label').click();
          console.log(`${LOG_PREFIX} ${reverseDirection ? 'ko→zh-Hans' : 'zh-Hans→ko'} 방향 선택`);
          break;
        }
      }

      const searchInput = searchInputs[searchInputs.length - 1];
      setInputValue(searchInput, searchText);
      console.log(`${LOG_PREFIX} TM 검색어 → "${searchText}" 입력 완료`);

      // 검색 버튼 클릭
      const buttons = searchInput.closest('.n-input-group')?.querySelectorAll('button');
      if (buttons) {
        for (const btn of buttons) {
          if (btn.textContent.trim() === MENU.SEARCH_BTN) {
            btn.click();
            console.log(`${LOG_PREFIX} TM 검색 버튼 클릭 완료`);
            break;
          }
        }
      }
    };
    setTimeout(() => checkSearch(), 300);
  }

  // ═══════════════════════════════════════
  //  기능 함수: CAT 목록 체크
  // ═══════════════════════════════════════

  function clickCatCheckButton(n) {
    console.log(`${LOG_PREFIX} CAT 목록 ${n}번 체크 버튼 클릭 시도`);

    const container = document.getElementById('resultList');
    if (!container) {
      console.log(`${LOG_PREFIX} CAT 목록(#resultList)을 찾지 못했습니다.`);
      return;
    }

    // 각 행의 td.!px-[2px] 안에서 마지막 n-button--default-type 버튼을 수집
    // (X 버튼이 첫 번째, 체크/적용 버튼이 마지막에 위치)
    const actionCells = container.querySelectorAll('tbody td.\\!px-\\[2px\\]');
    const checkButtons = [];

    for (const td of actionCells) {
      const defaultBtns = td.querySelectorAll('button.n-button--default-type');
      if (defaultBtns.length > 0) {
        checkButtons.push(defaultBtns[defaultBtns.length - 1]); // 마지막 default-type 버튼
      }
    }

    if (checkButtons.length === 0) {
      console.log(`${LOG_PREFIX} 체크 버튼을 찾지 못했습니다.`);
      showToast('⚠ 체크 버튼을 찾지 못했습니다.');
      return;
    }
    if (n > checkButtons.length) {
      console.log(`${LOG_PREFIX} ${n}번 체크 버튼이 없습니다. (총 ${checkButtons.length}개)`);
      showToast(`⚠ ${n}번 항목이 없습니다. (총 ${checkButtons.length}개)`);
      return;
    }

    checkButtons[n - 1].click();
    showToast(`✓ CAT ${n}번 적용`);
    console.log(`${LOG_PREFIX} CAT 목록 ${n}번 체크 버튼 클릭 완료`);
  }

  // ═══════════════════════════════════════
  //  기능 함수: 태그 삽입
  // ═══════════════════════════════════════

  function insertNextTag() {
    const active = document.activeElement;
    if (!active || active.tagName !== 'TEXTAREA') {
      console.log(`${LOG_PREFIX} 번역 입력창에 포커스가 없습니다.`);
      return;
    }

    const originEl = findOriginForTextarea(active);
    if (!originEl) {
      console.log(`${LOG_PREFIX} 원문을 찾을 수 없습니다.`);
      return;
    }

    // 세그먼트 변경 시 리셋
    if (originEl !== tagSourceEl) {
      tagSourceEl = originEl;
      tagQueue = originEl.textContent.match(TAG_PATTERN) || [];
      tagIndex = 0;
      console.log(`${LOG_PREFIX} 태그 추출: [${tagQueue.join(', ')}] (${tagQueue.length}개)`);
    }

    if (tagQueue.length === 0) {
      showToast('⚠ 원문에 태그가 없습니다.');
      console.log(`${LOG_PREFIX} 원문에 태그가 없습니다.`);
      return;
    }

    if (tagIndex >= tagQueue.length) {
      console.log(`${LOG_PREFIX} 모든 태그를 삽입했습니다. 처음부터 다시 시작합니다.`);
      tagIndex = 0;
    }

    // 중복 건너뛰기
    const currentValue = active.value;
    let skipped = 0;
    while (tagIndex < tagQueue.length && skipped < tagQueue.length) {
      const candidate = tagQueue[tagIndex];
      const countInTranslation = countOccurrences(currentValue, candidate);
      const countInSource = countOccurrences(tagQueue.slice(0, tagIndex + 1).join('||'), candidate);
      if (countInTranslation >= countInSource) {
        console.log(`${LOG_PREFIX} "${candidate}" 이미 존재 → 건너뛰기`);
        tagIndex++;
        skipped++;
        if (tagIndex >= tagQueue.length) tagIndex = 0;
      } else {
        break;
      }
    }

    if (skipped >= tagQueue.length) {
      showToast('✅ 모든 태그가 이미 삽입되어 있습니다.');
      console.log(`${LOG_PREFIX} 모든 태그가 이미 번역문에 존재합니다.`);
      return;
    }

    const tag = tagQueue[tagIndex];
    insertTextAtCursor(tag);
    showToast(`🏷 태그 삽입: ${tag} (${tagIndex + 1}/${tagQueue.length})`);
    console.log(`${LOG_PREFIX} 태그 삽입: "${tag}" (${tagIndex + 1}/${tagQueue.length})`);
    tagIndex++;
  }

  // ═══════════════════════════════════════
  //  기능 함수: 맞춤법 검사
  // ═══════════════════════════════════════

  function spellCheckCurrent() {
    const active = document.activeElement;
    let text = '';
    if (active && active.tagName === 'TEXTAREA') text = active.value.trim();
    else if (active && active.isContentEditable) text = active.textContent.trim();

    if (!text) {
      console.log(`${LOG_PREFIX} 현재 세그먼트에 번역문이 없습니다.`);
      return;
    }

    navigator.clipboard.writeText(text).then(() => {
      showToast(`📝 맞춤법 검사: ${text.length}자 복사됨`);
      console.log(`${LOG_PREFIX} 현재 세그먼트 복사 완료 (${text.length}자)`);
      window.open(SPELLER_URL, '_blank');
    });
  }

  function spellCheckAll() {
    const textareas = document.querySelectorAll(SEL.TEXTAREA);
    const texts = [];
    for (const ta of textareas) {
      const val = ta.value.trim();
      if (val) texts.push(val);
    }

    if (texts.length === 0) {
      console.log(`${LOG_PREFIX} 번역문이 없습니다.`);
      return;
    }

    const combined = texts.join('\n');
    navigator.clipboard.writeText(combined).then(() => {
      showToast(`📝 전체 맞춤법 검사: ${texts.length}개 세그먼트 복사됨`);
      console.log(`${LOG_PREFIX} 전체 세그먼트 복사 완료 (${texts.length}개, ${combined.length}자)`);
      window.open(SPELLER_URL, '_blank');
    });
  }

  // ═══════════════════════════════════════
  //  2단계: UI 생성 (DOMContentLoaded)
  // ═══════════════════════════════════════

  // ─── 토스트 알림 시스템 ───
  let toastContainer = null;
  let toastTimer = null;

  function initToast() {
    if (toastContainer) return;

    toastContainer = document.createElement('div');
    toastContainer.id = 'cat-toast-container';
    document.body.appendChild(toastContainer);

    const toastStyle = document.createElement('style');
    toastStyle.textContent = `
      #cat-toast-container {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 100001;
        pointer-events: none;
      }
      .cat-toast {
        background: #333;
        color: #e0e0e0;
        padding: 8px 18px;
        border-radius: 6px;
        font-family: -apple-system, sans-serif;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        border-left: 3px solid #5ac8a0;
        opacity: 0;
        transform: translateY(10px);
        transition: opacity 0.3s, transform 0.3s;
        white-space: nowrap;
      }
      .cat-toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      .cat-toast.hide {
        opacity: 0;
        transform: translateY(-10px);
      }
    `;
    document.head.appendChild(toastStyle);
  }

  function showToast(message, duration = 2000) {
    initToast();

    // 기존 토스트 제거
    if (toastTimer) clearTimeout(toastTimer);
    toastContainer.innerHTML = '';

    const toast = document.createElement('div');
    toast.className = 'cat-toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);

    // 등장 애니메이션
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // 사라짐
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => { toastContainer.innerHTML = ''; }, 300);
    }, duration);
  }

  // window 객체에 등록 (다른 스크립트에서 접근 가능)
  window.catToast = showToast;

  function initHelpPanel() {
    if (helpPanel) return;

    helpPanel = document.createElement('div');
    helpPanel.id = 'cat-help-panel';
    helpPanel.innerHTML = `
    <div id="cat-help-header">
      <span id="cat-help-title">❓ 단축키 도움말</span>
      <button id="cat-help-close" title="닫기">✕</button>
    </div>
    <div id="cat-help-body">
      <table>
        <tr><th colspan="3" class="cat-help-section">📌 단축키 모음</th></tr>
        <tr><td>Alt + \`</td><td>드래그 필수</td><td>TB 추가 (비고/원문/번역문 자동 입력)</td></tr>
        <tr><td>Alt + 1</td><td>드래그 O</td><td>TM 검색 (원문: zh→ko / 번역문: ko→zh)</td></tr>
        <tr><td>Alt + 2</td><td>드래그 O</td><td>네이버 중국어 사전 검색</td></tr>
        <tr><td>Alt + 3</td><td>드래그 O</td><td>네이버 영어 사전 검색</td></tr>
        <tr><td>Alt + 4</td><td>드래그 O</td><td>네이버 한국어 사전 검색</td></tr>
        <tr><td>Alt + 1~6</td><td>드래그 X</td><td>CAT 목록 N번 체크 버튼 클릭</td></tr>
        <tr><td>Alt + T</td><td>입력창 포커스</td><td>원문 태그 순서대로 삽입 (중복 건너뛰기)</td></tr>
        <tr><td>Alt + S</td><td>입력창 포커스</td><td>현재 세그먼트 맞춤법 검사</td></tr>
        <tr><td>Alt + Shift + S</td><td>-</td><td>전체 세그먼트 맞춤법 검사</td></tr>
        <tr><td>Ctrl + Enter</td><td>입력창 포커스</td><td>IME 확정 + 줄 끝 공백 제거 후 저장</td></tr>
        <tr><th colspan="3" class="cat-help-section">📋 번역 조회</th></tr>
        <tr><td>Alt + Q</td><td>-</td><td>번역 조회 팝업 열기/닫기</td></tr>
        <tr><td>Alt + W</td><td>입력창 포커스</td><td>현재 세그먼트 매칭 삽입</td></tr>
        <tr><td>Alt + Shift + W</td><td>-</td><td>전체 세그먼트 일괄 매칭 삽입</td></tr>
        <tr><th colspan="3" class="cat-help-section">📖 TB 도구</th></tr>
        <tr><td>Alt + B</td><td>-</td><td>TB 도구 팝업 열기/닫기 (목록 + 검수)</td></tr>
        <tr><th colspan="3" class="cat-help-section">💡 팝업 공통</th></tr>
        <tr><td colspan="2">헤더 제목 클릭</td><td>접기/펼치기</td></tr>
        <tr><td colspan="2">헤더 드래그</td><td>위치 이동</td></tr>
        <tr><td>Alt + H</td><td>-</td><td>이 도움말 열기/닫기</td></tr>
      </table>
    </div>`;

    const helpStyle = document.createElement('style');
    helpStyle.textContent = `
      #cat-help-panel {
        display: none; position: fixed; top: 50%; left: 50%;
        transform: translate(-50%, -50%); width: 520px; max-height: 80vh;
        background: #2a2a2e; border: 1px solid #555; border-radius: 8px;
        z-index: 100000; font-family: -apple-system, sans-serif;
        font-size: 13px; color: #e0e0e0; box-shadow: 0 8px 30px rgba(0,0,0,0.6);
        flex-direction: column;
      }
      #cat-help-panel.visible { display: flex; }
      #cat-help-panel.collapsed #cat-help-body { display: none; }
      #cat-help-panel.collapsed { max-height: none; transform: none; }
      #cat-help-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 14px; background: #3a3a3e; border-radius: 8px 8px 0 0;
        font-weight: bold; font-size: 14px; cursor: grab; user-select: none;
      }
      #cat-help-header:active { cursor: grabbing; }
      #cat-help-panel.collapsed #cat-help-header { border-radius: 8px; }
      #cat-help-title { cursor: pointer; }
      #cat-help-close {
        background: none; border: none; color: #e0e0e0; cursor: pointer;
        font-size: 16px; padding: 2px 6px; border-radius: 4px;
      }
      #cat-help-close:hover { background: #555; }
      #cat-help-body { overflow-y: auto; max-height: calc(80vh - 50px); padding: 10px 14px 14px; }
      #cat-help-body table { width: 100%; border-collapse: collapse; }
      #cat-help-body th, #cat-help-body td { padding: 5px 8px; border: 1px solid #444; font-size: 12px; text-align: left; }
      .cat-help-section { background: #333 !important; color: #5ac8a0; font-size: 13px !important; padding: 8px !important; }
      #cat-help-body td:first-child { color: #d9d95a; white-space: nowrap; font-weight: bold; }
      #cat-help-body td:nth-child(2) { color: #aaa; white-space: nowrap; font-size: 11px; }
    `;
    document.head.appendChild(helpStyle);
    document.body.appendChild(helpPanel);

    // 닫기
    document.getElementById('cat-help-close').addEventListener('click', () => {
      helpPanel.classList.remove('visible');
    });

    // 접기/펼치기
    document.getElementById('cat-help-title').addEventListener('click', () => {
      helpPanel.classList.toggle('collapsed');
    });

    // 드래그
    makeDraggable(document.getElementById('cat-help-header'), helpPanel);

    console.log(`${LOG_PREFIX} 도움말 패널 초기화 완료`);
  }

  // DOM 준비 시 도움말 패널 생성
  if (document.body) {
    initHelpPanel();
  } else {
    document.addEventListener('DOMContentLoaded', initHelpPanel);
  }

  // ═══════════════════════════════════════
  //  로드 완료 로그
  // ═══════════════════════════════════════

  console.log(`${LOG_PREFIX} v6.3 로드 완료`);
  console.log('  Alt+`       → TB 추가 (드래그 필수)');
  console.log('  Alt+1       → 드래그 O: TM 검색 / 드래그 X: CAT 1번 체크');
  console.log('  Alt+2       → 드래그 O: 중국어 사전 / 드래그 X: CAT 2번 체크');
  console.log('  Alt+3       → 드래그 O: 영어 사전 / 드래그 X: CAT 3번 체크');
  console.log('  Alt+4       → 드래그 O: 한국어 사전 / 드래그 X: CAT 4번 체크');
  console.log('  Alt+5~6     → 드래그 X: CAT 5~6번 체크');
  console.log('  Alt+T       → 원문 태그 순서대로 삽입');
  console.log('  Alt+S       → 현재 세그먼트 맞춤법 검사');
  console.log('  Alt+Shift+S → 전체 세그먼트 맞춤법 검사');
  console.log('  Ctrl+Enter  → IME 확정 + 줄 끝 공백 제거 후 저장');
  console.log('  Alt+H       → 단축키 도움말');
})();
