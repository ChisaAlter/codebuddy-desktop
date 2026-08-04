import { useStore } from '../store';

/**
 * M-perf (keep-alive): views stay mounted after first visit (App.jsx MainContent
 * hides them with display:none), so per-view polling and global listeners must
 * know whether their route is actually visible. Returns true only while the
 * given route is the active one.
 */
export function useViewActive(routeId) {
  return useStore((state) => state.route === routeId);
}
