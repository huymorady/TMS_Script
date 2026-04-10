// ==UserScript==
// @name         나라 맞춤법 검사기 - 자동 붙여넣기
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  CAT 툴에서 열었을 때 (?auto=true) 클립보드 자동 붙여넣기 + 검사 실행
// @match        *://nara-speller.co.kr/speller/*
// @updateURL    https://raw.githubusercontent.com/huymorady/TMS_Script/main/nara-speller-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/huymorady/TMS_Script/main/nara-speller-auto.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // auto=true 파라미터가 없으면 실행하지 않음
  const params = new URLSearchParams(window.location.search);
  if (params.get('auto') !== 'true') return;

  console.log('[맞춤법 자동검사] 자동 모드 감지됨');

  // 페이지 로드 후 입력란과 버튼이 준비될 때까지 대기
  waitForReady().then(async ({ textarea, button }) => {
    try {
      // 클립보드에서 텍스트 읽기
      const text = await navigator.clipboard.readText();

      if (!text || !text.trim()) {
        console.log('[맞춤법 자동검사] 클립보드가 비어있습니다.');
        return;
      }

      console.log(`[맞춤법 자동검사] 클립보드 텍스트 (${text.length}자) 붙여넣기 중...`);

      // 입력란에 텍스트 삽입
      textarea.focus();
      textarea.value = text;

      // React/Next.js 반응성을 위한 이벤트 트리거
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));

      // React의 내부 상태를 업데이트하기 위한 네이티브 setter 호출
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set;
      nativeSetter.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      // 잠시 대기 후 검사 버튼 클릭
      setTimeout(() => {
        button.click();
        console.log('[맞춤법 자동검사] 검사 버튼 클릭 완료');
      }, 300);

    } catch (err) {
      console.log('[맞춤법 자동검사] 클립보드 접근 실패:', err);
      console.log('[맞춤법 자동검사] Ctrl+V로 직접 붙여넣기 해주세요.');
    }
  });

  /**
   * textarea와 검사 버튼이 준비될 때까지 대기
   */
  function waitForReady(timeout = 5000) {
    return new Promise((resolve) => {
      const check = () => {
        const textarea = document.querySelector('textarea[name="speller-text"]');
        const button = document.querySelector('button[type="submit"]');
        if (textarea && button) {
          resolve({ textarea, button });
          return true;
        }
        return false;
      };

      if (check()) return;

      const observer = new MutationObserver(() => {
        if (check()) observer.disconnect();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        check();
      }, timeout);
    });
  }
})();
