// G5: Agent Home（WebUI 2.138 /api/v1/agent-home）——智能体名册 / 房间(分组) / 频道 + @提及消息。
// WebUI 用 SSE 订阅频道事件；Desktop 沿用视图内轮询（与实例列表/后台任务一致）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Hash, Users, Plus, Trash2, RefreshCw, Send, AtSign } from 'lucide-react';
import { useStore } from '../store';
import { useViewActive } from '../lib/use-view-active';
import { resolveLocaleMode, translate } from '../lib/i18n';
import {
  HOME_MAX_MEMBERS,
  fetchAgentHomeSnapshot,
  createHomeAgent,
  updateHomeAgent,
  deleteHomeAgent,
  createHomeRoom,
  deleteHomeRoom,
  createHomeChannel,
  updateHomeChannel,
  deleteHomeChannel,
  fetchChannelMessages,
  sendChannelMessage,
  extractMentionAgentIds,
} from '../lib/agent-home-api';
import { formatHistoryRelativeTime } from '../lib/session-history';
import { requestSettingsSection } from '../lib/settings-nav';

const EMPTY_SNAPSHOT = {
  enabled: null,
  defaultAgentId: null,
  agents: [],
  rooms: [],
  channels: [],
  sections: [],
  jobAssignments: {},
};

export default function ReplicaAgentHomeView() {
  const active = useViewActive('agent-home');
  const localeMode = useStore((s) => s.guiSettings?.locale || 'system');
  const locale = resolveLocaleMode(localeMode);
  const t = useCallback((key, vars) => translate(locale, key, vars), [locale]);
  const setRoute = useStore((s) => s.setRoute);

  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const requestRef = useRef(0);
  const messagesEndRef = useRef(null);

  const agentsById = useMemo(() => {
    const map = new Map();
    for (const agent of snapshot.agents) map.set(agent.id, agent);
    return map;
  }, [snapshot.agents]);

  const agentName = useCallback(
    (agentId) => agentsById.get(agentId)?.name || t('agentHome.unknownAgent'),
    [agentsById, t],
  );

  const refresh = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++requestRef.current;
    if (!silent) {
      setLoading(true);
      setLoadError('');
    }
    try {
      const data = await fetchAgentHomeSnapshot();
      if (requestId !== requestRef.current) return;
      setSnapshot(data);
      setLoadError('');
      setSelectedChannelId((current) =>
        current && data.channels.some((channel) => channel.id === current) ? current : data.channels[0]?.id ?? null,
      );
    } catch (error) {
      if (requestId === requestRef.current) setLoadError(error?.message || String(error));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh({ silent: true }), 15_000);
    return () => {
      requestRef.current += 1;
      clearInterval(timer);
    };
  }, [active, refresh]);

  const loadMessages = useCallback(
    async (channelId, { silent = false } = {}) => {
      if (!channelId) {
        setMessages([]);
        return;
      }
      if (!silent) setMessagesLoading(true);
      try {
        const list = await fetchChannelMessages(channelId);
        setMessages(list);
      } catch (error) {
        if (!silent) setActionError(error?.message || String(error));
      } finally {
        if (!silent) setMessagesLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!active || !selectedChannelId) {
      setMessages([]);
      return undefined;
    }
    void loadMessages(selectedChannelId);
    const timer = setInterval(() => void loadMessages(selectedChannelId, { silent: true }), 5_000);
    return () => clearInterval(timer);
  }, [active, selectedChannelId, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const runAction = useCallback(
    async (action) => {
      if (busy) return false;
      setBusy(true);
      setActionError('');
      try {
        await action();
        await refresh({ silent: true });
        return true;
      } catch (error) {
        setActionError(error?.message || t('agentHome.opFailed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, t],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !selectedChannelId || sending) return;
    setSending(true);
    setActionError('');
    try {
      const mentionAgentIds = extractMentionAgentIds(text, snapshot.agents);
      await sendChannelMessage(selectedChannelId, { text, mentionAgentIds });
      setDraft('');
      await loadMessages(selectedChannelId, { silent: true });
    } catch (error) {
      setActionError(error?.message || t('agentHome.sendFailed'));
    } finally {
      setSending(false);
    }
  }, [draft, selectedChannelId, sending, snapshot.agents, loadMessages, t]);

  const selectedChannel = snapshot.channels.find((channel) => channel.id === selectedChannelId) || null;
  const memberIds = Array.isArray(selectedChannel?.memberAgentIds) ? selectedChannel.memberAgentIds : [];
  const addableAgents = snapshot.agents.filter(
    (agent) => agent.id !== snapshot.defaultAgentId && !memberIds.includes(agent.id),
  );

  // mainAgent 未开启：引导去设置页开启（G1 的 codebuddy.mainAgent.enabled）。
  if (snapshot.enabled === false && !loading) {
    return (
      <div className="page-shell">
        <div className="page-header">
          <div>
            <h2 className="page-header-title">{t('agentHome.title')}</h2>
            <div className="page-header-desc">{t('agentHome.subtitle')}</div>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="max-w-md text-center">
            <Bot size={32} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
            <div className="text-sm text-[var(--color-text-primary)]">{t('agentHome.disabled')}</div>
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">{t('agentHome.disabledHint')}</div>
            <button
              type="button"
              className="btn-primary mt-4 px-3 py-1.5 text-xs"
              onClick={() => {
                requestSettingsSection('settings-section-settings-group-mainAgent');
                setRoute('settings');
              }}
            >
              {t('agentHome.openSettings')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell" data-testid="agent-home">
      <div className="page-header">
        <div>
          <h2 className="page-header-title">{t('agentHome.title')}</h2>
          <div className="page-header-desc">{t('agentHome.subtitle')}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() =>
              void runAction(async () => {
                await createHomeAgent({});
              })
            }
          >
            <Plus size={12} className="mr-1 inline-block" />
            {t('agentHome.newAgent')}
          </button>
          <button className="btn-ghost px-3 py-1.5 text-xs" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw size={12} className={`mr-1 inline-block ${loading ? 'animate-spin' : ''}`} />
            {t('agentHome.refresh')}
          </button>
        </div>
      </div>

      {loadError ? (
        <div className="mx-4 mb-2 flex items-center justify-between rounded-md border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-xs text-[var(--color-accent-red)]">
          <span>{loadError}</span>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void refresh()}>
            {t('agentHome.retry')}
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="mx-4 mb-2 rounded-md border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-xs text-[var(--color-accent-red)]">
          {actionError}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* 左栏：名册 / 房间 / 频道 */}
        <aside className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[var(--color-border-default)] p-3">
          <section>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              <Bot size={12} />
              <span>{t('agentHome.agents')}</span>
            </div>
            {snapshot.agents.length === 0 ? (
              <div className="px-1 text-xs text-[var(--color-text-muted)]">{t('agentHome.noAgents')}</div>
            ) : (
              <div className="space-y-0.5">
                {snapshot.agents.map((agent) => (
                  <div key={agent.id} className="group flex items-center gap-2 rounded px-1.5 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
                    <span className="min-w-0 flex-1 truncate">
                      {agent.name || t('agentHome.defaultName')}
                      {agent.id === snapshot.defaultAgentId ? (
                        <span className="ml-1 text-[10px] text-[var(--color-accent-blue)]">{t('agentHome.main')}</span>
                      ) : null}
                    </span>
                    {agent.id !== snapshot.defaultAgentId ? (
                      <button
                        type="button"
                        className="hidden shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent-red)] group-hover:block"
                        title={t('agentHome.deleteAgent')}
                        aria-label={t('agentHome.deleteAgent')}
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(t('agentHome.delete.confirm'))) {
                            void runAction(() => deleteHomeAgent(agent.id));
                          }
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              <Users size={12} />
              <span>{t('agentHome.rooms')}</span>
            </div>
            {snapshot.rooms.length === 0 ? (
              <div className="px-1 text-xs text-[var(--color-text-muted)]">{t('agentHome.noRooms')}</div>
            ) : (
              <div className="space-y-0.5">
                {snapshot.rooms.map((room) => (
                  <div key={room.id} className="group rounded px-1.5 py-1 text-sm hover:bg-[var(--color-bg-hover)]">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
                        {room.name || t('agentHome.roomFallback')}
                      </span>
                      <button
                        type="button"
                        className="hidden shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent-red)] group-hover:block"
                        title={t('agentHome.room.delete')}
                        aria-label={t('agentHome.room.delete')}
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(t('agentHome.room.deleteConfirm'))) {
                            void runAction(() => deleteHomeRoom(room.id));
                          }
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="truncate text-[11px] text-[var(--color-text-muted)]">
                      {room.memberAgentIds.map((id) => agentName(id)).join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {snapshot.agents.filter((agent) => agent.id !== snapshot.defaultAgentId).length >= 2 ? (
              <button
                type="button"
                className="mt-1 w-full rounded border border-dashed border-[var(--color-border-muted)] px-2 py-1 text-left text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
                disabled={busy}
                onClick={() => {
                  const members = snapshot.agents
                    .filter((agent) => agent.id !== snapshot.defaultAgentId)
                    .slice(0, 2)
                    .map((agent) => agent.id);
                  void runAction(() => createHomeRoom({ memberAgentIds: members }));
                }}
              >
                <Plus size={11} className="mr-1 inline-block" />
                {t('agentHome.room.createConfirm')}
              </button>
            ) : null}
          </section>

          <section>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              <Hash size={12} />
              <span>{t('agentHome.channels')}</span>
            </div>
            {snapshot.channels.length === 0 ? (
              <div className="px-1 text-xs text-[var(--color-text-muted)]">{t('agentHome.noChannels')}</div>
            ) : (
              <div className="space-y-0.5">
                {snapshot.channels.map((channel) => (
                  <div key={channel.id} className="group flex items-center gap-2">
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-sm ${
                        channel.id === selectedChannelId
                          ? 'bg-[var(--color-bg-hover)] text-[var(--color-text-primary)]'
                          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                      }`}
                      onClick={() => setSelectedChannelId(channel.id)}
                    >
                      #{channel.name || channel.id}
                    </button>
                    <button
                      type="button"
                      className="hidden shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent-red)] group-hover:block"
                      title={t('agentHome.channel.delete')}
                      aria-label={t('agentHome.channel.delete')}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t('agentHome.channel.deleteConfirm'))) {
                          void runAction(async () => {
                            await deleteHomeChannel(channel.id);
                            if (selectedChannelId === channel.id) setSelectedChannelId(null);
                          });
                        }
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="mt-1 w-full rounded border border-dashed border-[var(--color-border-muted)] px-2 py-1 text-left text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
              disabled={busy}
              onClick={() => {
                const name = window.prompt(t('agentHome.channel.namePrompt'));
                if (!name || !name.trim()) return;
                void runAction(async () => {
                  const channel = await createHomeChannel({ name: name.trim() });
                  if (channel?.id) setSelectedChannelId(channel.id);
                });
              }}
            >
              <Plus size={11} className="mr-1 inline-block" />
              {t('agentHome.channel.create')}
            </button>
          </section>
        </aside>

        {/* 右栏：频道消息 + @提及 composer */}
        <main className="flex min-w-0 flex-1 flex-col">
          {!selectedChannel ? (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">
              {t('agentHome.selectChannel')}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] px-4 py-2">
                <Hash size={14} className="text-[var(--color-text-muted)]" />
                <span className="text-sm font-medium text-[var(--color-text-primary)]">{selectedChannel.name || selectedChannel.id}</span>
                <div className="ml-2 flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  {memberIds.map((memberId) => (
                    <span
                      key={memberId}
                      className="group inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-hover)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]"
                    >
                      {agentName(memberId)}
                      <button
                        type="button"
                        className="text-[var(--color-text-muted)] hover:text-[var(--color-accent-red)]"
                        title={t('agentHome.member.remove')}
                        aria-label={t('agentHome.member.remove')}
                        disabled={busy}
                        onClick={() =>
                          void runAction(() =>
                            updateHomeChannel(selectedChannel.id, {
                              memberAgentIds: memberIds.filter((id) => id !== memberId),
                            }),
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {addableAgents.length > 0 && memberIds.length < HOME_MAX_MEMBERS ? (
                    <select
                      value=""
                      disabled={busy}
                      className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-1 py-0.5 text-[11px] text-[var(--color-text-muted)]"
                      onChange={(event) => {
                        const agentId = event.target.value;
                        if (!agentId) return;
                        void runAction(() =>
                          updateHomeChannel(selectedChannel.id, { memberAgentIds: [...memberIds, agentId] }),
                        );
                      }}
                    >
                      <option value="">{t('agentHome.member.add')}</option>
                      {addableAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name || t('agentHome.defaultName')}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-3">
                {messagesLoading && messages.length === 0 ? (
                  <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">{t('agentHome.loading')}</div>
                ) : messages.length === 0 ? (
                  <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">{t('agentHome.noMessages')}</div>
                ) : (
                  <div className="space-y-3">
                    {messages.map((message) => (
                      <div key={message.id} className={`flex ${message.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                            message.from === 'user'
                              ? 'bg-[var(--color-accent-blue)]/15 text-[var(--color-text-primary)]'
                              : 'bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]'
                          }`}
                        >
                          <div className="mb-0.5 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                            <span>{message.from === 'user' ? t('agentHome.you') : agentName(message.agentId)}</span>
                            <span>{formatHistoryRelativeTime(message.at, locale)}</span>
                          </div>
                          <div className="whitespace-pre-wrap break-words">{message.text}</div>
                          {message.mentionAgentIds?.length ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {message.mentionAgentIds.map((id) => (
                                <span key={id} className="inline-flex items-center gap-0.5 rounded bg-[var(--color-bg-primary)] px-1 text-[10px] text-[var(--color-accent-blue)]">
                                  <AtSign size={9} />
                                  {agentName(id)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--color-border-default)] p-3">
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    rows={2}
                    placeholder={t('agentHome.composerPlaceholder')}
                    className="min-w-0 flex-1 resize-none rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
                  />
                  <button
                    type="button"
                    className="btn-primary flex items-center gap-1 px-3 py-2 text-xs disabled:opacity-50"
                    disabled={sending || !draft.trim()}
                    onClick={() => void send()}
                  >
                    <Send size={12} />
                    {sending ? t('agentHome.sending') : t('agentHome.send')}
                  </button>
                </div>
                <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{t('agentHome.mentionHint')}</div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
