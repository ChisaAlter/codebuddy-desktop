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
      // 每次打开都显式经过 'opening' 相位：host 常驻挂载时，仅靠 useState 初值
      // 会让后续打开永远跳过 'opening'，导致 M4 的初始焦点/焦点返回效果失效。
      setPhase('opening');
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
