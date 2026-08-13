export const ROUTES = [
  'chat',
  'instances',
  'remote-control',
  'terminal',
  'tasks',
  'archived',
  'plugins',
  'skills',
  'agents',
  'mcp',
  'sandboxes',
  'editor',
  'changes',
  'stats',
  'traces',
  'monitor',
  'metrics',
  'logs',
  'workers',
  'docs',
  'keybindings',
  'models',
  'settings',
];

export function parseHashRoute() {
  const raw = (window.location.hash || '#/chat').replace(/^#\/?/, '');
  const [route] = raw.split('?');
  return ROUTES.includes(route) ? route : 'chat';
}

export function setHashRoute(route) {
  const safe = ROUTES.includes(route) ? route : 'chat';
  if (window.location.hash !== `#/${safe}`) {
    window.location.hash = `#/${safe}`;
  }
}
