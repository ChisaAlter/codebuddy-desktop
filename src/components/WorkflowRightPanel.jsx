import React, { useMemo, useState } from 'react';
import { ChevronDown, CircleAlert, ListTree } from 'lucide-react';
import { useStore } from '../store';
import { resolveThreadTimeline } from '../store/helpers/thread-runtime';
import { deriveWorkflowView } from '../lib/workflow-status';
import { currentGoal, goalList, goalsFromTimeline } from '../lib/goal-state';
import { resolveLocaleMode, translate } from '../lib/i18n';
import { collectSubagentReports } from '../lib/subagent-report';
import { formatElapsed } from './WorkflowStatusPanel';

function useTranslate() {
  const locale = useStore((state) => state.guiSettings?.locale || 'system');
  return useMemo(() => {
    const resolved = resolveLocaleMode(locale);
    return (key, vars) => translate(resolved, key, vars);
  }, [locale]);
}

function statusColor(status) {
  if (status === 'failed') return 'var(--color-accent-red)';
  if (status === 'cancelled') return 'var(--color-text-muted)';
  if (status === 'completed') return 'var(--color-accent-green)';
  if (status === 'waiting') return 'var(--color-accent-yellow)';
  return 'var(--color-accent-blue)';
}

function statusText(status, t) {
  const key = `workflow.status.${status || 'running'}`;
  const value = t(key);
  return value === key ? t('workflow.status.running') : value;
}

function progressText(progress, t) {
  if (!progress) return '';
  if (progress.current != null && progress.total != null) return t('workflow.progressCount', progress);
  if (progress.percent != null) return `${Math.round(progress.percent)}%`;
  return progress.message || '';
}

function goalKindText(kind, t) {
  if (!kind) return '';
  const key = `goal.status.${String(kind).toLowerCase()}`;
  const value = t(key);
  return value === key ? '' : value;
}

function GoalCard({ goal, t, waitingOnly = false }) {
  if (!goal && !waitingOnly) return null;
  const progress = goal?.progress || {};
  const label = progressText(progress, t);
  const title = goal?.title || t('goal.current');
  const status = goal?.status || 'running';
  const terminalKey = ['completed', 'failed', 'cancelled'].includes(status) ? `goal.terminal.${status}` : null;
  const kindLabel = goalKindText(goal?.kind, t);
  const message =
    goal?.message ||
    kindLabel ||
    (waitingOnly || goal?.seeded ? t('goal.waitingProgress') : '');
  return (
    <section className="workflow-right-panel__section workflow-right-panel__goal" data-testid="workflow-current-goal">
      <div className="workflow-right-panel__section-title">
        <span>{terminalKey ? t(terminalKey) : t('goal.current')}</span>
        <span className="workflow-right-panel__status" style={{ color: statusColor(status) }}>{statusText(status, t)}</span>
      </div>
      <div className="workflow-right-panel__goal-title" title={title}>{title}</div>
      {progress.percent != null ? (
        <div className="workflow-right-panel__progress">
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress.percent}%` }} /></div>
          <span>{label}</span>
        </div>
      ) : null}
      {goal?.condition ? (
        <div className="workflow-right-panel__muted" title={goal.condition}>
          {t('goal.condition')}: {goal.condition}
        </div>
      ) : null}
      {goal?.reason ? (
        <div className="workflow-right-panel__muted" title={goal.reason}>
          {t('goal.reason')}: {goal.reason}
        </div>
      ) : null}
      {message && message !== goal?.condition && message !== title ? (
        <div className="workflow-right-panel__muted" title={message}>{message}</div>
      ) : null}
      {goal?.turnCount != null ? (
        <div className="workflow-right-panel__muted">{goal.turnCount} turns</div>
      ) : null}
    </section>
  );
}

function MemberRow({ member, history, t }) {
  const [expanded, setExpanded] = useState(false);
  const entries = Array.isArray(history) ? history.slice(-8) : [];
  const canExpand = Boolean(entries.length || member.description || member.task || member.agentId || member.taskId || member.sessionId);
  return (
    <div className="workflow-right-panel__member">
      <button
        type="button"
        className="workflow-right-panel__member-button"
        onClick={() => canExpand && setExpanded((value) => !value)}
        aria-expanded={canExpand ? expanded : undefined}
      >
        <span className="workflow-status-dot" style={{ backgroundColor: member.color || statusColor(member.status) }} aria-hidden="true" />
        <span className="workflow-right-panel__member-main">
          <span className="workflow-right-panel__member-line">
            <span className="workflow-right-panel__member-name" title={member.name}>{member.name}</span>
            <span className="workflow-right-panel__status">{statusText(member.status, t)}</span>
          </span>
          <span className="workflow-right-panel__member-detail" title={member.task || member.description || ''}>{member.task || member.description || t('workflow.noMemberTask')}</span>
        </span>
        {canExpand ? <ChevronDown size={13} className={expanded ? 'rotate-180' : ''} aria-hidden="true" /> : null}
      </button>
      {expanded ? (
        <div className="workflow-right-panel__member-detail-box">
          {member.description || member.task ? <div>{member.description || member.task}</div> : null}
          {member.agentId || member.subagentId || member.taskId || member.sessionId ? (
            <div className="workflow-right-panel__member-id" title={member.agentId || member.subagentId || member.taskId || member.sessionId}>
              {member.agentId || member.subagentId || member.taskId || member.sessionId}
            </div>
          ) : null}
          {entries.length ? (
            <div className="workflow-right-panel__member-history">
              {entries.map((entry, index) => (
                <div key={entry.id || `${entry.type}-${index}`} className="workflow-right-panel__history-line">
                  <span>{entry.type === 'tool_call' ? (entry.title || entry.kind || t('workflow.toolEvent')) : entry.content || entry.message || t('workflow.activityEvent')}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GoalLog({ timeline, t }) {
  const [expanded, setExpanded] = useState(false);
  const events = useMemo(
    () => (Array.isArray(timeline) ? timeline : [])
      .filter((item) => item?.type === 'goal-progress' || item?.type === 'goal-status')
      .slice(-80)
      .reverse(),
    [timeline],
  );
  if (!events.length) return null;
  return (
    <section className="workflow-right-panel__section">
      <button type="button" className="workflow-right-panel__section-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span>{t('goal.eventLog')}</span>
        <span className="workflow-right-panel__count">{events.length}</span>
        <ChevronDown size={13} className={expanded ? 'rotate-180' : ''} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="workflow-right-panel__goal-log">
          {events.map((item, index) => {
            const payload = item.meta || item.raw || item;
            const label = payload.title || payload.name || payload.message || t('goal.updated');
            const progress = payload.progress || payload;
            const percent = Number(progress.percent ?? progress.percentage);
            return (
              <div key={item.id || `${item.type}-${index}`} className="workflow-right-panel__log-item">
                <span className="workflow-right-panel__log-dot" style={{ backgroundColor: item.type === 'goal-status' ? statusColor(payload.status) : 'var(--color-accent-blue)' }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate" title={label}>{label}</span>
                  <span className="workflow-right-panel__muted">{Number.isFinite(percent) ? `${Math.round(percent)}%` : statusText(payload.status || 'running', t)}</span>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function overviewStats({ status, elapsed, totalTokens, t, hasGoal = false }) {
  // Real agents / non-goal steps only — never count synthetic goal rows as "1/1 项".
  const members = Array.isArray(status.members) ? status.members : [];
  const steps = (Array.isArray(status.steps) ? status.steps : []).filter(
    (item) => item?.kind && item.kind !== 'tool' && item.kind !== 'goal',
  );
  const itemCount = members.length || steps.length;
  const activeCount = members.length
    ? members.filter((item) => !['completed', 'failed', 'cancelled', 'idle'].includes(item.status)).length
    : steps.filter((item) => !['completed', 'failed', 'cancelled', 'idle'].includes(item.status)).length;
  const parts = [];
  if (elapsed) parts.push({ key: 'elapsed', text: `${t('workflow.elapsedLabel')}: ${elapsed}` });
  if (itemCount > 0) {
    parts.push({ key: 'active', text: `${activeCount}/${itemCount} ${t('workflow.activeShort')}` });
  } else if (hasGoal) {
    // Goal-only: compact progress, not fake member counts.
    const percent = status.progress?.percent;
    if (Number.isFinite(percent)) {
      parts.push({ key: 'goal', text: t('workflow.activityGoalPercent', { percent: Math.round(percent) }) });
    } else {
      parts.push({ key: 'goal', text: t('workflow.activityGoal') });
    }
  }
  if (totalTokens) parts.push({ key: 'tokens', text: `${totalTokens.toLocaleString()} ${t('workflow.tokens')}` });
  if (status.toolCallCount) {
    parts.push({ key: 'tools', text: `${status.toolCallCount} ${t('workflow.tools')}` });
  }
  return parts;
}

export default function WorkflowRightPanel({ payload = null }) {
  const t = useTranslate();
  const activeThreadId = useStore((state) => state.activeThreadId);
  const threadId = payload?.threadId || activeThreadId;
  const runtime = useStore((state) => state.threadRuntimeById?.[threadId] || (threadId === state.activeThreadId ? state : null) || {});
  const thread = useStore((state) => state.threadsById?.[threadId]);
  const timeline = useMemo(() => resolveThreadTimeline(runtime.timeline, thread?.timeline), [runtime.timeline, thread?.timeline]);
  const view = useMemo(
    () => deriveWorkflowView({ runtime, threadStatus: thread?.status || 'idle', timeline }),
    [runtime, thread?.status, timeline],
  );
  const status = view;
  const goalState = useMemo(() => runtime.goalState || runtime.lastGoalState || goalsFromTimeline(timeline), [runtime.goalState, runtime.lastGoalState, timeline]);
  const goals = goalList(goalState);
  const goal = currentGoal(goalState);
  const goalModeWaiting = Boolean(goalState?.mode === 'goal' && !goal);
  const startedAt = status.startedAt;
  const elapsed = startedAt ? formatElapsed(status.active ? Date.now() - startedAt : status.durationMs, t) : '';
  const memberHistories = runtime.memberHistoriesByName || {};
  // Only real team/subagent members. Never promote synthetic goal steps (or tools) into "子代理".
  const members = Array.isArray(status.members) ? status.members : [];
  const reports = runtime.subagentReports || runtime.lastSubagentReports || collectSubagentReports({
    timeline,
    teamState: runtime.teamState,
    lastTeamState: runtime.lastTeamState,
    memberHistoriesByName: runtime.memberHistoriesByName,
    subagentToolCalls: runtime.subagentToolCalls,
  });
  const totalTokens = Number(status.tokenTotals?.inputTokens || 0) + Number(status.tokenTotals?.outputTokens || 0);
  const stats = overviewStats({ status, elapsed, totalTokens, t, hasGoal: Boolean(goal || goalModeWaiting) });
  // Overview is session chrome (elapsed/status). Goal title lives only in GoalCard;
  // members live only in the members section — never reuse goal text as a fake agent.
  const overviewTitle = status.teamName || t('workflow.title');

  // Empty-first + orchestration-only: tools-only turns render empty (process stays in chat).
  const empty = (Boolean(view.empty) || Boolean(view.toolsOnly)) && !goal && !goalModeWaiting && !members.length && !reports.length;
  const phaseLabel = (() => {
    if (!view.showPhase || !status.phase) return '';
    // Goal-only runs often carry a generic phase that just restates "running".
    if ((goal || goalModeWaiting) && !members.length && !status.teamName) return '';
    const key = `workflow.phase.${status.phase}`;
    const label = t(key);
    return label && label !== key ? label : t('workflow.phase.unknown');
  })();

  return (
    <div className="workflow-right-panel" data-testid="workflow-right-panel" data-workflow-kind={view.kind} data-tools-only={view.toolsOnly ? 'true' : 'false'}>
      <div className="workflow-right-panel__body">
        {empty ? (
          <section className="workflow-right-panel__section workflow-right-panel__empty" data-testid="workflow-empty-state">
            <div>{t('workflow.empty')}</div>
            <div className="workflow-right-panel__muted" style={{ marginTop: 6 }}>{t('workflow.emptyHint')}</div>
          </section>
        ) : (
          <>
        <section className="workflow-right-panel__section workflow-right-panel__overview">
          <div className="workflow-right-panel__overview-title">
            <ListTree size={15} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{overviewTitle}</span>
            {view.showStatus ? (
              <span className="workflow-right-panel__status" style={{ color: statusColor(status.status) }}>{statusText(status.status, t)}</span>
            ) : null}
          </div>
          {phaseLabel ? <div className="workflow-right-panel__summary">{phaseLabel}</div> : null}
          {stats.length ? (
            <div className="workflow-right-panel__stats">
              {stats.map((part) => <span key={part.key}>{part.text}</span>)}
            </div>
          ) : null}
          {status.progress?.percent != null && members.length > 0 ? (
            <div className="workflow-right-panel__progress">
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${status.progress.percent}%` }} /></div>
              <span>{progressText(status.progress, t)}</span>
            </div>
          ) : null}
          {status.capabilityMessage === 'aggregate-only' ? <div className="workflow-right-panel__muted">{t('workflow.aggregateOnly')}</div> : null}
        </section>

        <GoalCard goal={goal} t={t} waitingOnly={goalModeWaiting} />

        {members.length ? (
          <section className="workflow-right-panel__section" data-testid="workflow-members">
            <div className="workflow-right-panel__section-title">
              <span>{t('workflow.members')}</span>
              <span className="workflow-right-panel__count">{members.length}</span>
            </div>
            <div className="workflow-right-panel__members">
              {members.map((member) => <MemberRow key={member.id} member={member} history={memberHistories[member.name]} t={t} />)}
            </div>
          </section>
        ) : goal || goalModeWaiting || reports.length ? null : (
          <section className="workflow-right-panel__section workflow-right-panel__empty">
            {t('workflow.waitingForSteps')}
          </section>
        )}

        {reports.length ? (
          <section className="workflow-right-panel__section" data-testid="workflow-subagent-reports">
            <div className="workflow-right-panel__section-title">
              <span>{t('subagent.report')}</span>
              <span className="workflow-right-panel__count">{reports.length}</span>
            </div>
            <div className="workflow-right-panel__report-list">
              {reports.map((report) => (
                <div className="workflow-right-panel__report" key={report.id}>
                  <div className="workflow-right-panel__report-title">
                    <span className="workflow-right-panel__member-name" title={report.name}>{report.name || report.role}</span>
                    <span className="workflow-right-panel__status">{t(`subagent.status.${report.status}`) || report.status}</span>
                  </div>
                  <div className="workflow-right-panel__muted">{t('subagent.role')}: {report.role || t('subagent.unknownRole')}</div>
                  <div className="workflow-right-panel__muted" title={report.agentId}>{t('subagent.agentId')}: {report.agentId}</div>
                  <div className="workflow-right-panel__muted">{t('subagent.toolCount')}: {report.toolCallCount}</div>
                  {report.conclusionKind === 'path_list' && report.pathList ? (
                    <div className="workflow-right-panel__report-conclusion" data-testid="panel-path-list">
                      {t('tool.pathListCount', { count: report.pathList.count })}
                      <ul className="m-0 mt-1 list-none space-y-0.5 p-0">
                        {(report.pathList.preview || []).map((p) => (
                          <li key={p} className="truncate text-[11px]" title={p}>{String(p).split(/[/\\]/).pop()}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="workflow-right-panel__report-conclusion line-clamp-4" title={report.conclusion || report.summary}>
                      {report.conclusion || report.summary || t('subagent.noConclusion')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {goals.length > 0 ? <GoalLog timeline={timeline} t={t} /> : null}
        {status.status === 'failed' ? (
          <div className="workflow-right-panel__notice workflow-right-panel__notice--error"><CircleAlert size={14} aria-hidden="true" />{t('workflow.failedNotice')}</div>
        ) : null}
          </>
        )}
      </div>
    </div>
  );
}
