import { AcpClient } from './acp';

const FORWARDED_EVENTS = [
  'connected',
  'reconnecting',
  'reconnected',
  'reconnect_failed',
  'initialized',
  'session/update',
  'interruption_request',
  'question_request',
  'interaction_requests_invalidated',
  'message',
  'thinking',
  'model_update',
  'mode_update',
  'current_mode_update',
  'status_change',
  'promptSuggestion',
  'teamUpdate',
  '_codebuddy.ai/artifact',
  '_codebuddy.ai/authUrl',
  'checkpoint',
];

export class ConversationManager {
  constructor() {
    this.entries = new Map();
    this.eventTarget = new EventTarget();
  }

  onEvent(listener) {
    const handler = (event) => listener(event.detail);
    this.eventTarget.addEventListener('conversation-event', handler);
    return () => this.eventTarget.removeEventListener('conversation-event', handler);
  }

  emit(detail) {
    this.eventTarget.dispatchEvent(new CustomEvent('conversation-event', { detail }));
  }

  getClient(threadId, apiBase) {
    if (!threadId) throw new Error('threadId is required');
    let entry = this.entries.get(threadId);
    if (entry && entry.apiBase !== apiBase) {
      // M-ls10: dispose is async (it awaits client.disconnect). Capture the old
      // entry and trigger its disposal, but don't await here (getClient is sync).
      // The dispose below only deletes the map entry when it still points at the
      // SAME entry, so a freshly-created entry below is never torn down by the
      // in-flight old dispose.
      this.dispose(threadId);
      entry = null;
    }
    if (entry) return entry.client;

    const client = new AcpClient({ apiBase });
    const disposers = FORWARDED_EVENTS.map((type) => client.on(type, (event) => {
      this.emit({ threadId, type, detail: event.detail });
    }));
    this.entries.set(threadId, { apiBase, client, disposers });
    return client;
  }

  peek(threadId) {
    return this.entries.get(threadId)?.client || null;
  }

  async dispose(threadId) {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    // M-ls10: only delete the map entry if it still points at THIS entry. A
    // concurrent getClient(threadId, newApiBase) may have already replaced it
    // with a fresh client while this old disconnect is in flight; deleting the
    // new entry would leak a live WS connection and lose the new client. Also
    // capture the entry so the disconnect/disposers run against the right client.
    if (this.entries.get(threadId) === entry) this.entries.delete(threadId);
    entry.client.invalidateInteractiveRequests('client-disposed');
    for (const dispose of entry.disposers) dispose();
    await entry.client.disconnect().catch(() => null);
  }

  async disposeProject(threadIds) {
    await Promise.allSettled((threadIds || []).map((threadId) => this.dispose(threadId)));
  }

  async disposeAll() {
    await Promise.allSettled(Array.from(this.entries.keys(), (threadId) => this.dispose(threadId)));
  }
}
