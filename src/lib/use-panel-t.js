import { useCallback } from 'react';
import { useStore } from '../store';
import { resolveLocaleMode, translate } from './i18n';

/**
 * M4/M5: panel i18n — follows the app locale setting; languagechange is driven
 * by App.jsx. Shared by the floating panel host and sections so the translation
 * contract cannot drift between the two components.
 */
export function usePanelT() {
  const localeMode = useStore((state) => state.guiSettings?.locale || 'system');
  return useCallback((key, vars) => translate(resolveLocaleMode(localeMode), key, vars), [localeMode]);
}
