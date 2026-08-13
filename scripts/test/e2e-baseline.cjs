#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeText, writeTaskEvidence } = require('./evidence-writer.cjs');

const BASELINE_STATUS = 'BASELINE_FAIL';
const RELEASE_DISPOSITION = 'NOT_RELEASE_PASS';

const COVERAGE_REVIEW = '.omo/evidence/codebuddygui-e2e-coverage-code-level-gate-review.md';
const ROUTE_REVIEW = '.omo/evidence/codebuddygui-route-screenshots-gate-review.md';
const SECURITY_REVIEW = '.omo/evidence/electron-ipc-security-boundary-code-review.md';
const TARGETED_SUMMARY = '.omo/e2e-targeted/2026-07-09T16-00-02-931Z/targeted-summary.json';
const DRAFT_FINDINGS = '.omo/drafts/codex-style-multi-project-codebuddy-gui.md';
const IMPLEMENTATION_PLAN = '.omo/plans/codex-style-multi-project-codebuddy-gui.md';

const BASELINE_SOURCES = Object.freeze([
  {
    path: COVERAGE_REVIEW,
    sha256: 'F5962624012AD53E58FDE0FC0A645CF901DB7839C4106D9A11663FE255629262',
    anchor: 'Task 1 pre-implementation evidence anchor',
  },
  {
    path: ROUTE_REVIEW,
    sha256: '28981808276CA0A6F1E50747AE4E6B8A7AF877B74B623923F34AEA03FDCC2F0B',
    anchor: 'Pre-existing route screenshot gate artifact',
  },
  {
    path: SECURITY_REVIEW,
    sha256: '3F958D25D3EE63DA7070D9B2BEA6E9D869ED37759397F7D3B963D74DB4D787B0',
    anchor: 'Pre-existing IPC/security gate artifact',
  },
  {
    path: TARGETED_SUMMARY,
    sha256: 'E5A1B63927C7279DD572D72E8E0C64E2DD8CFF56E8FBCA36E1C84245E4D02E9C',
    anchor: 'Task 1 pre-implementation evidence anchor',
  },
]);

function source(pathValue, section) {
  return { path: pathValue, section };
}

const BASELINE_INVENTORY = Object.freeze([
  {
    id: 'packaged-startup-log-path',
    title: 'Packaged harness read the project-root log instead of app.getPath(userData)',
    classification: 'confirmed-harness-defect',
    disposition: 'RESOLVED_BY_TASK_1_HARNESS',
    owningTask: 'Task 1; final release orchestration Task 29/F1',
    sources: [source(COVERAGE_REVIEW, 'blockers — packaged gate failed')],
  },
  {
    id: 'fixed-cdp-port',
    title: 'Packaged harness hard-coded CDP port 9225',
    classification: 'confirmed-harness-defect',
    disposition: 'RESOLVED_BY_TASK_1_HARNESS',
    owningTask: 'Task 1; final release orchestration Task 29/F1',
    sources: [source(COVERAGE_REVIEW, 'blockers/evidence — fixed DEBUG_PORT = 9225')],
  },
  {
    id: 'packaged-gate-not-passing',
    title: 'No passing packaged application E2E evidence existed',
    classification: 'confirmed-evidence-gap',
    disposition: 'RESOLVED_BY_TASK_1_HARNESS',
    owningTask: 'Task 1; mandatory release runner Task 29/F1',
    sources: [source(COVERAGE_REVIEW, 'exactEvidenceGaps — no passing packaged-app E2E')],
  },
  {
    id: 'shallow-route-gate',
    title: 'Route acceptance used root text length and section-title existence',
    classification: 'confirmed-overfit-test-defect',
    disposition: 'RESOLVED_BY_TASK_1_HARNESS',
    owningTask: 'Task 1; final audit Task 29/F1',
    sources: [
      source(COVERAGE_REVIEW, 'directRemoveAiSlopsAndProgrammingPass — shallow DOM checks'),
      source(ROUTE_REVIEW, 'direct remove-ai-slops / programming pass'),
    ],
  },
  {
    id: 'source-regex-ipc-confidence',
    title: 'IPC confidence came from source regex instead of hostile renderer behavior',
    classification: 'confirmed-overfit-test-defect',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 2; final hostile-boundary regression Task 28/F2/F3',
    sources: [source(COVERAGE_REVIEW, 'directRemoveAiSlopsAndProgrammingPass — source-regex IPC checks')],
  },
  {
    id: 'remote-navigation-preload',
    title: 'Remote navigation can inherit the privileged preload API',
    classification: 'confirmed-security-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 2; final Task 28/F2/F3',
    sources: [source(SECURITY_REVIEW, 'CRITICAL 1 — Remote navigation can inherit the privileged preload API')],
  },
  {
    id: 'arbitrary-localhost-proxy',
    title: 'Renderer-facing CodeBuddy proxy accepts arbitrary localhost targets',
    classification: 'confirmed-security-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 2; final Task 28/F2/F3',
    sources: [source(SECURITY_REVIEW, 'HIGH 2 — arbitrary localhost SSRF primitive')],
  },
  {
    id: 'arbitrary-git-cwd',
    title: 'Git IPC accepts arbitrary cwd and -C workspace escape',
    classification: 'confirmed-security-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 3; final Task 17/28',
    sources: [source(SECURITY_REVIEW, 'HIGH 3 — Git IPC workspace escape and side effects')],
  },
  {
    id: 'global-image-name-kill',
    title: 'Product quit fallback can kill every node.exe/codebuddy.exe by image name',
    classification: 'confirmed-security-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 4; soak/restart Task 27 and final Task 28',
    sources: [source(SECURITY_REVIEW, 'HIGH 4 — Exiting can kill every node.exe process')],
  },
  {
    id: 'password-exposed-to-renderer',
    title: 'CodeBuddy password is returned to renderer and reused in a query URL',
    classification: 'confirmed-security-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 2; final Task 28/F2/F3',
    sources: [source(SECURITY_REVIEW, 'HIGH 5 — password returned to renderer')],
  },
  {
    id: 'auth-disabled-serve-password-contract',
    title: 'Auth-disabled codebuddy --serve omits a password while desktop startup requires one',
    classification: 'confirmed-runtime-compatibility-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Tasks 2/4; compatibility Tasks 8/26; final Task 28/F2',
    sources: [
      source(
        '.omo/evidence/task-1-runs/task-1-unpackaged-renderer-auth-disabled-classifier-2026-07-11T15-01-46-298Z/report.md',
        'Sanitized real classifier evidence — clean auth-disabled profile announced a port without a password and emitted the named baseline blocker',
      ),
    ],
  },
  {
    id: 'backend-cancel-semantic-noop',
    title: 'Stop clears renderer streaming state without backend session/cancel acknowledgement, so backend activity may continue',
    classification: 'confirmed-runtime-semantic-defect',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 5; follow-through Tasks 10/15/29 and final F3',
    sources: [
      source(DRAFT_FINDINGS, 'confirmed finding — Stop clears renderer state without calling session/cancel'),
      source(IMPLEMENTATION_PLAN, 'Task 5 — backend acknowledgement, failure handling, and post-stop activity verification'),
    ],
  },
  {
    id: 'permission-mode-label-collapse',
    title: 'auto, dontAsk, and bypassPermissions collapse into the same unsafe copy and semantics',
    classification: 'confirmed-permission-semantic-defect',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Tasks 5/15; visual terminology Task 25',
    sources: [
      source(DRAFT_FINDINGS, 'confirmed finding — permission labels collapse distinct risky modes'),
      source(IMPLEMENTATION_PLAN, 'Tasks 5/15 — exact capability-derived permission mode ids and copy'),
    ],
  },
  {
    id: 'stalled-sse-reader',
    title: 'SSE timeout can hang forever when reader.read stalls',
    classification: 'confirmed-runtime-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 4; soak/restart Task 27 and final Task 28',
    sources: [source(SECURITY_REVIEW, 'HIGH 6 — stalled SSE timeout')],
  },
  {
    id: 'external-protocol-allowlist',
    title: 'shell.openExternal accepts arbitrary renderer-created protocols',
    classification: 'confirmed-security-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 2; final Task 28/F2/F3',
    sources: [source(SECURITY_REVIEW, 'MEDIUM 7 — openExternal protocol handling')],
  },
  {
    id: 'stream-owner-lifecycle',
    title: 'Stream lifecycle is not bound to the owning WebContents',
    classification: 'confirmed-runtime-security-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 2; final Task 28/F2/F3',
    sources: [source(SECURITY_REVIEW, 'MEDIUM 8 — stream lifecycle ownership')],
  },
  {
    id: 'terminal-lifecycle-resource-leaks',
    title: 'Terminal close leaks PTYs while pane output, split count, and reconnect resources are unbounded',
    classification: 'confirmed-runtime-resource-leak',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 18; soak/recovery Task 27 and final F2/F3',
    sources: [
      source(DRAFT_FINDINGS, 'confirmed finding — PTY release, unbounded pane output, and unbounded split count'),
      source(IMPLEMENTATION_PLAN, 'Tasks 18/27 — bounded PTY lifecycle, replay, split, reconnect, and soak cleanup'),
    ],
  },
  {
    id: 'git-validator-mirror',
    title: 'Security tests validate a mirror instead of the real main-process boundary',
    classification: 'confirmed-overfit-test-defect',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 3; final Task 17/28',
    sources: [source(SECURITY_REVIEW, 'LOW 9 — tests mirror implementation')],
  },
  {
    id: 'generic-visible-fake-controls',
    title: 'Visible actions can remain fake, placeholder, or unavailable while route checks pass',
    classification: 'confirmed-functional-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 6, then route-specific functional tasks; final F3',
    sources: [source(COVERAGE_REVIEW, 'userOutcomeReview/blockers — visible placeholder actions')],
  },
  {
    id: 'workers-placeholder-actions',
    title: 'Workers stop/restart actions display 功能开发中',
    classification: 'confirmed-functional-placeholder',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 20',
    sources: [source(COVERAGE_REVIEW, 'blockers/evidence — ReplicaWorkersView placeholders')],
  },
  {
    id: 'instances-placeholder-actions',
    title: 'Instances add/manual-add actions are placeholders',
    classification: 'confirmed-functional-placeholder',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 20',
    sources: [
      source(COVERAGE_REVIEW, 'blockers/evidence — ReplicaInstancesView placeholders'),
      source(TARGETED_SUMMARY, 'checks.instancesPlaceholder = true'),
    ],
  },
  {
    id: 'workspace-folder-delete-placeholders',
    title: 'Workspace create-folder and delete actions are placeholders/no-result',
    classification: 'confirmed-functional-placeholder',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 16',
    sources: [
      source(COVERAGE_REVIEW, 'blockers/evidence — Workspace new folder/delete placeholders'),
      source(TARGETED_SUMMARY, 'checks.folderExists = false'),
    ],
  },
  {
    id: 'workspace-create-file-no-result',
    title: 'Targeted workspace create-file produced no file and no visible error',
    classification: 'confirmed-targeted-runtime-defect',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 16',
    sources: [source(TARGETED_SUMMARY, 'checks.fileExists = false; fileErrorVisible = false')],
  },
  {
    id: 'docs-incomplete-content',
    title: 'Docs falls back to incomplete placeholder body for most entries',
    classification: 'confirmed-functional-placeholder',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 23',
    sources: [source(COVERAGE_REVIEW, 'blockers/evidence — Docs incomplete body')],
  },
  {
    id: 'keybindings-local-only',
    title: 'Keybindings are static/localStorage-backed instead of backend-driven',
    classification: 'confirmed-functional-gap',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 23',
    sources: [source(COVERAGE_REVIEW, 'evidence — ReplicaKeybindingsView local-only behavior')],
  },
  {
    id: 'missing-reference-snapshots',
    title: 'Required settings.yaml and chat-session.yaml WebUI references are absent',
    classification: 'confirmed-reference-gap',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 23/25; final F1/F3',
    sources: [source(COVERAGE_REVIEW, 'blockers — missing required reference files')],
  },

  {
    id: 'metrics-impossible-disk-units',
    title: 'Metrics renders impossible disk GiB values and wrapped labels',
    classification: 'confirmed-visual-data-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 24; visual Task 25',
    sources: [source(ROUTE_REVIEW, 'blockers 2 / userOutcomeReview — metrics.png')],
  },
  {
    id: 'traces-toolbar-clipping',
    title: 'Traces search and refresh controls are clipped/wrapped',
    classification: 'confirmed-visual-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 24; responsive visual Task 25',
    sources: [source(ROUTE_REVIEW, 'blockers 3 / userOutcomeReview — traces.png')],
  },
  {
    id: 'cjk-mojibake',
    title: 'Instances/sidebar session titles contain CJK replacement glyphs',
    classification: 'confirmed-text-integrity-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 25',
    sources: [source(ROUTE_REVIEW, 'blockers 4 / userOutcomeReview — instances/sidebar mojibake')],
  },
  {
    id: 'terminal-terminology-status-mismatch',
    title: 'Terminal heading/connection status is visually inconsistent',
    classification: 'confirmed-visual-blocker',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 24/25; lifecycle Task 18/27',
    sources: [source(ROUTE_REVIEW, 'userOutcomeReview — terminal.png')],
  },
  {
    id: 'stats-empty-dash-state',
    title: 'Stats presents mostly empty dash cards without proving intended no-data behavior',
    classification: 'confirmed-visual-functional-gap',
    disposition: 'OPEN_BASELINE_BLOCKER',
    owningTask: 'Task 24/25',
    sources: [source(ROUTE_REVIEW, 'userOutcomeReview — stats.png')],
  },
  {
    id: 'generic-empty-route-states',
    title: 'Logs/plugins/traces/stats generic empty states do not demonstrate functional parity',
    classification: 'confirmed-functional-evidence-gap',
    disposition: 'OPEN_EVIDENCE_GAP',
    owningTask: 'Task 21/24/25; final F3',
    sources: [source(ROUTE_REVIEW, 'userOutcomeReview — generic empty states')],
  },
  {
    id: 'plugins-marketplace-action-coverage',
    title: 'Plugin install/uninstall/toggle and marketplace add/remove are unproven',
    classification: 'confirmed-evidence-gap',
    disposition: 'OPEN_EVIDENCE_GAP',
    owningTask: 'Task 21',
    sources: [source(COVERAGE_REVIEW, 'exactEvidenceGaps — plugins/marketplace actions')],
  },
  {
    id: 'tasks-goals-remote-action-coverage',
    title: 'Task CRUD and remote-channel create/delete/toggle flows are unproven',
    classification: 'confirmed-evidence-gap',
    disposition: 'OPEN_EVIDENCE_GAP',
    owningTask: 'Task 22',
    sources: [source(COVERAGE_REVIEW, 'exactEvidenceGaps — tasks and remote-control actions')],
  },
  {
    id: 'session-git-pty-action-coverage',
    title: 'Session mutation, Git confirmations/recovery, and PTY split/close/reconnect are unproven',
    classification: 'confirmed-evidence-gap',
    disposition: 'OPEN_EVIDENCE_GAP',
    owningTask: 'Task 17/18/27',
    sources: [source(COVERAGE_REVIEW, 'exactEvidenceGaps — session/Git/PTY action outcomes')],
  },
  {
    id: 'cli-capability-compatibility',
    title: 'Missing/partial/future CLI capability degradation is not covered',
    classification: 'confirmed-evidence-gap',
    disposition: 'OPEN_EVIDENCE_GAP',
    owningTask: 'Task 8/26',
    sources: [source(COVERAGE_REVIEW, 'userOutcomeReview/exactEvidenceGaps — incomplete major-function proof')],
  },
  {
    id: 'responsive-a11y-visual-coverage',
    title: 'No smaller-viewport crop, responsive, accessibility, or final visual-system evidence',
    classification: 'confirmed-evidence-gap',
    disposition: 'OPEN_EVIDENCE_GAP',
    owningTask: 'Task 25; final F3',
    sources: [source(ROUTE_REVIEW, 'evidenceGaps — no smaller/mobile viewport evidence')],
  },
  {
    id: 'manual-qa-matrix-missing',
    title: 'No complete manual QA matrix, changed-file evidence, or independent review artifact',
    classification: 'confirmed-evidence-gap',
    disposition: 'OPEN_EVIDENCE_GAP',
    owningTask: 'Final F1/F3',
    sources: [
      source(COVERAGE_REVIEW, 'exactEvidenceGaps — no manual QA matrix'),
      source(ROUTE_REVIEW, 'blockers 6 / evidenceGaps'),
    ],
  },
]);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function verifyBaselineSources(projectRoot, options = {}) {
  const allowMissingSources = Boolean(options.allowMissingSources);
  const sources = options.sources || BASELINE_SOURCES;
  return sources.map((sourceItem) => {
    const absolutePath = path.join(projectRoot, ...sourceItem.path.split('/'));
    if (!fs.existsSync(absolutePath)) {
      if (!allowMissingSources) throw new Error(`Immutable baseline source is missing: ${sourceItem.path}`);
      return {
        ...sourceItem,
        present: false,
        verified: false,
        verification: 'not-verified',
      };
    }
    const actualSha256 = sha256File(absolutePath);
    if (actualSha256 !== sourceItem.sha256) {
      throw new Error(`Immutable baseline source hash changed: ${sourceItem.path}`);
    }
    return {
      ...sourceItem,
      present: true,
      verified: true,
      verification: 'sha256-verified',
    };
  });
}

async function captureBaseline(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..', '..'));
  const outputRoot = path.resolve(
    options.outputRoot || path.join(projectRoot, '.omo', 'evidence', 'task-1-baseline'),
  );
  const allowMissingSources = Boolean(options.allowMissingSources);
  const sources = options.sources || BASELINE_SOURCES;
  const baselineSources = verifyBaselineSources(projectRoot, { allowMissingSources, sources });
  const verifiedSourceCount = baselineSources.filter((sourceItem) => sourceItem.verified).length;
  const missingSourceCount = baselineSources.filter((sourceItem) => !sourceItem.present).length;
  return writeTaskEvidence({
    rootDir: outputRoot,
    taskId: 'task-1',
    runLabel: 'baseline',
    timestamp: options.timestamp || process.env.CODEBUDDY_E2E_RUN_ID || new Date().toISOString(),
    status: BASELINE_STATUS,
    releaseDisposition: RELEASE_DISPOSITION,
    context: {
      baselineCaptureOnly: true,
      captureMode: allowMissingSources ? 'registry-only' : 'strict-local',
      commandSuccessMeaning: 'Immutable baseline inventory captured; this is not a product release pass.',
      sourceCount: baselineSources.length,
      verifiedSourceCount,
      missingSourceCount,
      blockerCount: BASELINE_INVENTORY.length,
    },
    commands: [
      {
        command: allowMissingSources
          ? 'node scripts/test/e2e-baseline.cjs --allow-missing-sources'
          : 'npm run test:e2e:baseline',
        exitCode: 0,
      },
    ],
    baselineSources,
    baselineInventory: BASELINE_INVENTORY,
    assertions: baselineSources.map((sourceItem) => ({
      name: sourceItem.verified
        ? `immutable source hash verified: ${sourceItem.path}`
        : `immutable source unavailable in registry-only capture: ${sourceItem.path}`,
      ok: sourceItem.verified,
      detail: sourceItem.verified ? sourceItem.sha256 : sourceItem.verification,
    })),
  });
}

async function main() {
  const allowMissingSources = process.argv.includes('--allow-missing-sources');
  const captured = await captureBaseline({ allowMissingSources });
  console.log(BASELINE_STATUS);
  console.log(RELEASE_DISPOSITION);
  if (allowMissingSources) {
    console.log(
      `[baseline] registry-only sources=${captured.data.context.sourceCount}; ` +
        `present=${captured.data.context.sourceCount - captured.data.context.missingSourceCount}; ` +
        `verified=${captured.data.context.verifiedSourceCount}; missing=${captured.data.context.missingSourceCount}`,
    );
  } else {
    console.log(`[baseline] immutable sources verified=${captured.data.context.verifiedSourceCount}`);
  }
  console.log(`[baseline] inventory items=${BASELINE_INVENTORY.length}`);
  console.log(`[baseline] capture succeeded; release verdict remains ${RELEASE_DISPOSITION}`);
  console.log(`[evidence] ${captured.reportPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(sanitizeText(error.stack || error.message || error));
    process.exitCode = 1;
  });
}

module.exports = {
  BASELINE_STATUS,
  RELEASE_DISPOSITION,
  BASELINE_SOURCES,
  BASELINE_INVENTORY,
  captureBaseline,
  verifyBaselineSources,
};
