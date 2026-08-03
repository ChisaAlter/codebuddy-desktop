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
 */
export function hasUsableGoalTurn(timeline, promptEntryId, promptStartedAt, goalState = null) {
  if (goalState && typeof goalState === 'object') {
    const goals = goalState.goalsById && typeof goalState.goalsById === 'object' ? goalState.goalsById : {};
    if (Object.keys(goals).length > 0) return true;
    if (Number(goalState.eventCount || 0) > 0) return true;
  }
  const turnEntries = promptTurnEntries(timeline, promptEntryId, promptStartedAt);
  if (!turnEntries) return false;
  return turnEntries.some((item) => item?.type === 'goal-progress' || item?.type === 'goal-status');
}
