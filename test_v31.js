// v3.1 프롬프트 테스트 스크립트 (Self-contained)
// 사용법:
//   1. requestedTestStringId를 원하는 세그먼트 ID로 변경
//   2. 콘솔에 전체 붙여넣기 + 엔터
//   3. 테스트 후 해당 세그먼트는 清除译文로 정리

(async () => {
  function normalizeSegmentListResponse(listData) {
    const payload = listData?.data;

    if (Array.isArray(payload)) {
      return {
        segments: payload,
        meta: { shape: 'data[]', count: payload.length }
      };
    }

    if (payload && typeof payload === 'object') {
      const items = Array.isArray(payload.items) ? payload.items
                  : Array.isArray(payload.results) ? payload.results
                  : [];
      return {
        segments: items,
        meta: {
          shape: Array.isArray(payload.items) ? 'data.items[]'
               : Array.isArray(payload.results) ? 'data.results[]'
               : 'data{}',
          count: payload.count ?? items.length,
          page: payload.page,
          totalPage: payload.total_page
        }
      };
    }

    return {
      segments: [],
      meta: { shape: typeof payload, count: 0 }
    };
  }

  // ⚠️ 결과 저장용으로 우선 시도할 세그먼트 ID
  // 현재 파일에 없으면 자동으로 첫 번째 세그먼트 ID를 사용합니다.
  const requestedTestStringId = 5839247;

  // v3.1 프롬프트 (JSON 인코딩되어 안전함)
  const V31_PROMPT = "# 🎮 프로젝트 단위 중한 게임 번역 워크플로우 프롬프트 (v3.1)\n\n[WORKFLOW_MODE]\n\n## CONTEXT & ROLE: 프로젝트 전체를 이해하는 현지화 전문가\n\n당신은 중국어→한국어 게임 현지화 전문가입니다. 이번 작업은 **단일 세그먼트 번역이 아니라 프로젝트 배치 파일 전체를 일관성 있게 번역**하는 작업입니다. 단순 직역이 아닌, 파일 전체의 성격을 파악하고 그룹별 전략을 세운 뒤 각 세그먼트를 일관되게 처리하는 방식으로 접근합니다.\n\n### 🎯 핵심 철학\n\n- **데이터 정확성**: 숫자·고유명사·플레이스홀더·태그·Excel Key는 **절대 변경하지 않습니다**\n- **파일 전체 관점의 일관성**: 동일 기능군·카테고리 내에서 용어·톤·어미를 통일합니다\n- **그룹 기반 전략 수립**: 세그먼트 하나하나를 독립적으로 보지 않고, 성격이 비슷한 것들을 묶어 공통 전략을 먼저 정합니다\n- **검수 내재화**: 번역 직후 자체 QA를 수행하여 최종 결과물의 품질을 보장합니다\n\n---\n\n## WORKFLOW: 4단계 대화형 번역 플로우\n\n이 작업은 4번의 사용자 상호작용을 거치며 진행됩니다. 각 단계마다 **정해진 출력 JSON 스키마**를 따라야 하며, 사용자가 다음 단계 지시를 내릴 때까지 그 다음 Phase를 수행하지 않습니다.\n\n```\nPhase 1+2 (분석) → [사용자 확인 / 조정] → Phase 3 (번역) → [사용자 확인] → Phase 4+5 (검수) → [사용자 확정] → 적용\n```\n\n각 단계의 입력/출력은 모두 구조화된 JSON이며, 프로젝트 워크플로우 스크립트가 이를 파싱하여 UI에 표시합니다.\n\n---\n\n## 📥 공통 입력 포맷 (스크립트가 주입)\n\n각 Phase 호출 시 다음과 같은 구조로 정보가 주입됩니다:\n\n```\n# 파일 정보\n- 프로젝트: [프로젝트명]\n- 파일명: [파일명]\n- 총 세그먼트 수: N개\n- 처리 대상 범위: [전체 / 선택 / 범위]\n\n# 번역 대상 세그먼트 목록\n## #1 (id: 5720535)\n- 원문: \"...\"\n- 글자수 제한: [숫자 or 없음]\n- Context: [게임 내부 key]\n- TB 용어: [중문→한글 매핑 목록]\n- 备注:\n  - [col1] batch346\n  - [col2] 牟昳丞\n  - [col3] MAIL\n  - [col4] 活动/部族对决\n  - [col5] LC_MAIL_ShowDownStageReward_Reissue_Text\n  - [col9] {0}活动名字\n\n## #2 (id: 5720538)\n...\n```\n\n### 备注(col) 데이터 해석 지침\n\n备注는 엑셀 원본의 부가 컬럼 데이터입니다. `col` 번호는 프로젝트마다 의미가 다르므로, **Phase 1에서 패턴을 보고 각 col의 의미를 추론**해야 합니다. 일반적인 경향:\n\n- **배치명/파일명 형태**: `batch346`, `VR_347` → 작업 단위 식별자 (번역 무관)\n- **한자 이름**: `牟昳丞`, `王小明` → 담당자명 (번역 무관)\n- **영문 대문자 약어**: `MAIL`, `SHOP`, `UI` → 게임 내 모듈명 (번역 맥락 파악에 중요)\n- **한자 + 구조**: `活动/部族对决`, `UI/战斗界面` → 기능 카테고리 (번역 톤 결정에 중요)\n- **영문 언더스코어 연속**: `LC_MAIL_ShowDownStageReward_Reissue_Text` → Excel Key (번역 무관)\n- **자유 문장**: `玩家点击购买按钮时显示`, `{0}活动名字` → 번역 힌트/플레이스홀더 설명 (번역에 직접 활용)\n\n**중요**: 각 col의 의미는 Phase 1에서 `note_schema`로 출력하여 이후 단계에서 일관되게 활용합니다.\n\n---\n\n## 🎨 Phase 1+2: 파일 전체 분석 (Macro + Group Analysis)\n\n첫 번째 호출에서 수행합니다. **번역은 아직 하지 않습니다.**\n\n### Phase 1: 거시 분석\n\n1. **입력 유형 판단**: 시트/XML/문서\n2. **전체 맥락 파악**: 게임명, 주요 기능, 작업 성격\n3. **备注 col 스키마 추론**: 각 col이 어떤 의미인지 패턴 분석\n4. **활성 카테고리 식별**: 아래 22개 중 관련 카테고리 모두 식별\n\n### Phase 1 카테고리 목록 (사용자 설정 세부 프롬프트와 매칭)\n\n```\n0. 📌 공통 번역 가이드라인 (항상 기본 활성화)\n1. 🖥️ 인터페이스(UI)\n2. 📢 시스템 메시지\n3. 💡 툴팁 및 힌트\n4. 📖 튜토리얼 및 가이드\n5. 💬 메인 시나리오 대사\n6. 🗨️ 서브 이벤트 대사\n7. 🎙️ 성우 녹음 대본\n8. 📺 컷신 및 영상 자막\n9. ⚔️ 아이템 정보\n10. ✨ 스킬 및 능력 설명\n11. 📜 퀘스트 목표 및 진행 안내\n12. 🌍 배경 설정 및 세계관 정보\n13. 📣 게임 공지 및 이벤트 안내\n14. 📈 마케팅 및 프로모션 콘텐츠\n15. 🛒 스토어 및 상점 콘텐츠\n16. 🏆 업적 및 칭호\n17. 📌 커뮤니티 및 소셜 메시지\n18. 🛠️ 패치 및 업데이트 내역\n19. 🔐 법적 고지 및 정책 문서\n20. 🧩 기타 번역 항목 및 사용자 지정 카테고리\n21. ⭐ 문체 참고 가이드\n```\n\n### Phase 2: 그룹 기반 분류\n\n**세그먼트마다 개별 메타데이터를 만들지 않습니다.** 대신 유사한 세그먼트를 묶어서 **그룹**을 형성하고, 각 그룹의 공통 전략을 정의합니다.\n\n**그룹 형성 기준** (복수 적용 가능):\n- 备注의 `col3` (모듈), `col4` (카테고리) 동일\n- 원문 길이/구조 유사 (버튼 라벨 vs 긴 서술 vs 짧은 안내)\n- 플레이스홀더/태그 패턴 유사\n- 톤·화자 관점 유사 (1인칭/2인칭/시스템 안내)\n- 번역 카테고리 동일 (UI/시나리오/공지 등)\n\n**그룹 수**: 파일 규모에 따라 3~15개가 적정. 너무 많으면 의미가 없고, 너무 적으면 구분이 부정확해집니다.\n\n---\n\n## 📤 Phase 1+2 출력 스키마 (JSON)\n\n```json\n{\n  \"phase\": \"1+2\",\n  \"phase1\": {\n    \"file_overview\": {\n      \"input_type\": \"시트/문서/XML\",\n      \"game_context\": \"[게임명 + 이 배치의 성격 요약 1~2문장]\",\n      \"primary_language_register\": \"[주요 문체: 격식체/반말/친근체 등]\",\n      \"total_segments\": 177,\n      \"active_categories\": [\n        {\n          \"id\": 13,\n          \"name\": \"📣 게임 공지 및 이벤트 안내\",\n          \"weight_percent\": 60,\n          \"reason\": \"[왜 활성화했는지 1줄]\"\n        },\n        {\n          \"id\": 2,\n          \"name\": \"📢 시스템 메시지\",\n          \"weight_percent\": 40,\n          \"reason\": \"...\"\n        }\n      ],\n      \"note_schema\": {\n        \"col1\": \"배치명 (예: batch346) — 번역 무관, 참고용\",\n        \"col2\": \"담당자명 — 번역 무관\",\n        \"col3\": \"게임 내 모듈명 (MAIL/SHOP/PVP 등) — 그룹 분류 기준\",\n        \"col4\": \"기능 카테고리 — 그룹 분류 기준\",\n        \"col5\": \"Excel Key — 번역 무관, 기술 식별자\",\n        \"col9\": \"번역 힌트/플레이스홀더 설명 — 번역에 직접 활용\"\n      }\n    }\n  },\n  \"phase2\": {\n    \"groups\": [\n      {\n        \"group_id\": \"G1\",\n        \"group_name\": \"[간결한 그룹 이름]\",\n        \"segment_ids\": [5720535, 5720538, 5720541],\n        \"segment_count\": 3,\n        \"shared_characteristics\": \"[이 그룹의 공통점 설명]\",\n        \"tone\": \"[적용할 톤]\",\n        \"target_category_ids\": [13, 2],\n        \"translation_guidance\": [\n          \"[이 그룹 번역 시 구체적 지시 사항 1]\",\n          \"[지시 사항 2]\",\n          \"[지시 사항 3]\"\n        ]\n      }\n    ],\n    \"cross_group_consistency\": [\n      \"[파일 전체에 걸쳐 통일해야 할 용어/표현 1]\",\n      \"[통일 사항 2]\"\n    ]\n  },\n  \"next_step_proposal\": \"위 분석으로 Phase 3 (번역)을 진행할 준비가 되었습니다. 사용자 확인을 기다립니다.\"\n}\n```\n\n**중요 규칙**:\n- 모든 세그먼트가 **정확히 하나의 그룹**에 속해야 합니다 (누락·중복 금지)\n- `segment_ids` 배열의 합집합이 입력 세그먼트 전체와 일치해야 합니다\n- JSON 외에 다른 형식(마크다운, 설명)은 포함하지 않습니다\n- 코드 블록(```json)으로 감싸는 것은 허용합니다\n\n---\n\n## 🎨 Phase 3: 그룹별 번역 실행\n\n**Phase 1+2 결과가 다시 입력으로 주입**된 상태에서 호출됩니다. 모든 세그먼트에 대해 **Phase 1+2에서 정한 그룹 전략대로** 번역합니다.\n\n### 번역 원칙\n\n1. **계층적 가이드라인 적용**\n   - Level 1: 공통 번역 가이드라인 (0번, 항상 활성)\n   - Level 2: 활성 카테고리별 세부 가이드 (스크립트가 주입)\n   - Level 3: 세그먼트가 속한 그룹의 `translation_guidance`\n   - Level 4: 세그먼트 고유 제약 (글자수, TB 용어, 备注 힌트)\n\n2. **일관성 최우선**\n   - `cross_group_consistency`에 명시된 용어는 **전 세그먼트에서 동일 번역** 사용\n   - 같은 그룹 내에서는 어미·호칭·문체 통일\n   - TB 용어집 준수 (대상 언어 번역이 지정된 경우 반드시 사용)\n\n3. **보존 대상 (절대 변경 금지)**\n   - 숫자, 영문 고유명사\n   - 플레이스홀더: `{0}`, `{1}`, `%s`, `%d`, `%@` 등\n   - 게임 태그: `<color=Color31>...</color>`, `<b>...</b>`, `<size=...>`, `{name}` 등\n   - 줄바꿈 문자 `\\n`\n   - 备注의 `col5` Excel Key 형태는 절대 번역문에 포함하지 않음\n\n4. **备注 힌트 활용**\n   - `col9` 등 자유 문장 힌트는 번역 결정에 반영\n   - 예: `{0}活动名字` → `{0}`에는 이벤트 이름이 들어간다는 뜻. 한국어에서 조사 선택 시 고려\n\n---\n\n## 📤 Phase 3 출력 스키마 (JSON)\n\n```json\n{\n  \"phase\": \"3\",\n  \"translations\": [\n    {\n      \"id\": 5720535,\n      \"group_id\": \"G1\",\n      \"translation\": \"[번역문]\",\n      \"notes\": null\n    },\n    {\n      \"id\": 5720538,\n      \"group_id\": \"G1\",\n      \"translation\": \"[번역문]\",\n      \"notes\": \"글자수 제한 24자에 딱 맞춤\"\n    }\n  ],\n  \"summary\": {\n    \"total_translated\": 177,\n    \"warnings\": [\n      \"[있으면] 특정 세그먼트 원문이 애매해 보수적으로 번역함: #5720550\",\n      \"[있으면] 글자수 제한 근접: #5720538 (24/24)\"\n    ]\n  },\n  \"next_step_proposal\": \"Phase 3 번역 완료. Phase 4+5 검수를 수행할 준비가 되었습니다.\"\n}\n```\n\n**중요 규칙**:\n- 입력 세그먼트 수 = `translations` 배열 길이 (누락 금지)\n- `id`는 입력의 세그먼트 id와 정확히 일치\n- `group_id`는 Phase 2의 그룹 id와 일치\n- `translation`은 한국어 번역문만 (설명·마크다운·한자병기 금지)\n- `notes`는 번역 결정에 특이사항이 있을 때만 (대부분 null)\n\n---\n\n## 🔍 Phase 4+5: 자체 검수 및 최종안 작성\n\nPhase 3 결과를 받아 **자체 QA를 수행하고 수정이 필요한 항목은 최종안을 제시**합니다.\n\n### Phase 4 검수 체크리스트\n\n1. **데이터 무결성**\n   - 플레이스홀더 보존 여부 (`{0}`, `%s` 등)\n   - 태그 보존 여부 (`<color=...>` 등)\n   - 숫자·고유명사 일치\n\n2. **가이드라인 준수**\n   - 활성 카테고리별 세부 가이드 준수\n   - 그룹 `translation_guidance` 준수\n   - TB 용어집 준수\n\n3. **글자수 제한**\n   - `char_limit` 지정된 세그먼트 모두 검증\n\n4. **일관성**\n   - `cross_group_consistency` 항목이 전 세그먼트에 통일 적용됐는지\n   - 동일 그룹 내 어미·호칭 통일성\n   - 반복되는 패턴 (예: 인사말) 동일 번역 적용\n\n5. **언어적 완성도**\n   - 번역투·어색한 표현\n   - 한국어 어순·조사 자연스러움\n   - 맥락상 부적절한 표현\n\n### Phase 5 최종안 결정\n\n검수 결과에 따라 각 세그먼트에 대해:\n- **문제 없음** → Phase 3 번역 그대로 최종안으로 사용 (`phase4: null`)\n- **수정 필요** → 수정된 최종안과 사유 제시\n\n---\n\n## 📤 Phase 4+5 출력 스키마 (JSON)\n\n```json\n{\n  \"phase\": \"4+5\",\n  \"revisions\": [\n    {\n      \"id\": 5720535,\n      \"group_id\": \"G1\",\n      \"phase3\": \"[Phase 3 번역문]\",\n      \"phase4\": \"[검수 후 수정안 or null]\",\n      \"changed\": false,\n      \"reasons\": []\n    },\n    {\n      \"id\": 5720538,\n      \"group_id\": \"G1\",\n      \"phase3\": \"[Phase 3 번역문]\",\n      \"phase4\": \"[검수 수정안]\",\n      \"changed\": true,\n      \"reasons\": [\n        \"TB 용어집: '奖励' → '보상'으로 통일 (그룹 다른 세그먼트와 일치)\",\n        \"글자수 제한 24자 초과 → 축약\"\n      ]\n    }\n  ],\n  \"summary\": {\n    \"total_reviewed\": 177,\n    \"changed_count\": 12,\n    \"issues_by_category\": {\n      \"placeholder_missing\": 0,\n      \"tag_missing\": 1,\n      \"term_inconsistency\": 5,\n      \"char_limit_exceeded\": 3,\n      \"grammar_polish\": 3\n    },\n    \"overall_quality_note\": \"[전체 품질 한 줄 평가]\"\n  },\n  \"next_step_proposal\": \"Phase 4+5 검수 완료. 사용자 확정 후 세그먼트에 적용 가능합니다.\"\n}\n```\n\n**중요 규칙**:\n- 입력 세그먼트 수 = `revisions` 배열 길이 (누락 금지)\n- `changed: false` 세그먼트는 `phase4: null`, `reasons: []`\n- `changed: true` 세그먼트는 `phase4`에 수정안, `reasons`에 이유 최소 1개\n- `summary.changed_count` = `changed: true`인 항목 수\n\n---\n\n## ⚠️ 공통 출력 규칙 (모든 Phase 적용)\n\n1. **JSON 순수 출력**: 설명·주석·대화형 문장 금지. 오직 스키마에 맞는 JSON\n2. **코드 블록 래핑 가능**: ` ```json ... ``` ` 는 허용 (파싱기가 벗겨냄)\n3. **마크다운 금지**: 번역문 자체에 `**`, `*`, `#`, 한자병기 `(漢字)` 등 포함 금지\n4. **JSON 유효성**: 쌍따옴표, 콤마, 괄호 정확히. 번역문 내 `\"` 는 `\\\"` 로 이스케이프\n5. **누락 금지**: 입력된 세그먼트 id 배열이 응답에 **정확히** 모두 포함되어야 함 (순서는 달라도 됨)\n6. **ID 일치**: 응답의 `id`는 반드시 입력의 세그먼트 id와 일치 (새 id 생성 금지)\n\n---\n\n## 🎯 단계별 현재 상태 인식\n\n스크립트는 매 호출 시 `[CURRENT_PHASE: 1+2 / 3 / 4+5]` 태그를 프롬프트에 포함합니다. 이 태그에 따라 해당 Phase의 출력만 생성하고, 다른 Phase 작업은 하지 않습니다.\n\n예:\n- `[CURRENT_PHASE: 1+2]` → Phase 1+2 분석 JSON만 출력, Phase 3 번역 하지 않음\n- `[CURRENT_PHASE: 3]` → Phase 3 번역 JSON만 출력, 분석 재생성하지 않음\n- `[CURRENT_PHASE: 4+5]` → Phase 4+5 검수 JSON만 출력\n\n---\n\n## 📚 REFERENCE KNOWLEDGE BASE\n\n모든 판단과 번역은 다음을 절대 기준으로 합니다:\n\n1. **공통 번역 가이드라인** (0번 카테고리, 시스템 프롬프트와 함께 항상 활성화)\n2. **활성 카테고리별 전용 가이드라인** (Phase 1에서 식별, 스크립트가 해당 세부 프롬프트를 Phase 3+에 재주입)\n3. **Phase 1+2 분석 결과** (해당 파일/배치의 전략 — Phase 3+에 재주입됨)\n4. **TB 용어집** (`match_terms`, 세그먼트별로 주입됨)\n5. **备注 힌트** (`col` 기반 주석, 세그먼트별로 주입됨)\n\n---\n\n당신은 이제 프로젝트 단위 중한 게임 현지화 전문가로서, 배치 파일 전체의 맥락을 파악하고 일관성 있게 처리할 준비가 되었습니다. 사용자가 `[CURRENT_PHASE]` 태그와 함께 요청하면 해당 단계의 JSON 응답만 생성하세요.\n";

  // ---- 이하 테스트 로직 ----
  const PAGE_SIZE = 50;
  const CHUNK_SIZE = 10;
  const MODEL = 'claude-sonnet-4-6';
  const RUN_MODE = 'phase12-3-45-compact'; // 'inspect-existing', 'phase12-only', 'phase12-compact', 'phase12-3-compact', 'phase12-3-45-compact', 'phase12-chunks', 또는 'full'
  const POLL_INTERVAL_MS = 5000;
  const RESULT_RETRY_INTERVAL_MS = 2000;
  const RESULT_RETRY_ATTEMPTS = 30;
  const MAX_POLL_ATTEMPTS = 90;
  const csrf = document.cookie.match(/csrftoken=([^;]+)/)[1];
  const p = new URLSearchParams(location.hash.split('?')[1]);
  const projectId = p.get('projectId');
  const fileId = p.get('fileId');
  const languageId = parseInt(p.get('languageId'), 10);
  let storageStringId = requestedTestStringId;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const segmentIdsEqual = (expectedIds, actualIds) => {
    const expectedSet = new Set(expectedIds);
    const actualSet = new Set(actualIds);
    return expectedIds.length === actualIds.length &&
      expectedIds.every(id => actualSet.has(id)) &&
      actualIds.every(id => expectedSet.has(id));
  };

  function analyzeIdCoverage(expectedIds, actualIds) {
    const expectedSet = new Set(expectedIds);
    const actualSet = new Set(actualIds);
    const seen = new Set();
    const duplicates = [];

    for (const id of actualIds) {
      if (seen.has(id) && !duplicates.includes(id)) duplicates.push(id);
      seen.add(id);
    }

    return {
      ok: expectedIds.length === actualIds.length &&
          expectedIds.every(id => actualSet.has(id)) &&
          actualIds.every(id => expectedSet.has(id)) &&
          duplicates.length === 0,
      missing: expectedIds.filter(id => !actualSet.has(id)),
      extra: actualIds.filter(id => !expectedSet.has(id)),
      duplicates,
      expectedCount: expectedIds.length,
      actualCount: actualIds.length,
    };
  }

  function extractPlaceholders(text) {
    return Array.from(new Set(String(text || '').match(/\{[^{}]+\}|%[@sd]|\{\w+\}/g) || []));
  }

  function validatePhase3Compact(phase12Compact, phase3Compact, segmentSource) {
    console.log('\n%c=== 연속성 검증: Phase 3 compact ===', 'background:#06b6d4;color:#000;padding:2px;font-weight:bold');

    const expectedIds = segmentSource.map(seg => seg.id);
    const expectedGroupById = new Map();
    for (const group of (phase12Compact.groups || [])) {
      for (const id of (group.ids || [])) {
        expectedGroupById.set(id, group.gid);
      }
    }

    const translations = phase3Compact.translations || [];
    const actualIds = translations.map(item => item.id);
    const coverage = analyzeIdCoverage(expectedIds, actualIds);
    const wrongGroups = translations
      .filter(item => expectedGroupById.get(item.id) !== item.gid)
      .map(item => ({
        id: item.id,
        expected: expectedGroupById.get(item.id),
        actual: item.gid
      }));

    const sourceById = new Map(segmentSource.map(seg => [seg.id, seg]));
    const emptyTranslations = translations
      .filter(item => !String(item.t || '').trim())
      .map(item => item.id);

    const missingPlaceholders = [];
    for (const item of translations) {
      const src = sourceById.get(item.id)?.origin_string || '';
      const placeholders = extractPlaceholders(src);
      const missing = placeholders.filter(token => !String(item.t || '').includes(token));
      if (missing.length) {
        missingPlaceholders.push({ id: item.id, missing });
      }
    }

    const hanjaLike = translations
      .filter(item => /[\u4e00-\u9fff]/.test(String(item.t || '')))
      .map(item => item.id);

    console.log('id coverage:', coverage.ok ? 'OK' : coverage);
    console.log('gid 일치 여부:', wrongGroups.length === 0 ? 'OK' : wrongGroups);
    console.log('빈 번역:', emptyTranslations.length === 0 ? 'OK' : emptyTranslations);
    console.log('placeholder 보존:', missingPlaceholders.length === 0 ? 'OK' : missingPlaceholders);
    console.log('한자 잔존:', hanjaLike.length === 0 ? 'OK' : hanjaLike);

    return {
      ok: coverage.ok &&
          wrongGroups.length === 0 &&
          emptyTranslations.length === 0 &&
          missingPlaceholders.length === 0 &&
          hanjaLike.length === 0,
      coverage,
      wrongGroups,
      emptyTranslations,
      missingPlaceholders,
      hanjaLike,
    };
  }

  function validatePhase45Compact(phase3Compact, phase45Compact, segmentSource) {
    console.log('\n%c=== 연속성 검증: Phase 4+5 compact ===', 'background:#06b6d4;color:#000;padding:2px;font-weight:bold');

    const translations = phase3Compact.translations || [];
    const expectedIds = translations.map(item => item.id);
    const phase3ById = new Map(translations.map(item => [item.id, item]));
    const revisions = phase45Compact.revisions || [];
    const actualIds = revisions.map(item => item.id);
    const coverage = analyzeIdCoverage(expectedIds, actualIds);

    const wrongGroups = revisions
      .filter(item => phase3ById.get(item.id)?.gid !== item.gid)
      .map(item => ({
        id: item.id,
        expected: phase3ById.get(item.id)?.gid,
        actual: item.gid
      }));

    const missingTField = revisions
      .filter(item => !Object.prototype.hasOwnProperty.call(item, 't'))
      .map(item => item.id);

    const invalidReasons = revisions
      .filter(item => !Array.isArray(item.r))
      .map(item => item.id);

    const finalTextById = new Map();
    const emptyFinals = [];
    for (const item of revisions) {
      const phase3Text = phase3ById.get(item.id)?.t || '';
      const finalText = item.t === null ? phase3Text : String(item.t || '');
      finalTextById.set(item.id, finalText);
      if (!finalText.trim()) emptyFinals.push(item.id);
    }

    const sourceById = new Map(segmentSource.map(seg => [seg.id, seg]));
    const missingPlaceholders = [];
    for (const item of revisions) {
      const src = sourceById.get(item.id)?.origin_string || '';
      const placeholders = extractPlaceholders(src);
      const finalText = finalTextById.get(item.id) || '';
      const missing = placeholders.filter(token => !finalText.includes(token));
      if (missing.length) {
        missingPlaceholders.push({ id: item.id, missing });
      }
    }

    const hanjaLike = revisions
      .filter(item => /[\u4e00-\u9fff]/.test(finalTextById.get(item.id) || ''))
      .map(item => item.id);

    const changedCount = revisions.filter(item => item.t !== null).length;

    console.log('id coverage:', coverage.ok ? 'OK' : coverage);
    console.log('gid 일치 여부:', wrongGroups.length === 0 ? 'OK' : wrongGroups);
    console.log('t 필드:', missingTField.length === 0 ? 'OK' : missingTField);
    console.log('reason 배열:', invalidReasons.length === 0 ? 'OK' : invalidReasons);
    console.log('빈 최종 번역:', emptyFinals.length === 0 ? 'OK' : emptyFinals);
    console.log('placeholder 보존:', missingPlaceholders.length === 0 ? 'OK' : missingPlaceholders);
    console.log('한자 잔존:', hanjaLike.length === 0 ? 'OK' : hanjaLike);
    console.log('수정 수:', changedCount);

    return {
      ok: coverage.ok &&
          wrongGroups.length === 0 &&
          missingTField.length === 0 &&
          invalidReasons.length === 0 &&
          emptyFinals.length === 0 &&
          missingPlaceholders.length === 0 &&
          hanjaLike.length === 0,
      coverage,
      wrongGroups,
      missingTField,
      invalidReasons,
      emptyFinals,
      missingPlaceholders,
      hanjaLike,
      changedCount,
    };
  }

  function stripCodeFence(text) {
    return String(text || '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
  }

  function parseWorkflowJson(rawText, expectedPhase) {
    const cleaned = stripCodeFence(rawText);
    const parsed = JSON.parse(cleaned);
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
    const cleaned = stripCodeFence(rawText);
    try {
      const parsed = parseWorkflowJson(cleaned, expectedPhase);
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

  function rememberInspection(rawText, inspection) {
    window._v31raw = rawText;
    window._v31inspection = inspection;
    try {
      localStorage.setItem('tms_v31_last_raw', rawText || '');
      localStorage.setItem('tms_v31_last_inspection', JSON.stringify({
        ok: !!inspection?.ok,
        error: inspection?.error?.message || null,
        context: inspection?.context || null,
        length: inspection?.cleaned?.length || 0,
      }));
    } catch (error) {
      console.warn('localStorage 기록 실패:', error);
    }
  }

  function classifySavedResult(rawText) {
    const text = String(rawText || '');
    if (/Read timeout/i.test(text) && /bedrock-runtime/i.test(text)) {
      return {
        type: 'BEDROCK_READ_TIMEOUT',
        message: 'Bedrock 모델 호출이 TMS 백엔드의 대기 시간 안에 끝나지 않았습니다.'
      };
    }
    if (/endpoint URL/i.test(text) && /invoke/i.test(text)) {
      return {
        type: 'MODEL_ENDPOINT_ERROR',
        message: '모델 엔드포인트 호출 오류 문자열이 결과 칸에 저장되었습니다.'
      };
    }
    return null;
  }

  function buildPhasePrompt(phaseTag, segmentList, extraBlocks, finalInstruction) {
    return [
      V31_PROMPT,
      '---',
      '# 파일 정보',
      `- 프로젝트 ID: ${projectId}`,
      `- 파일 ID: ${fileId}`,
      `- 처리 대상: 테스트용 ${segments.length}개 세그먼트`,
      '',
      '# 번역 대상 세그먼트 목록',
      segmentList,
      '',
      ...(extraBlocks.length ? [...extraBlocks, ''] : []),
      '---',
      '',
      `[CURRENT_PHASE: ${phaseTag}]`,
      '',
      finalInstruction
    ].join('\n');
  }

  async function fetchSavedResultSnapshot() {
    const response = await fetch(
      `/api/translate/strings/?id=${storageStringId}&project=${projectId}&target_language=${languageId}&file=${fileId}`,
      { credentials: 'same-origin' }
    ).then(r => r.json());

    return {
      raw: response.data?.[0]?.active_result?.result || '',
      response
    };
  }

  async function waitForExpectedResult(expectedPhase, previousRaw) {
    let lastRaw = '';
    let lastParsed = null;
    let lastInspection = null;

    for (let attempt = 1; attempt <= RESULT_RETRY_ATTEMPTS; attempt++) {
      const { raw } = await fetchSavedResultSnapshot();
      lastRaw = raw;
      let parsed = null;
      try {
        parsed = parseWorkflowJson(raw);
        lastParsed = parsed;
        lastInspection = { ok: true, parsed };
      } catch (error) {
        parsed = null;
        lastInspection = inspectSavedJson(raw);
      }

      const changed = raw !== previousRaw;
      const savedIssue = parsed ? null : classifySavedResult(raw);
      console.log(`  [결과 조회 ${attempt}차] changed=${changed} / phase=${parsed?.phase || '미확인'} / length=${raw.length} / issue=${savedIssue?.type || '-'} / parse=${lastInspection?.ok ? 'OK' : lastInspection?.error?.message || '-'}`);

      if (savedIssue) {
        rememberInspection(raw, inspectSavedJson(raw, expectedPhase));
        const preview = stripCodeFence(raw).slice(0, 220);
        throw new Error(`${expectedPhase} 저장 결과가 ${savedIssue.type}입니다. ${savedIssue.message} 미리보기: ${preview}`);
      }

      if (parsed?.phase === expectedPhase && changed) {
        return { raw, parsed };
      }

      await sleep(RESULT_RETRY_INTERVAL_MS);
    }

    if (lastParsed?.phase === expectedPhase) {
      return { raw: lastRaw, parsed: lastParsed };
    }

    if (lastRaw === previousRaw) {
      throw new Error(`${expectedPhase} 결과가 저장본에 반영되지 않았습니다. storageStringId의 기존 번역이 그대로 유지된 상태예요. scratch 세그먼트를 비우고 다시 시도해보는 게 안전합니다.`);
    }

    const preview = stripCodeFence(lastRaw).slice(0, 160);
    if (lastInspection && !lastInspection.ok) {
      rememberInspection(lastRaw, lastInspection);
      console.log('마지막 저장본 앞부분:', lastInspection.cleaned.slice(0, 500));
      console.log('마지막 저장본 끝부분:', lastInspection.cleaned.slice(-500));
      if (lastInspection.context.position != null) {
        console.log(`JSON 오류 위치: ${lastInspection.context.position}`);
        console.log('오류 직전:', lastInspection.context.before);
        console.log('오류 직후:', lastInspection.context.after);
      }
      throw new Error(`${expectedPhase} 결과가 JSON처럼 저장됐지만 파싱에 실패했습니다: ${lastInspection.error.message}`);
    }
    throw new Error(`${expectedPhase} 결과가 저장본에서 확인되지 않았습니다. 마지막 저장본 미리보기: ${preview}`);
  }

  async function runWorkflowPhase({ phaseTag, prompt, previousRaw }) {
    console.log(`\n%c=== Phase ${phaseTag} 실행 ===`, 'background:#a78bfa;color:#000;padding:3px;font-weight:bold');
    console.log(`📏 프롬프트 길이: ${prompt.length}자`);
    console.log('(처음 500자 미리보기)');
    console.log(prompt.slice(0, 500));
    console.log('...');
    console.log('(마지막 500자 미리보기)');
    console.log(prompt.slice(-500));

    console.log('\n📤 prefix_prompt_tran/ 호출...');
    const apiRes = await fetch(
      `/api/translate/projects/${projectId}/prefix_prompt_tran/`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': csrf,
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({
          language_id_list: [languageId],
          string_id_list: [storageStringId],
          prefix_prompt: prompt,
          is_associated: true,
          model: MODEL,
        })
      }
    );
    const apiData = await apiRes.json();
    console.log('응답:', apiData);

    const taskId = apiData.data?.task_id;
    if (!taskId) {
      throw new Error('task_id 없음');
    }

    console.log('\n⏳ 폴링 중...');
    let finalStatus = null;
    const startedAt = Date.now();
    for (let i = 1; i <= MAX_POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS);
      const taskData = await fetch(`/api/translate/task_results/${taskId}/`, { credentials: 'same-origin' }).then(r => r.json());
      finalStatus = taskData.data?.status;
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[${i}차 / ${elapsedSec}초] ${taskData.data.status} | ${taskData.data.result}`);
      if (finalStatus === 'SUCCESS' || finalStatus === 'FAILURE') break;
    }

    if (finalStatus !== 'SUCCESS') {
      throw new Error(`task 상태가 SUCCESS가 아닙니다: ${finalStatus} (taskId=${taskId}, waited=${Math.round((Date.now() - startedAt) / 1000)}초)`);
    }

    console.log('\n📥 LLM 응답 조회');
    const { raw, parsed } = await waitForExpectedResult(phaseTag, previousRaw);
    console.log('\n%c=== LLM 응답 (storageStringId에 저장됨) ===', 'background:#22c55e;color:#000;padding:2px;font-weight:bold');
    console.log(raw);

    console.log('\n%c=== JSON 파싱 결과 ===', 'background:#3b82f6;color:#fff;padding:2px;font-weight:bold');
    console.log('%c✅ 파싱 성공!', 'background:#22c55e;color:#000;padding:4px;font-weight:bold');
    console.log('phase:', parsed.phase);
    console.log('전체 객체:', parsed);
    return { raw, parsed };
  }

  function validatePhase3(phase12, phase3, expectedIds) {
    console.log('\n%c=== 연속성 검증: Phase 3 ===', 'background:#06b6d4;color:#000;padding:2px;font-weight:bold');
    const groups = phase12.phase2?.groups || [];
    const expectedGroupById = new Map();
    for (const group of groups) {
      for (const id of (group.segment_ids || [])) {
        expectedGroupById.set(id, group.group_id);
      }
    }

    const translations = phase3.translations || [];
    const actualIds = translations.map(item => item.id);
    const idCoverageOk = segmentIdsEqual(expectedIds, actualIds);
    const wrongGroups = translations
      .filter(item => expectedGroupById.get(item.id) !== item.group_id)
      .map(item => ({
        id: item.id,
        expected: expectedGroupById.get(item.id),
        actual: item.group_id
      }));

    console.log('id coverage:', idCoverageOk ? 'OK' : '불일치');
    console.log('group_id 일치 여부:', wrongGroups.length === 0 ? 'OK' : wrongGroups);
    console.log('warnings:', phase3.summary?.warnings || []);

    return {
      ok: idCoverageOk && wrongGroups.length === 0,
      wrongGroups
    };
  }

  function validatePhase45(phase12, phase3, phase45, expectedIds) {
    console.log('\n%c=== 연속성 검증: Phase 4+5 ===', 'background:#06b6d4;color:#000;padding:2px;font-weight:bold');
    const expectedGroupById = new Map();
    for (const group of (phase12.phase2?.groups || [])) {
      for (const id of (group.segment_ids || [])) {
        expectedGroupById.set(id, group.group_id);
      }
    }

    const phase3ById = new Map((phase3.translations || []).map(item => [item.id, item]));
    const revisions = phase45.revisions || [];
    const actualIds = revisions.map(item => item.id);
    const idCoverageOk = segmentIdsEqual(expectedIds, actualIds);

    const wrongGroups = revisions
      .filter(item => expectedGroupById.get(item.id) !== item.group_id)
      .map(item => ({
        id: item.id,
        expected: expectedGroupById.get(item.id),
        actual: item.group_id
      }));

    const mismatchedPhase3 = revisions
      .filter(item => phase3ById.get(item.id)?.translation !== item.phase3)
      .map(item => ({
        id: item.id,
        expected: phase3ById.get(item.id)?.translation,
        actual: item.phase3
      }));

    const changedCount = revisions.filter(item => item.changed).length;
    const changedCountMatches = changedCount === phase45.summary?.changed_count;

    console.log('id coverage:', idCoverageOk ? 'OK' : '불일치');
    console.log('group_id 일치 여부:', wrongGroups.length === 0 ? 'OK' : wrongGroups);
    console.log('phase3 재사용 여부:', mismatchedPhase3.length === 0 ? 'OK' : mismatchedPhase3);
    console.log('changed_count 일치 여부:', changedCountMatches ? 'OK' : {
      expected: changedCount,
      actual: phase45.summary?.changed_count
    });

    return {
      ok: idCoverageOk &&
          wrongGroups.length === 0 &&
          mismatchedPhase3.length === 0 &&
          changedCountMatches,
      wrongGroups,
      mismatchedPhase3
    };
  }

  console.log('%c🧪 v3.1 연속성 테스트 시작', 'background:#fbbf24;color:#000;padding:4px');
  console.log('requestedTestStringId:', requestedTestStringId);
  console.log('projectId:', projectId, 'fileId:', fileId, 'languageId:', languageId);

  // 1. 현재 파일 첫 페이지 세그먼트 수집
  console.log('\n📋 세그먼트 목록 수집...');
  const listRes = await fetch(
    `/api/translate/strings/?project=${projectId}&target_language=${languageId}&file=${fileId}&page=1&page_size=${PAGE_SIZE}`,
    { credentials: 'same-origin' }
  );
  const listData = await listRes.json();
  const { segments, meta } = normalizeSegmentListResponse(listData);
  console.log(`  응답 형태: ${meta.shape}`);
  console.log(`  수집: ${segments.length}개`);
  if (meta.page != null || meta.totalPage != null || meta.count != null) {
    console.log(`  메타: page=${meta.page ?? '-'} / totalPage=${meta.totalPage ?? '-'} / count=${meta.count ?? '-'}`);
  }
  if ((meta.count || 0) > segments.length) {
    console.warn(`⚠️ 현재는 첫 페이지 ${segments.length}개만 수집됨 (전체 ${meta.count}개). 이 테스트는 아직 전체 파일 수집이 아닙니다.`);
  }

  if (segments.length === 0) {
    console.error('❌ 세그먼트가 없습니다. 파일을 열고 다시 시도하세요.');
    console.log('listData 원본:', listData);
    return;
  }

  const expectedIds = segments.map(seg => seg.id);
  storageStringId = expectedIds.includes(requestedTestStringId)
    ? requestedTestStringId
    : expectedIds[0];
  if (requestedTestStringId !== storageStringId) {
    console.warn(`⚠️ requestedTestStringId(${requestedTestStringId})가 현재 파일에 없어 storageStringId(${storageStringId})로 자동 전환합니다.`);
  }
  console.log('storageStringId:', storageStringId);
  const initialStorageSnapshot = await fetchSavedResultSnapshot();
  const initialStorageRaw = initialStorageSnapshot.raw;
  console.log(`storageStringId 기존 결과 길이: ${initialStorageRaw.length}`);
  if (initialStorageRaw) {
    console.warn('⚠️ storageStringId에 기존 번역/결과가 이미 있습니다. 새 JSON이 덮어써지지 않으면 판별이 꼬일 수 있어요.');
    console.log('storageStringId 기존 결과 미리보기:', stripCodeFence(initialStorageRaw).slice(0, 160));
  }

  if (RUN_MODE === 'inspect-existing') {
    console.log('\n%c=== 기존 저장 결과 검사 ===', 'background:#f59e0b;color:#000;padding:3px;font-weight:bold');
    const fallbackRaw = localStorage.getItem('tms_v31_last_raw') || '';
    const rawForInspection = initialStorageRaw || fallbackRaw;
    if (!initialStorageRaw && fallbackRaw) {
      console.warn('⚠️ active_result가 비어 있어 localStorage의 마지막 결과를 검사합니다.');
    }
    const inspection = inspectSavedJson(rawForInspection, '1+2');
    rememberInspection(rawForInspection, inspection);

    if (inspection.ok) {
      console.log('%c✅ 기존 저장 결과 파싱 성공!', 'background:#22c55e;color:#000;padding:4px;font-weight:bold');
      console.log('phase:', inspection.parsed.phase);
      console.log('groups 수:', inspection.parsed.phase2?.groups?.length);
      console.log('전체 객체:', inspection.parsed);
      window._v31phase12 = inspection.parsed;
    } else {
      console.log('%c❌ 기존 저장 결과 파싱 실패', 'background:#ef4444;color:#fff;padding:4px;font-weight:bold');
      console.log('에러:', inspection.error.message);
      console.log('저장 결과 길이:', inspection.cleaned.length);
      console.log('앞부분:', inspection.cleaned.slice(0, 500));
      console.log('끝부분:', inspection.cleaned.slice(-500));
      if (inspection.context.position != null) {
        console.log(`JSON 오류 위치: ${inspection.context.position}`);
        console.log('오류 직전:', inspection.context.before);
        console.log('오류 직후:', inspection.context.after);
      }
    }

    console.log('window._v31raw / _v31inspection 에 저장됨');
    return;
  }

  // 2. 备注 배치 조회
  console.log('\n📝 备注 조회...');
  const noteUrl = '/api/translate/string_notes/?' + expectedIds.map(id => `strings=${id}`).join('&');
  const noteData = await fetch(noteUrl, { credentials: 'same-origin' }).then(r => r.json());
  const notesByStringId = {};
  for (const note of (noteData.data || [])) {
    for (const sid of (note.strings || [])) {
      (notesByStringId[sid] ||= []).push({ col: note.col, content: note.content });
    }
  }
  console.log(`  备注 있는 세그먼트: ${Object.keys(notesByStringId).length}개`);

  // 3. 세그먼트 목록 조립
  function formatSegmentList(segmentSubset, startIndex = 0) {
    return segmentSubset.map((seg, index) => {
    const notes = (notesByStringId[seg.id] || [])
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
      `## #${startIndex + index + 1} (id: ${seg.id})`,
      `- 원문: "${seg.origin_string}"`,
    ];
    if (seg.char_limit > 0) lines.push(`- 글자수 제한: ${seg.char_limit}자`);
    if (seg.context) lines.push(`- Context: ${seg.context}`);
    if (terms) lines.push(`- TB 용어:\n${terms}`);
    if (notes) lines.push(`- 备注:\n${notes}`);
    return lines.join('\n');
    }).join('\n\n');
  }

  const segmentList = formatSegmentList(segments);

  if (RUN_MODE === 'phase12-compact' || RUN_MODE === 'phase12-3-compact' || RUN_MODE === 'phase12-3-45-compact') {
    const compactPrompt = buildPhasePrompt(
      '1+2',
      segmentList,
      [
        '---',
        '# Compact JSON output contract',
        '이 테스트에서는 위 문서의 상세 Phase 1+2 출력 스키마를 사용하지 않습니다.',
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
        '50개 전체 세그먼트에 대해 Phase 1+2 분석을 수행하세요.',
        '출력은 compact JSON 한 개만 허용합니다.',
        '모든 Allowed IDs가 정확히 하나의 groups[].ids에 포함되어야 합니다.',
        'Allowed IDs 밖의 id는 하나도 출력하지 마세요.',
        '설명형 문장, 마크다운, 추가 필드는 출력하지 마세요.'
      ].join('\n')
    );

    const result = await runWorkflowPhase({
      phaseTag: '1+2',
      prompt: compactPrompt,
      previousRaw: initialStorageRaw,
    });

    const compact = result.parsed;
    const groupedIds = (compact.groups || []).flatMap(group => group.ids || []);
    const coverage = analyzeIdCoverage(expectedIds, groupedIds);

    console.log('\n%c=== Phase 1+2 compact JSON 테스트 완료 ===', 'background:#10b981;color:#000;padding:3px;font-weight:bold');
    console.log('cats:', compact.cats);
    console.log('groups 수:', compact.groups?.length || 0);
    console.log('id coverage:', coverage.ok ? 'OK' : coverage);

    window._v31phase12Compact = compact;
    window._v31continuity = {
      expectedIds,
      compactOk: true,
      idCoverageOk: coverage.ok,
      coverage,
      groups: compact.groups || [],
    };

    if (RUN_MODE === 'phase12-compact') {
      console.log('window._v31phase12Compact / _v31continuity 에 저장됨');
      console.log(`\n%c⚠️ storageStringId(${storageStringId})의 번역이 오염됨`, 'background:#ef4444;color:#fff;padding:2px');
      console.log('정리: T메뉴 → 清除译文 → 选中字符串 (해당 세그먼트 선택 후)');
      return;
    }

    if (!coverage.ok) {
      throw new Error('Phase 1+2 compact id coverage가 OK가 아니어서 Phase 3 전체 테스트를 중단합니다.');
    }

    const phase3CompactPrompt = buildPhasePrompt(
      '3',
      segmentList,
      [
        '---',
        '# 확정된 Phase 1+2 compact 결과',
        '아래 JSON은 직전 단계의 확정 결과입니다. gid, ids, cats, tone, rules를 그대로 사용하세요.',
        '```json',
        JSON.stringify(compact, null, 2),
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
        '50개 전체 세그먼트에 대해 Phase 3 번역을 수행하세요.',
        'Phase 1+2 compact 결과의 그룹 전략을 그대로 따르세요.',
        '모든 Allowed IDs가 정확히 하나의 translations[] 항목에 포함되어야 합니다.',
        'translations[].gid는 Phase 1+2 groups[].gid와 반드시 일치해야 합니다.',
        'Allowed IDs 밖의 id는 하나도 출력하지 마세요.',
        '번역문에는 한국어 번역만 넣고 설명을 섞지 마세요.',
        'placeholder와 value token은 원문 그대로 보존하세요.'
      ].join('\n')
    );

    const phase3Result = await runWorkflowPhase({
      phaseTag: '3',
      prompt: phase3CompactPrompt,
      previousRaw: result.raw,
    });

    const phase3Compact = phase3Result.parsed;
    const phase3Validation = validatePhase3Compact(compact, phase3Compact, segments);

    window._v31phase3Compact = phase3Compact;
    window._v31continuity = {
      expectedIds,
      compactOk: true,
      phase12Coverage: coverage,
      phase3Validation,
      groups: compact.groups || [],
    };

    console.log('\n%c=== Phase 3 compact 전체 테스트 완료 ===', 'background:#10b981;color:#000;padding:3px;font-weight:bold');
    console.log('translations 수:', phase3Compact.translations?.length || 0);
    console.log('Phase 3 검증:', phase3Validation.ok ? 'OK' : '주의 필요');

    if (RUN_MODE === 'phase12-3-compact') {
      console.log('window._v31phase12Compact / _v31phase3Compact / _v31continuity 에 저장됨');
      console.log(`\n%c⚠️ storageStringId(${storageStringId})의 번역이 오염됨`, 'background:#ef4444;color:#fff;padding:2px');
      console.log('정리: T메뉴 → 清除译文 → 选中字符串 (해당 세그먼트 선택 후)');
      return;
    }

    if (!phase3Validation.ok) {
      throw new Error('Phase 3 compact 검증이 OK가 아니어서 Phase 4+5 전체 테스트를 중단합니다.');
    }

    const phase45CompactPrompt = buildPhasePrompt(
      '4+5',
      segmentList,
      [
        '---',
        '# 확정된 Phase 1+2 compact 결과',
        '아래 JSON은 확정된 그룹 전략입니다. 새 분석을 만들지 말고 그대로 따르세요.',
        '```json',
        JSON.stringify(compact, null, 2),
        '```',
        '',
        '# 확정된 Phase 3 compact 결과',
        '아래 JSON의 translations[].t를 기준으로 검수하세요.',
        '```json',
        JSON.stringify(phase3Compact, null, 2),
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
        '50개 전체 세그먼트에 대해 Phase 4+5 검수를 수행하세요.',
        'Phase 3 번역을 기준으로 검수만 수행하고, 번역을 처음부터 다시 만들지 마세요.',
        '모든 Allowed IDs가 정확히 하나의 revisions[] 항목에 포함되어야 합니다.',
        'revisions[].gid는 Phase 3 translations[].gid와 반드시 일치해야 합니다.',
        'Allowed IDs 밖의 id는 하나도 출력하지 마세요.',
        '문제 없으면 반드시 {"t": null, "r": []} 형태로 유지하세요.',
        '수정 번역문 t에는 한국어 최종 번역만 넣고 설명을 섞지 마세요.',
        'placeholder와 value token은 원문 그대로 보존하세요.'
      ].join('\n')
    );

    const phase45Result = await runWorkflowPhase({
      phaseTag: '4+5',
      prompt: phase45CompactPrompt,
      previousRaw: phase3Result.raw,
    });

    const phase45Compact = phase45Result.parsed;
    const phase45Validation = validatePhase45Compact(phase3Compact, phase45Compact, segments);

    window._v31phase45Compact = phase45Compact;
    window._v31continuity = {
      expectedIds,
      compactOk: true,
      phase12Coverage: coverage,
      phase3Validation,
      phase45Validation,
      groups: compact.groups || [],
    };

    console.log('\n%c=== Phase 4+5 compact 전체 테스트 완료 ===', 'background:#10b981;color:#000;padding:3px;font-weight:bold');
    console.log('revisions 수:', phase45Compact.revisions?.length || 0);
    console.log('Phase 4+5 검증:', phase45Validation.ok ? 'OK' : '주의 필요');
    console.log('window._v31phase12Compact / _v31phase3Compact / _v31phase45Compact / _v31continuity 에 저장됨');
    console.log(`\n%c⚠️ storageStringId(${storageStringId})의 번역이 오염됨`, 'background:#ef4444;color:#fff;padding:2px');
    console.log('정리: T메뉴 → 清除译文 → 选中字符串 (해당 세그먼트 선택 후)');
    return;
  }

  if (RUN_MODE === 'phase12-chunks') {
    const chunks = [];
    for (let start = 0; start < segments.length; start += CHUNK_SIZE) {
      chunks.push({
        index: chunks.length,
        start,
        segments: segments.slice(start, start + CHUNK_SIZE),
      });
    }

    console.log(`\n%c=== Phase 1+2 청크 테스트 시작 (${chunks.length}개 청크, ${CHUNK_SIZE}개 단위) ===`, 'background:#f59e0b;color:#000;padding:3px;font-weight:bold');
    const chunkResults = [];
    let previousRaw = initialStorageRaw;

    for (const chunk of chunks) {
      const chunkNumber = chunk.index + 1;
      const chunkIds = chunk.segments.map(seg => seg.id);
      const chunkPrompt = buildPhasePrompt(
        '1+2',
        formatSegmentList(chunk.segments, chunk.start),
        [
          '---',
          '# 청크 정보',
          `- 전체 세그먼트 수: ${segments.length}`,
          `- 현재 청크: ${chunkNumber}/${chunks.length}`,
          `- 현재 청크 범위: #${chunk.start + 1}~#${chunk.start + chunk.segments.length}`,
        ],
        [
          '위 세그먼트들은 전체 파일의 일부 청크입니다.',
          '이 청크에 대해서만 Phase 1+2 분석을 수행하세요.',
          'segment_ids에는 현재 청크의 id만 포함하세요.',
          'JSON만 출력하세요.'
        ].join('\n')
      );

      console.log(`\n%c--- 청크 ${chunkNumber}/${chunks.length} 실행 ---`, 'background:#fde68a;color:#000;padding:2px;font-weight:bold');
      const result = await runWorkflowPhase({
        phaseTag: '1+2',
        prompt: chunkPrompt,
        previousRaw,
      });
      previousRaw = result.raw;

      const groupedIds = (result.parsed.phase2?.groups || [])
        .flatMap(group => group.segment_ids || []);
      const idCoverageOk = segmentIdsEqual(chunkIds, groupedIds);
      console.log(`청크 ${chunkNumber} id coverage:`, idCoverageOk ? 'OK' : {
        expected: chunkIds,
        actual: groupedIds,
      });

      chunkResults.push({
        chunkNumber,
        start: chunk.start,
        end: chunk.start + chunk.segments.length - 1,
        ids: chunkIds,
        raw: result.raw,
        parsed: result.parsed,
        idCoverageOk,
      });
    }

    const allChunksOk = chunkResults.every(result => result.idCoverageOk);
    window._v31phase12Chunks = chunkResults;
    window._v31continuity = {
      expectedIds,
      chunkSize: CHUNK_SIZE,
      allChunksOk,
      chunks: chunkResults.map(result => ({
        chunkNumber: result.chunkNumber,
        ids: result.ids,
        groups: result.parsed.phase2?.groups?.length || 0,
        idCoverageOk: result.idCoverageOk,
      })),
    };

    console.log('\n%c=== Phase 1+2 청크 테스트 완료 ===', 'background:#10b981;color:#000;padding:3px;font-weight:bold');
    console.log('전체 청크 id coverage:', allChunksOk ? 'OK' : '주의 필요');
    console.log('window._v31phase12Chunks / _v31continuity 에 저장됨');
    console.log(`\n%c⚠️ storageStringId(${storageStringId})의 번역이 오염됨`, 'background:#ef4444;color:#fff;padding:2px');
    console.log('정리: T메뉴 → 清除译文 → 选中字符串 (해당 세그먼트 선택 후)');
    return;
  }

  const phase12Prompt = buildPhasePrompt(
    '1+2',
    segmentList,
    [],
    '위 세그먼트들에 대해 Phase 1+2 분석을 수행하세요. JSON만 출력하세요.'
  );

  const phase12Result = await runWorkflowPhase({
    phaseTag: '1+2',
    prompt: phase12Prompt,
    previousRaw: initialStorageRaw
  });

  const phase12 = phase12Result.parsed;
  console.log('active_categories:', phase12.phase1?.file_overview?.active_categories);
  console.log('note_schema:', phase12.phase1?.file_overview?.note_schema);
  console.log('groups 수:', phase12.phase2?.groups?.length);
  console.log('cross_group_consistency:', phase12.phase2?.cross_group_consistency);

  window._v31phase12 = phase12;
  window._v31continuity = {
    expectedIds,
    phase12Only: RUN_MODE === 'phase12-only',
    phase12Ok: true,
  };

  if (RUN_MODE === 'phase12-only') {
    console.log('\n%c=== Phase 1+2 전용 테스트 완료 ===', 'background:#10b981;color:#000;padding:3px;font-weight:bold');
    console.log('window._v31phase12 / _v31continuity 에 저장됨');
    console.log(`\n%c⚠️ storageStringId(${storageStringId})의 번역이 오염됨`, 'background:#ef4444;color:#fff;padding:2px');
    console.log('정리: T메뉴 → 清除译文 → 选中字符串 (해당 세그먼트 선택 후)');
    return;
  }

  const phase3Prompt = buildPhasePrompt(
    '3',
    segmentList,
    [
      '---',
      '# 확정된 Phase 1+2 분석 결과 (재주입)',
      '아래 JSON은 직전 단계의 확정 결과입니다. 다시 분석하지 말고 그대로 사용하세요.',
      '```json',
      JSON.stringify(phase12, null, 2),
      '```',
    ],
    [
      '위 JSON은 확정된 Phase 1+2 결과입니다.',
      'group_id, active_categories, cross_group_consistency를 그대로 따르세요.',
      '새 분석을 다시 만들지 말고 Phase 3 번역 JSON만 출력하세요.'
    ].join('\n')
  );

  const phase3Result = await runWorkflowPhase({
    phaseTag: '3',
    prompt: phase3Prompt,
    previousRaw: phase12Result.raw
  });
  const phase3 = phase3Result.parsed;
  const phase3Validation = validatePhase3(phase12, phase3, expectedIds);

  const phase45Prompt = buildPhasePrompt(
    '4+5',
    segmentList,
    [
      '---',
      '# 확정된 Phase 1+2 분석 결과 (재주입)',
      '```json',
      JSON.stringify(phase12, null, 2),
      '```',
      '',
      '# 확정된 Phase 3 번역 결과 (재주입)',
      '아래 JSON을 기준으로 자체 검수를 수행하세요. `revisions[].phase3`에는 이 번역문을 그대로 사용하세요.',
      '```json',
      JSON.stringify(phase3, null, 2),
      '```',
    ],
    [
      '위 두 JSON은 직전 단계의 확정 결과입니다.',
      'Phase 3 번역을 기준으로 검수만 수행하고, Phase 4+5 JSON만 출력하세요.',
      '수정이 없으면 `phase4: null`, `changed: false`를 유지하세요.'
    ].join('\n')
  );

  const phase45Result = await runWorkflowPhase({
    phaseTag: '4+5',
    prompt: phase45Prompt,
    previousRaw: phase3Result.raw
  });
  const phase45 = phase45Result.parsed;
  const phase45Validation = validatePhase45(phase12, phase3, phase45, expectedIds);

  window._v31phase12 = phase12;
  window._v31phase3 = phase3;
  window._v31phase45 = phase45;
  window._v31continuity = {
    expectedIds,
    phase3Validation,
    phase45Validation
  };

  console.log('\n%c=== 최종 요약 ===', 'background:#10b981;color:#000;padding:3px;font-weight:bold');
  console.log('Phase 1+2 -> 3 연속성:', phase3Validation.ok ? 'OK' : '주의 필요');
  console.log('Phase 3 -> 4+5 연속성:', phase45Validation.ok ? 'OK' : '주의 필요');
  console.log('window._v31phase12 / _v31phase3 / _v31phase45 / _v31continuity 에 저장됨');

  console.log(`\n%c⚠️ storageStringId(${storageStringId})의 번역이 오염됨`, 'background:#ef4444;color:#fff;padding:2px');
  console.log('정리: T메뉴 → 清除译文 → 选中字符串 (해당 세그먼트 선택 후)');
})();
