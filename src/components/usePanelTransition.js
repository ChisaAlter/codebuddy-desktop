import { useEffect, useRef, useState } from 'react';

export const PANEL_TRANSITION_MS = 220;

export function usePanelTransition(value, duration = PANEL_TRANSITION_MS) {
  const [mountedValue, setMountedValue] = useState(value);
  const [phase, setPhase] = useState(value ? 'opening' : 'closed');
  const timerRef = useRef(null);

  useEffect(() => {
    if (value) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setMountedValue(value);
      const frame = requestAnimationFrame(() => setPhase('open'));
      return () => cancelAnimationFrame(frame);
    }
    if (!mountedValue) {
      setPhase('closed');
      return undefined;
    }
    setPhase('closing');
    timerRef.current = setTimeout(() => {
      setMountedValue(null);
      setPhase('closed');
      timerRef.current = null;
    }, duration);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [duration, mountedValue, value]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { value: mountedValue, phase };
}
