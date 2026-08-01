import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, CircleAlert, Clock3, ListTree, LoaderCircle } from 'lucide-react';
import { useStore } from '../store';
import { resolveLocaleMode, translate } from '../lib/i18n';

const ACTIVE_STATUSES = new Set(['running', 'pending', 'waiting']);

function useWorkflowTranslate() {
  const localeMode = useStore((state) => state.guiSettings?.locale || 'system');
  return useMemo(() => {
    const locale = resolveLocaleMode(localeMode);
    return (key, vars) => translate(locale, key, vars);
  }, [localeMode]);
}

function formatElapsed(milliseconds, t) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 1) return t('workflow.elapsedLessThanSecond');
  if (seconds < 60) return t('workflow.elapsedSeconds', { count: seconds });
  return t('workflow.elapsedMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

function formatCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) ? count.toLocaleString() : '0';
}

function formatTokenUsage(tokenUsage, t) {
  if (!tokenUsage) return '';
  const input = Number(tokenUsage.inputTokens || 0);
  const output = Number(tokenUsage.outputTokens || 0);
  const context = Number(tokenUsage.lastContextWindow || 0);
  const parts = [];
  if (input || output) parts.push(`${formatCount(input + output)} ${t('workflow.tokens')}`);
  if (context) parts.push(`${formatCount(context)} ${t('workflow.context')}`);
  return parts.join(' · ');
}

function statusLabel(status, t) {
  const key = `workflow.status.${status || 'running'}`;
  const label = t(key);
  return label === key ? t('workflow.status.running') : label;
}

function phaseLabel(phase, t) {
  const key = `workflow.phase.${phase || 'running'}`;
  const label = t(key);
  return label === key ? t('workflow.phase.unknown') : label;
}

function statusClass(status) {
  if (status === 'failed') return 'workflow-status-dot--failed';
  if (status === 'cancelled') return 'workflow-status-dot--cancelled';
  if (status === 'completed') return 'workflow-status-dot--completed';
  if (status === 'waiting') return 'workflow-status-dot--waiting';
  return 'workflow-status-dot--running';
}

function StatusIcon({ status }) {
  if (status === 'failed') return <CircleAlert size={13} aria-hidden="true" />;
  if (status === 'cancelled') return <CircleAlert size={13} aria-hidden="true" />;
  if (status === 'completed') return <Check size={13} aria-hidden="true" />;
  if (ACTIVE_STATUSES.has(status)) return <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />;
  return <Clock3 size={13} aria-hidden="true" />;
}

function progressLabel(progress, t) {
  if (!progress) return '';
  if (progress.current != null && progress.total != null) {
    return t('workflow.progressCount', { current: progress.current, total: progress.total });
  }
  if (progress.percent != null) return `${Math.round(progress.percent)}%`;
  return progress.message || '';
}

export default function WorkflowStatusPanel({ status }) {
  const t = useWorkflowTranslate();
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [manualOverride, setManualOverride] = useState(false);
  const [expandedMembers, setExpandedMembers] = useState({});

  useEffect(() => {
    if (!status?.active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status?.active, status?.startedAt]);

  useEffect(() => {
    if (!status?.visible) return;
    if (!manualOverride) setExpanded(Boolean(status.active));
  }, [status?.visible, status?.active, status?.startedAt, status?.source, manualOverride]);

  if (!status?.visible) return null;

  const itemLabel = status.source === 'team'
    ? t('workflow.agentCount', { count: status.reportedCount })
    : t('workflow.stepCount', { count: status.items.length });
  const progressText = progressLabel(status.progress, t);
  const phase = phaseLabel(status.phase, t);
  const summary = [phase, itemLabel, progressText].filter(Boolean).join(' · ');
  const elapsed = status.startedAt
    ? formatElapsed(status.active ? now - status.startedAt : status.durationMs, t)
    : '';
  const totalTokens = Number(status.tokenTotals?.inputTokens || 0) + Number(status.tokenTotals?.outputTokens || 0);
  const aggregateOnly = status.capabilityMessage === 'aggregate-only';

  return (
    <section className="workflow-status-panel" data-testid="workflow-status-panel" aria-live="polite">
      <button
        type="button"
        className="workflow-status-panel__header"
        aria-expanded={expanded}
        onClick={() => {
          setManualOverride(true);
          setExpanded((value) => !value);
        }}
      >
        <span className={`workflow-status-dot ${statusClass(status.status)}`} aria-hidden="true" />
        <ListTree size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
        <span className="workflow-status-panel__title">{status.teamName || t('workflow.title')}</span>
        <span className="workflow-status-panel__summary" title={summary}>{summary}</span>
        {elapsed ? <span className="workflow-status-panel__elapsed">{elapsed}</span> : null}
        <span className="workflow-status-panel__status">{statusLabel(status.status, t)}</span>
        <ChevronDown size={14} className={`workflow-status-panel__chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true" />
      </button>

      {expanded ? (
        <div className="workflow-status-panel__body">
          <div className="workflow-status-panel__meta">
            <span>{summary}</span>
            <span className="workflow-status-panel__counts">
              {status.activeCount > 0 ? t('workflow.activeCount', { count: status.activeCount }) : null}
              {status.completedCount > 0 ? t('workflow.completedCount', { count: status.completedCount }) : null}
              {status.failedCount > 0 ? t('workflow.failedCount', { count: status.failedCount }) : null}
            </span>
          </div>
          {totalTokens || status.toolCallCount ? (
            <div className="workflow-status-panel__totals">
              {totalTokens ? <span>{formatCount(totalTokens)} {t('workflow.tokens')}</span> : null}
              {status.toolCallCount ? <span>{formatCount(status.toolCallCount)} {t('workflow.tools')}</span> : null}
              {status.runId ? <span className="workflow-status-panel__run-id" title={status.runId}>{status.runId}</span> : null}
            </div>
          ) : null}
          {aggregateOnly ? (
            <div className="workflow-status-panel__capability">{t('workflow.aggregateOnly')}</div>
          ) : null}
          {status.progress?.percent != null ? (
            <div className="workflow-status-panel__progress" aria-label={progressText}>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${status.progress.percent}%` }} />
              </div>
              {status.progress.message ? <span title={status.progress.message}>{status.progress.message}</span> : null}
            </div>
          ) : null}
          {status.items.length ? (
            <div className="workflow-status-panel__items">
              {status.items.map((item) => {
                const itemProgress = progressLabel(item.progress, t);
                const tokenText = formatTokenUsage(item.tokenUsage, t);
                const detail = [item.role, item.task || item.description, itemProgress].filter(Boolean).join(' · ');
                const hasDetails = status.source === 'team' && (item.description || tokenText || item.toolCallCount || item.historyAvailable);
                const memberExpanded = Boolean(expandedMembers[item.id]);
                return (
                  <div className="workflow-status-item" key={item.id}>
                    <span
                      className={`workflow-status-dot ${statusClass(item.status)}`}
                      style={item.color ? { backgroundColor: item.color } : undefined}
                      aria-hidden="true"
                    />
                    <StatusIcon status={item.status} />
                    <div className="workflow-status-item__main">
                      <div className="workflow-status-item__line">
                        <span className="workflow-status-item__name" title={item.name}>{item.name}</span>
                        <span className="workflow-status-item__state">{statusLabel(item.status, t)}</span>
                      </div>
                      <span className="workflow-status-item__detail" title={detail}>{detail || statusLabel(item.status, t)}</span>
                      {hasDetails ? (
                        <button
                          type="button"
                          className="workflow-status-item__details-toggle"
                          aria-expanded={memberExpanded}
                          onClick={() => setExpandedMembers((current) => ({ ...current, [item.id]: !current[item.id] }))}
                        >
                          {item.toolCallCount ? `${formatCount(item.toolCallCount)} ${t('workflow.tools')}` : null}
                          {tokenText ? ` · ${tokenText}` : null}
                          {item.historyAvailable ? ` · ${t('workflow.historyAvailable')}` : null}
                        </button>
                      ) : null}
                      {memberExpanded ? (
                        <div className="workflow-status-item__expanded">
                          {item.description || item.task ? <div>{item.description || item.task}</div> : null}
                          {item.taskId || item.sessionId ? <div className="workflow-status-item__ids">{item.taskId || item.sessionId}</div> : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="workflow-status-panel__empty">
              {status.status === 'waiting' && status.phase === 'waiting_for_permission'
                ? t('workflow.waitingForPermission')
                : status.source === 'team'
                  ? t('workflow.initializingTeam')
                  : t('workflow.waitingForSteps')}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export { formatElapsed };
