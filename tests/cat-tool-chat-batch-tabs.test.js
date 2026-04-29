const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'cat-tool-chat.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');

test('keeps existing single-segment chat controls while adding main tabs', () => {
    assert.match(source, /class="tw-chat-input"/);
    assert.match(source, /class="tw-btn tw-btn-primary tw-btn-send"/);
    assert.match(source, /class="tw-btn tw-btn-primary tw-btn-adopt"/);

    assert.match(source, /class="tw-main-tabs"/);
    assert.match(source, /data-tab="chat"/);
    assert.match(source, /data-tab="batch"/);
    assert.match(source, /data-tab="review"/);
    assert.match(source, /data-tab="logs"/);
});

test('defines persistent batch workflow state keys', () => {
    assert.match(source, /BATCH_RUNS:\s*'tms_workflow_batch_runs_v1'/);
    assert.match(source, /ACTIVE_BATCH_RUN:\s*'tms_workflow_active_batch_run_v1'/);
});

test('supports clearing only the active batch workflow run from the batch tab', () => {
    assert.match(source, /tw-btn-batch-reset/);
    assert.match(source, /function\s+clearActiveBatchRun\s*\(/);
    assert.match(source, /function\s+onBatchReset\s*\(/);
    assert.match(source, /delete\s+runs\[runId\]/);
    assert.match(source, /LS_KEYS\.ACTIVE_BATCH_RUN,\s*null/);
    assert.match(source, /addEventListener\('click',\s*onBatchReset\)/);
});

test('includes compact workflow parser and validation gates', () => {
    [
        'normalizeSegmentListResponse',
        'analyzeIdCoverage',
        'parseWorkflowJson',
        'classifySavedResult',
        'validatePhase12Compact',
        'validatePhase3Compact',
        'validatePhase45Compact',
        'extractPlaceholders',
    ].forEach((name) => {
        assert.match(source, new RegExp(`function\\s+${name}\\s*\\(`));
    });
});

test('wires batch UI buttons without auto-apply controls', () => {
    [
        'tw-btn-batch-collect',
        'tw-btn-phase12',
        'tw-btn-phase3',
        'tw-btn-phase45',
        'tw-btn-batch-refetch',
        'tw-batch-status',
        'tw-review-table',
        'tw-log-output',
    ].forEach((className) => {
        assert.match(source, new RegExp(className));
    });

    assert.doesNotMatch(source, /tw-btn-batch-auto-apply/);
});

test('presents batch execution as a chat-like workflow panel with shared selectors', () => {
    [
        'tw-batch-sidebar',
        'tw-batch-chat-panel',
        'tw-batch-timeline',
        'tw-batch-input-wrap',
        'tw-batch-prompt-select',
        'tw-batch-model-select',
        'renderBatchTimeline',
        'renderAllPromptSelects',
        'renderAllModelSelects',
        'syncPromptSelects',
        'syncModelSelects',
    ].forEach((name) => {
        assert.match(source, new RegExp(name));
    });

    assert.match(source, /배치 프롬프트:/);
    assert.match(source, /배치 모델:/);
    assert.match(source, /tw-batch-event/);
});

test('handles stale reads, last errors, and validation details explicitly', () => {
    assert.match(source, /STALE_RESULT/);
    assert.match(source, /bedrock_timeout/);
    assert.match(source, /lastExpectedPhase/);
    assert.match(source, /lastError/);
    assert.match(source, /Validation object/);
    assert.match(source, /function\s+batchRunMatchesCurrentUrl\s*\(/);
    assert.match(source, /function\s+getRawForPhase\s*\(/);
    assert.match(source, /function\s+onBatchRefetchResult\s*\(/);
});

test('supports review-tab textarea injection controls without saving automatically', () => {
    [
        'tw-review-toolbar',
        'tw-btn-review-apply-selected',
        'tw-btn-review-apply-all',
        'tw-btn-apply-final',
        'tw-review-select',
        'tw-review-select-all',
        'tw-review-apply-status',
    ].forEach((className) => {
        assert.match(source, new RegExp(className));
    });

    [
        'findStringItemByStringId',
        'findTranslationTextareaForStringId',
        'applyBatchFinalToTextarea',
        'applyBatchTranslationsByIds',
        'getSelectedReviewIds',
    ].forEach((name) => {
        assert.match(source, new RegExp(`function\\s+${name}\\s*\\(`));
    });

    assert.doesNotMatch(source, /results_active/);
});

test('keeps review layout responsive at smaller modal widths', () => {
    assert.match(source, /@media\s*\(max-width:\s*760px\)/);
    assert.match(source, /\.tw-review-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(source, /\.tw-review-head\s*\{[\s\S]*display:\s*none/);
    assert.match(source, /data-label="Phase 3"/);
    assert.match(source, /data-label="최종 후보"/);
});

test('injects a file-level TB summary into batch prompts', () => {
    [
        'extractVisibleTbTerms',
        'extractBatchApiTerms',
        'buildBatchTbSummary',
        'formatBatchTbSummary',
    ].forEach((name) => {
        assert.match(source, new RegExp(`function\\s+${name}\\s*\\(`));
    });

    assert.match(source, /span\.vb\[data-tooltip\]/);
    assert.match(source, /# 파일 전체 TB 용어/);
    assert.match(source, /run\.tbSummary/);
});
