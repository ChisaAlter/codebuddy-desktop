export function promptTurnEntries(timeline, promptEntryId, promptStartedAt) {
  const entries = Array.isArray(timeline) ? timeline : [];
  let promptIndex = entries.findIndex((item) => item.id === promptEntryId);
  if (promptIndex < 0) {
    promptIndex = entries.findIndex(
      (item) => item.type === 'message' && item.role === 'user' && item.createdAt >= promptStartedAt,
    );
  }
  return promptIndex < 0 ? null : entries.slice(promptIndex + 1);
}

export function hasCompletePromptResponse(timeline, promptEntryId, promptStartedAt) {
  const turnEntries = promptTurnEntries(timeline, promptEntryId, promptStartedAt);
  if (!turnEntries) return false;
  let lastExecutionIndex = -1;
  for (let index = 0; index < turnEntries.length; index += 1) {
    if (turnEntries[index]?.type === 'tool_call') lastExecutionIndex = index;
  }
  return turnEntries.some(
    (item, index) =>
      index > lastExecutionIndex &&
      item?.type === 'message' &&
      item?.role === 'assistant' &&
      String(item.content || '').trim().length > 0,
  );
}

/**
 * Non-empty assistant text anywhere in this turn (including text before tools).
 * Used as a soft success path when the model ends after tools without a post-tool
 * summary, so the user keeps the already-visible body instead of a hard error banner.
 */
export function hasUsableAssistantBody(timeline, promptEntryId, promptStartedAt) {
  const turnEntries = promptTurnEntries(timeline, promptEntryId, promptStartedAt);
  if (!turnEntries) return false;
  return turnEntries.some(
    (item) =>
      item?.type === 'message' &&
      item?.role === 'assistant' &&
      String(item.content || '').trim().length > 0,
  );
}

export function hasPromptRunActivity(timeline, promptEntryId, promptStartedAt) {
  const turnEntries = promptTurnEntries(timeline, promptEntryId, promptStartedAt);
  if (!turnEntries) return false;
  return turnEntries.some((item) => {
    if (item?.type === 'message' && item?.role === 'assistant') return true;
    return ['thinking', 'tool_call', 'interruption', 'question', 'goal-progress', 'goal-status'].includes(item?.type);
  });
}

/**
 * `/goal` turns may finish with only private goal metadata (no assistant text).
 * Treat non-empty goal projection or goal timeline events as a usable completion.
 *
 * The optimistic seed (seedGoalStateFromPrompt's `local-seed`, `seeded: true`) is
 * a UI projection, NOT evidence of CLI progress: it is written the moment the
 * prompt is dispatched, so counting it here would report a `/goal` turn as
 * successful even when the CLI silently produced nothing. Only entries without
 * the `seeded` flag (real CLI events) or an eventCount beyond the seed's own
 * count (seed event occupies exactly 1) count as usable.
 */
export function hasUsableGoalTurn(timeline, promptEntryId, promptStartedAt, goalState = null) {
  if (goalState && typeof goalState === 'object') {
    const goals = goalState.goalsById && typeof goalState.goalsById === 'object' ? goalState.goalsById : {};
    const hasRealGoalEntry = Object.values(goals).some((goal) => goal && !goal.seeded);
    if (hasRealGoalEntry) return true;
    // Seed accounts for exactly one eventCount unit; >1 means real CLI events
    // arrived (covers the edge case where a real event reuses the `local-seed`
    // goalId, which keeps the `seeded` flag through mergeGoalEvent's spread).
    if (Number(goalState.eventCount || 0) > 1) return true;
  }
  const turnEntries = promptTurnEntries(timeline, promptEntryId, promptStartedAt);
  if (!turnEntries) return false;
  return turnEntries.some((item) => item?.type === 'goal-progress' || item?.type === 'goal-status');
}

/**
 * Team/goal orchestration may finish with member conclusions only (no leader prose).
 * tools-only turns must NOT use this path.
 */
export function hasUsableMemberConclusions(memberHistoriesByName = {}) {
  const histories =
    memberHistoriesByName && typeof memberHistoriesByName === 'object' ? Object.values(memberHistoriesByName) : [];
  for (const history of histories) {
    if (!Array.isArray(history)) continue;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const item = history[i];
      if (item?.type === 'message' && item?.role === 'assistant' && String(item.content || '').trim()) {
        return true;
      }
    }
  }
  return false;
}
