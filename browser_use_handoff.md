# TMS Script / Browser Use Handoff

## Goal

Continue the TMS CAT userscript workflow work in a session where Browser Use is available.

The immediate goal is to use Browser Use to inspect or operate the current TMS CAT page, especially for:

- opening or inspecting the current in-app browser tab
- testing console-side workflow scripts on the CAT page
- eventually checking modal UI behavior for multi-segment workflow

## Workspace

Root:

```text
C:\Users\irisd\OneDrive\AI_Work\.codex_tmp\TMS_Script_review
```

Important files:

```text
test_v31.js
cat-tool-chat.user.js
중한 게임 번역 워크플로우 프롬프트 (v3.1)
TMS CAT 툴 API 레퍼런스
```

## Current Test Status

The compact JSON workflow is the current viable direction.

Confirmed:

- Single-segment detailed Phase 1+2 -> Phase 3 -> Phase 4+5 continuity works.
- 50-segment detailed JSON output is unreliable and can hit Bedrock read timeout.
- 50-segment compact Phase 1+2 works after adding an explicit Allowed IDs whitelist.
- 50-segment compact Phase 3 one-shot works.
- Latest 50-segment compact Phase 3 validation passed:
  - id coverage: OK
  - gid match: OK
  - empty translations: OK
  - placeholder preservation: OK
  - CJK/Hanja residue: OK

## Current test_v31.js State

Key settings:

```js
RUN_MODE = 'phase12-3-compact'
PAGE_SIZE = 50
CHUNK_SIZE = 10
```

Runtime outputs:

```js
window._v31phase12Compact
window._v31phase3Compact
window._v31continuity
window._v31raw
window._v31inspection
localStorage['tms_v31_last_raw']
localStorage['tms_v31_last_inspection']
```

## Recommended Next Step

Do not start by building the modal UI yet.

First use Browser Use on the live TMS CAT page to confirm the compact 50-segment result can be:

1. generated from the current page,
2. validated client-side,
3. mapped back to the correct segment IDs,
4. safely prepared for per-segment application without writing accidental LLM output into the wrong segment.

Only after that, wire the same flow into the modal UI.

## Browser Use Bootstrap

If the new session exposes `node_repl js`, initialize Browser Use with:

```js
if (!globalThis.agent) {
  const { setupAtlasRuntime } = await import("C:/Users/irisd/.codex/plugins/cache/openai-bundled/browser-use/0.1.0-alpha1/scripts/browser-client.mjs");
  await setupAtlasRuntime({ globals: globalThis, backend: "iab" });
}
await agent.browser.nameSession("🔎 TMS workflow");
if (typeof tab === "undefined") {
  globalThis.tab = await agent.browser.tabs.selected();
}
console.log(await tab.url(), await tab.title());
```

If `node_repl js` is not exposed, this session cannot directly drive Browser Use even if the plugin files and backend pipes exist.

## Important Caution

The current test writes LLM output into a scratch segment translation field.

After each test, clean the storage segment in TMS:

```text
T menu -> 清除译文 -> 选中字符串
```

Use the current file's first segment as `storageStringId` if the old requested test string ID is not in the active file.

