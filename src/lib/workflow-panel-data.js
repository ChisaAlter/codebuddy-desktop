// M2 面板数据归属：终态回退（新回合未产生数据时回退 lastGoalState / lastSubagentReports）
// 契约：docs/workflow/specs/2026-08-06-workflow-panel-payload-contract.md §1

/**
 * 面板目标状态源：优先实时 goalState，回退 lastGoalState。
 */
export function getPanelGoalState(runtime) {
  return runtime?.goalState || runtime?.lastGoalState || null;
}

/**
 * 面板目标列表（按 goalsById 的 value 展开）。
 */
export function getPanelGoals(runtime) {
  const state = getPanelGoalState(runtime);
  return state?.goalsById ? Object.values(state.goalsById) : [];
}

function workflowAgentReports(workflowState) {
  const agents = workflowState?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.map((agent, index) => {
    const phase = agent?.phase;
    const phaseLabel = typeof phase === 'string' ? phase : phase?.title || phase?.name || '';
    return {
      ...agent,
      id: agent?.id || agent?.key || `workflow-agent-${index + 1}`,
      name: agent?.name || agent?.label || agent?.key || `Agent ${index + 1}`,
      description: agent?.description || phaseLabel,
      summary: agent?.summary || agent?.error || phaseLabel,
      toolCallCount: Number(agent?.toolCallCount || 0),
    };
  });
}

/**
 * 面板子代理报告源：优先实时 subagentReports（非空），
 * 空数组（新回合清理后）或缺失时回退 lastSubagentReports（历史）。
 */
export function getPanelReports(runtime) {
  if (Array.isArray(runtime?.subagentReports) && runtime.subagentReports.length > 0) {
    return runtime.subagentReports;
  }
  const workflowAgents = workflowAgentReports(runtime?.workflowState);
  if (workflowAgents.length > 0) return workflowAgents;
  if (Array.isArray(runtime?.lastSubagentReports) && runtime.lastSubagentReports.length > 0) {
    return runtime.lastSubagentReports;
  }
  return workflowAgentReports(runtime?.lastWorkflowState);
}

/**
 * 是否处于「历史回退」展示（无实时 goalState 但有上一轮终态）。
 */
export function isWorkflowHistory(runtime) {
  return !runtime?.goalState && Boolean(runtime?.lastGoalState);
}
