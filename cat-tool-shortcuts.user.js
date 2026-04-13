// ==UserScript==
// @name         CAT Tool - 단축키 모음
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  Alt+` → TB 추가 / Alt+1~6 → TM 검색/CAT 체크 / Alt+S → 맞춤법 / Alt+T → 태그 삽입
// @match        *://tms.skyunion.net/*
// @updateURL    https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-shortcuts.user.js
// @downloadURL  https://raw.githubusercontent.com/huymorady/TMS_Script/main/cat-tool-shortcuts.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  console.log('[CAT 단축키] v4.9 로드 완료');
  console.log('  Alt+`       → TB 추가 (드래그 필수)');
  console.log('  Alt+1       → 드래그 O: TM 검색 / 드래그 X: CAT 1번 체크');
  console.log('  Alt+2       → 드래그 O: 중국어 사전 / 드래그 X: CAT 2번 체크');
  console.log('  Alt+3       → 드래그 O: 영어 사전 / 드래그 X: CAT 3번 체크');
  console.log('  Alt+4       → 드래그 O: 한국어 사전 / 드래그 X: CAT 4번 체크');
  console.log('  Alt+5~6     → 드래그 X: CAT 5~6번 체크');
  console.log('  Alt+S       → 현재 세그먼트 맞춤법 검사');
  console.log('  Alt+Shift+S → 전체 세그먼트 맞춤법 검사');
  console.log('  Alt+T       → 원문 태그 순서대로 삽입');
  console.log('  Ctrl+Enter  → IME 조합 확정 후 저장');

  // ─── 태그 삽입용 상태 관리 ───
  let tagQueue = [];       // 추출된 태그 배열
  let tagIndex = 0;        // 현재 삽입할 태그 인덱스
  let tagSourceEl = null;  // 태그를 추출한 원문 요소 (세그먼트 변경 감지용)

  // ─── Ctrl+Enter 저장 시 IME 조합 확정 + 줄 끝 공백 제거 ───
  let imeFixInProgress = false;

  document.addEventListener(
    'keydown',
    function (e) {
      if (e.ctrlKey && e.key === 'Enter' && !imeFixInProgress) {
        const active = document.activeElement;
        if (active && active.tagName === 'TEXTAREA') {
          e.preventDefault();
          e.stopImmediatePropagation();

          // blur → focus로 IME 조합 확정
          active.blur();
          active.focus();

          // 각 줄 끝의 공백(스페이스만) 제거
          const original = active.value;
          const cleaned = original.replace(/ +$/gm, '');
          if (original !== cleaned) {
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeSetter.call(active, cleaned);
            active.dispatchEvent(new Event('input', { bubbles: true }));
            console.log('[CAT 단축키] 줄 끝 공백 제거 완료');
          }

          console.log('[CAT 단축키] IME 조합 확정 후 저장 실행');

          // 짧은 딜레이 후 Ctrl+Enter를 다시 발생시켜 저장 실행
          imeFixInProgress = true;
          setTimeout(() => {
            active.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            }));
            imeFixInProgress = false;
          }, 50);
        }
      }
    },
    true
  );

  document.addEventListener(
    'keydown',
    function (e) {
      if (!e.altKey || e.ctrlKey) return;

      // textarea 내부 선택도 감지
      const active = document.activeElement;
      const textareaSelection = (active && active.tagName === 'TEXTAREA' && active.selectionStart !== active.selectionEnd);
      const hasSelection = !window.getSelection().isCollapsed || textareaSelection;

      // ─── Alt+Shift+S : 전체 세그먼트 맞춤법 검사 ───
      if (e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        spellCheckAll();
        return;
      }

      // 이하 Shift 미사용 단축키
      if (e.shiftKey) return;

      // ─── Alt+S : 현재 세그먼트 맞춤법 검사 ───
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        e.stopImmediatePropagation();
        spellCheckCurrent();
        return;
      }

      // ─── Alt+T : 원문 태그 순서대로 삽입 ───
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        e.stopImmediatePropagation();
        insertNextTag();
        return;
      }

      // ─── Alt+` : TB 추가 (드래그 필수) ───
      if (e.key === '`' || e.key === '~') {
        if (!hasSelection) return;
        e.preventDefault();
        e.stopImmediatePropagation();

        // 드래그한 원문과 같은 행의 번역문을 미리 가져옴
        const selection = window.getSelection();
        const selectedText = selection.toString().trim(); // 드래그한 원문 텍스트
        const originEl = selection.anchorNode.parentElement?.closest('.origin_string')
          || selection.anchorNode.parentElement;
        let translationText = '';

        if (originEl) {
          // 같은 세그먼트 행에서 번역 textarea 찾기
          const row = originEl.closest('[data-v-9a359d1f]')
            || originEl.parentElement;
          if (row) {
            const textarea = row.querySelector('textarea.n-input__textarea-el');
            if (textarea && textarea.value.trim()) {
              translationText = textarea.value.trim();
            }
          }

          // row 기반으로 못 찾으면 인덱스 기반 탐색
          if (!translationText) {
            const allOrigins = document.querySelectorAll('.origin_string');
            const allTextareas = document.querySelectorAll('textarea.n-input__textarea-el');
            const idx = Array.from(allOrigins).indexOf(
              originEl.classList.contains('origin_string') ? originEl : originEl.closest('.origin_string')
            );
            if (idx >= 0 && idx < allTextareas.length && allTextareas[idx].value.trim()) {
              translationText = allTextareas[idx].value.trim();
            }
          }
        }

        triggerContextMenu('添加术语表', 'TB 추가', translationText, selectedText);
        return;
      }

      // ─── Alt+1~6 ───
      const num = parseInt(e.key);
      if (num >= 1 && num <= 6) {
        e.preventDefault();
        e.stopImmediatePropagation();

        if (hasSelection) {
          let selectedText = window.getSelection().toString().trim();

          // textarea 내부 선택인 경우
          if (!selectedText && active && active.tagName === 'TEXTAREA') {
            selectedText = active.value.substring(active.selectionStart, active.selectionEnd).trim();
          }

          // 번역문 입력창에서 검색한 건지 여부
          const isFromTextarea = (active && active.tagName === 'TEXTAREA');

          switch (num) {
            case 1: // TM 검색
              triggerContextMenu('搜索记忆库', 'TM 검색', null, null, selectedText, isFromTextarea);
              break;
            case 2: // 중국어 사전
              window.open('https://zh.dict.naver.com/#/search?query=' + encodeURIComponent(selectedText), '_blank');
              console.log(`[CAT 단축키] 중국어 사전 검색: "${selectedText}"`);
              break;
            case 3: // 영어 사전
              window.open('https://en.dict.naver.com/#/search?query=' + encodeURIComponent(selectedText), '_blank');
              console.log(`[CAT 단축키] 영어 사전 검색: "${selectedText}"`);
              break;
            case 4: // 한국어 사전
              window.open('https://ko.dict.naver.com/#/search?query=' + encodeURIComponent(selectedText), '_blank');
              console.log(`[CAT 단축키] 한국어 사전 검색: "${selectedText}"`);
              break;
            default:
              break;
          }
        } else {
          // 미드래그 → CAT 목록 N번째 체크 버튼 클릭
          clickCatCheckButton(num);
        }
        return;
      }
    },
    true
  );

  /**
   * 현재 포커스된 입력 필드의 커서 위치에 텍스트 삽입
   */
  function insertTextAtCursor(text) {
    const active = document.activeElement;

    // textarea 또는 input 필드
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      const before = active.value.substring(0, start);
      const after = active.value.substring(end);
      active.value = before + text + after;
      active.selectionStart = active.selectionEnd = start + text.length;
      // Vue/React 반응성을 위해 input 이벤트 발생
      active.dispatchEvent(new Event('input', { bubbles: true }));
      console.log(`[CAT 단축키] "${text}" 입력 완료 (textarea)`);
      return;
    }

    // contentEditable 요소
    if (active && active.isContentEditable) {
      document.execCommand('insertText', false, text);
      console.log(`[CAT 단축키] "${text}" 입력 완료 (contentEditable)`);
      return;
    }

    console.log('[CAT 단축키] 포커스된 입력 필드가 없습니다.');
  }

  /**
   * 우클릭 메뉴를 열고 특정 항목 클릭
   * @param {string} menuText - 클릭할 메뉴 텍스트
   * @param {string} label - 로그용 라벨
   * @param {string} [autoFillTranslation] - TB 팝업에 자동 입력할 번역문
   * @param {string} [autoFillSource] - TB 팝업에 자동 입력할 원문
   * @param {string} [searchText] - TM 검색 입력란에 자동 입력할 텍스트
   * @param {boolean} [reverseDirection] - TM 검색 시 ko->zh-Hans 방향 선택
   */
  function triggerContextMenu(menuText, label, autoFillTranslation, autoFillSource, searchText, reverseDirection) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      console.log(`[CAT 단축키] ${label}: 선택된 텍스트가 없습니다.`);
      return;
    }

    console.log(`[CAT 단축키] ${label} 실행 - 선택: "${selection.toString()}"`);

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const target =
      document.elementFromPoint(x, y) ||
      selection.anchorNode.parentElement;

    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 2,
        view: window,
      })
    );

    waitForElement(menuText).then((btn) => {
      if (btn) {
        btn.click();
        console.log(`[CAT 단축키] ${menuText} 클릭 완료`);

        // TB 추가 팝업인 경우 자동 입력
        if (menuText === '添加术语表') {
          fillTbPopup(autoFillTranslation, autoFillSource);
        }

        // TM 검색인 경우 검색어 자동 입력
        if (menuText === '搜索记忆库' && searchText) {
          fillTmSearch(searchText, reverseDirection);
        }
      } else {
        console.log(`[CAT 단축키] ${menuText} 버튼을 찾지 못했습니다.`);
      }
    });
  }

  /**
   * TM 검색(搜索记忆库) 팝업의 검색 입력란에 텍스트 자동 입력 + 검색 실행
   * @param {string} searchText - 검색어
   * @param {boolean} [reverseDirection] - true면 ko->zh-Hans 라디오 버튼 선택
   */
  function fillTmSearch(searchText, reverseDirection) {
    const checkSearch = (attempts = 0) => {
      // 搜索记忆库 패널의 검색 입력란 찾기
      const searchInputs = document.querySelectorAll('.n-input-group input.n-input__input-el');

      if (searchInputs.length === 0 && attempts < 20) {
        setTimeout(() => checkSearch(attempts + 1), 100);
        return;
      }

      if (searchInputs.length === 0) {
        console.log('[CAT 단축키] TM 검색 입력란을 찾지 못했습니다.');
        return;
      }

      // ko->zh-Hans 라디오 버튼 선택 (번역문에서 검색한 경우)
      if (reverseDirection) {
        const radios = document.querySelectorAll('.n-radio-group input.n-radio-input');
        for (const radio of radios) {
          if (radio.value === '1') {
            radio.closest('label').click();
            console.log('[CAT 단축키] ko->zh-Hans 방향 선택');
            break;
          }
        }
      }

      // 마지막으로 나타난 검색 입력란 사용 (搜索记忆库 패널)
      const searchInput = searchInputs[searchInputs.length - 1];

      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeSetter.call(searchInput, searchText);
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      console.log(`[CAT 단축키] TM 검색어 → "${searchText}" 입력 완료`);

      // 검색 버튼 클릭
      const buttons = searchInput.closest('.n-input-group')?.querySelectorAll('button');
      if (buttons) {
        for (const btn of buttons) {
          if (btn.textContent.trim() === '搜索') {
            btn.click();
            console.log('[CAT 단축키] TM 검색 버튼 클릭 완료');
            break;
          }
        }
      }
    };

    setTimeout(() => checkSearch(), 300);
  }

  /**
   * TB 추가 팝업에 术语备注(용어), Chinese Simplified(원문), Korean(번역문) 자동 입력
   */
  function fillTbPopup(translationText, sourceText) {
    // 팝업이 렌더링될 때까지 대기
    const checkPopup = (attempts = 0) => {
      const inputs = document.querySelectorAll('.n-modal-container input.n-input__input-el, .n-modal input.n-input__input-el');

      if (inputs.length < 3 && attempts < 20) {
        setTimeout(() => checkPopup(attempts + 1), 100);
        return;
      }

      if (inputs.length < 3) {
        console.log('[CAT 단축키] TB 팝업 입력 필드를 찾지 못했습니다.');
        return;
      }

      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;

      // 1번째: 术语备注 → '용어' 고정 입력
      nativeSetter.call(inputs[0], '용어');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      console.log('[CAT 단축키] 术语备注 → "용어" 입력 완료');

      // 2번째: Chinese Simplified → 드래그한 원문 입력 (이미 있어도 동일값 덮어쓰기)
      if (sourceText) {
        nativeSetter.call(inputs[1], sourceText);
        inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
        console.log(`[CAT 단축키] Chinese Simplified → "${sourceText}" 입력 완료`);
      }

      // 3번째: Korean → 번역문 자동 입력
      if (translationText) {
        nativeSetter.call(inputs[2], translationText);
        inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
        console.log(`[CAT 단축키] Korean → "${translationText}" 입력 완료`);
      }
    };

    setTimeout(() => checkPopup(), 300);
  }

  /**
   * CAT 목록에서 N번째 행의 체크(✓) 버튼 클릭
   * 체크 버튼: SVG path d="M352 176L..." (체크마크)
   * 휴지통 버튼: 별도 SVG (삭제) → 클릭하지 않음
   */
  function clickCatCheckButton(n) {
    console.log(`[CAT 단축키] CAT 목록 ${n}번 체크 버튼 클릭 시도`);

    // CAT 목록의 체크 버튼들 찾기
    // 체크마크 SVG의 path에 "M352 176" 또는 "M352 17" 패턴이 포함됨
    const allButtons = document.querySelectorAll('span.n-button__icon');
    const checkButtons = [];

    for (const span of allButtons) {
      const svg = span.querySelector('svg');
      if (!svg) continue;

      const paths = svg.querySelectorAll('path');
      let isCheck = false;
      for (const path of paths) {
        const d = path.getAttribute('d') || '';
        // 체크마크 SVG path 패턴 (스크린샷 기준: "M352 176L217.6 336L160 272")
        if (d.includes('352') && d.includes('176') && d.includes('336')) {
          isCheck = true;
          break;
        }
      }

      if (isCheck) {
        // CAT 목록 영역 내의 버튼만 수집 (오른쪽 패널)
        const button = span.closest('button');
        if (button && button.offsetParent !== null) {
          checkButtons.push(button);
        }
      }
    }

    if (checkButtons.length === 0) {
      console.log('[CAT 단축키] 체크 버튼을 찾지 못했습니다.');
      return;
    }

    if (n > checkButtons.length) {
      console.log(`[CAT 단축키] ${n}번 체크 버튼이 없습니다. (총 ${checkButtons.length}개)`);
      return;
    }

    const target = checkButtons[n - 1];
    target.click();
    console.log(`[CAT 단축키] CAT 목록 ${n}번 체크 버튼 클릭 완료`);
  }

  /**
   * 드롭다운 메뉴에서 특정 텍스트를 가진 요소가 나타날 때까지 대기
   */
  function waitForElement(text, timeout = 2000) {
    return new Promise((resolve) => {
      const found = findMenuButton(text);
      if (found) {
        resolve(found);
        return;
      }

      const observer = new MutationObserver(() => {
        const el = findMenuButton(text);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(findMenuButton(text));
      }, timeout);
    });
  }

  /**
   * 드롭다운 옵션 중 해당 텍스트를 포함하는 요소 찾기
   */
  function findMenuButton(text) {
    const labels = document.querySelectorAll(
      '.n-dropdown-option-body_label, [class*="dropdown-option"] [class*="label"]'
    );
    for (const label of labels) {
      if (label.textContent.trim() === text) {
        return (
          label.closest('[data-dropdown-option]') ||
          label.closest('[class*="dropdown-option"]') ||
          label
        );
      }
    }

    const allElements = document.querySelectorAll('div, span, li, a');
    for (const el of allElements) {
      if (
        el.textContent.trim() === text &&
        el.children.length === 0 &&
        el.offsetParent !== null
      ) {
        return el.closest('[data-dropdown-option]') || el;
      }
    }

    return null;
  }

  /**
   * 문자열 내에서 특정 부분 문자열의 등장 횟수를 세기
   */
  function countOccurrences(str, substr) {
    let count = 0;
    let pos = 0;
    while ((pos = str.indexOf(substr, pos)) !== -1) {
      count++;
      pos += substr.length;
    }
    return count;
  }

  /**
   * 원문 텍스트에서 태그를 정규식으로 추출
   */
  function extractTags(text) {
    const tagPattern = new RegExp(
      '\\{\\d+\\}'             // {0}, {1}, {2} ...
      + '|\\{[a-zA-Z_][a-zA-Z0-9_]*\\}'  // {text1}, {name}, {player_name} 등
      + '|%[sd]'               // %s, %d
      + '|%\\d+\\$[sd]'        // %1$s, %2$d
      + '|<br\\s*/?>'          // <br>, <br/>, <br />
      + '|</?[a-zA-Z][^>]*>'   // <color=red>, </color>, <b>, </b>, <i>, </i> 등
      + '|\\\\n'               // \n (이스케이프 줄바꿈)
      + '|\\[/?[a-zA-Z][^\\]]*\\]'  // [color=#FF0000], [/color] 등 BBCode 스타일
    , 'g');

    return text.match(tagPattern) || [];
  }

  /**
   * 현재 포커스된 번역 입력창의 원문에서 태그를 추출하고 다음 태그를 삽입
   */
  function insertNextTag() {
    const active = document.activeElement;
    if (!active || active.tagName !== 'TEXTAREA') {
      console.log('[CAT 단축키] 번역 입력창에 포커스가 없습니다.');
      return;
    }

    // 현재 세그먼트의 원문 요소 찾기
    // textarea에서 위로 올라가서 같은 행의 origin_string을 찾음
    const row = active.closest('[data-v-9a359d1f]')
      || active.closest('.n-input')?.parentElement?.parentElement;

    let originEl = null;
    if (row) {
      originEl = row.querySelector('.origin_string')
        || row.parentElement?.querySelector('.origin_string');
    }

    // row 기반으로 못 찾으면 가장 가까운 origin_string을 탐색
    if (!originEl) {
      const allRows = document.querySelectorAll('.origin_string');
      const textareas = document.querySelectorAll('textarea.n-input__textarea-el');
      const myIndex = Array.from(textareas).indexOf(active);
      if (myIndex >= 0 && myIndex < allRows.length) {
        originEl = allRows[myIndex];
      }
    }

    if (!originEl) {
      console.log('[CAT 단축키] 원문을 찾을 수 없습니다.');
      return;
    }

    // 세그먼트가 바뀌었으면 태그 큐 리셋
    if (originEl !== tagSourceEl) {
      tagSourceEl = originEl;
      tagQueue = extractTags(originEl.textContent);
      tagIndex = 0;
      console.log(`[CAT 단축키] 태그 추출: [${tagQueue.join(', ')}] (${tagQueue.length}개)`);
    }

    // 삽입할 태그가 없거나 다 소진됨
    if (tagQueue.length === 0) {
      console.log('[CAT 단축키] 원문에 태그가 없습니다.');
      return;
    }

    if (tagIndex >= tagQueue.length) {
      console.log('[CAT 단축키] 모든 태그를 삽입했습니다. 처음부터 다시 시작합니다.');
      tagIndex = 0;
    }

    // 번역문에 이미 존재하는 태그는 건너뛰기
    const currentValue = active.value;
    let skipped = 0;
    while (tagIndex < tagQueue.length && skipped < tagQueue.length) {
      const candidate = tagQueue[tagIndex];
      // 번역문에서 해당 태그가 이미 몇 개 있는지 vs 원문에서 몇 개 있어야 하는지 비교
      const countInTranslation = countOccurrences(currentValue, candidate);
      const countInSource = countOccurrences(tagQueue.slice(0, tagIndex + 1).join('||'), candidate);
      // 원문에서의 N번째까지 이미 번역문에 존재하면 건너뛰기
      if (countInTranslation >= countInSource) {
        console.log(`[CAT 단축키] "${candidate}" 이미 존재 → 건너뛰기`);
        tagIndex++;
        skipped++;
        if (tagIndex >= tagQueue.length) tagIndex = 0;
      } else {
        break;
      }
    }

    if (skipped >= tagQueue.length) {
      console.log('[CAT 단축키] 모든 태그가 이미 번역문에 존재합니다.');
      return;
    }

    // 태그 삽입
    const tag = tagQueue[tagIndex];
    insertTextAtCursor(tag);
    console.log(`[CAT 단축키] 태그 삽입: "${tag}" (${tagIndex + 1}/${tagQueue.length})`);
    tagIndex++;
  }

  /**
   * 현재 포커스된 세그먼트의 번역문을 클립보드에 복사 + 맞춤법 검사기 열기
   */
  function spellCheckCurrent() {
    const active = document.activeElement;

    let text = '';
    if (active && active.tagName === 'TEXTAREA') {
      text = active.value.trim();
    } else if (active && active.isContentEditable) {
      text = active.textContent.trim();
    }

    if (!text) {
      console.log('[CAT 단축키] 현재 세그먼트에 번역문이 없습니다.');
      return;
    }

    navigator.clipboard.writeText(text).then(() => {
      console.log(`[CAT 단축키] 현재 세그먼트 복사 완료 (${text.length}자)`);
      window.open('https://nara-speller.co.kr/speller/?auto=true', '_blank');
    });
  }

  /**
   * 전체 세그먼트의 번역문을 클립보드에 복사 + 맞춤법 검사기 열기
   */
  function spellCheckAll() {
    const textareas = document.querySelectorAll('textarea.n-input__textarea-el');
    const texts = [];

    for (const ta of textareas) {
      const val = ta.value.trim();
      if (val) texts.push(val);
    }

    if (texts.length === 0) {
      console.log('[CAT 단축키] 번역문이 없습니다.');
      return;
    }

    const combined = texts.join('\n');
    navigator.clipboard.writeText(combined).then(() => {
      console.log(`[CAT 단축키] 전체 세그먼트 복사 완료 (${texts.length}개, ${combined.length}자)`);
      window.open('https://nara-speller.co.kr/speller/?auto=true', '_blank');
    });
  }
})();
