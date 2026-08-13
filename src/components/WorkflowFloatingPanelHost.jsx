import React, { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { usePanelT } from '../lib/use-panel-t';
import { WorkflowFloatingPanelBody } from './WorkflowFloatingPanelSections';
import { PanelHeader } from './RightPanelHost';
import { usePanelTransition } from './usePanelTransition';

export default function WorkflowFloatingPanelHost() {
  const panel = useStore((state) => state.workflowFloatingPanel);
  const rightPanel = useStore((state) => state.rightPanel);
  const closeWorkflowPanel = useStore((state) => state.closeWorkflowPanel);
  const t = usePanelT();
  const transitioned = usePanelTransition(panel);
  const closeButtonRef = useRef(null);
  const returnFocusRef = useRef(null);

  useEffect(() => {
    if (!transitioned.value) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeWorkflowPanel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closeWorkflowPanel, transitioned.value]);

  // M4 焦点管理：打开时初始焦点 → 关闭按钮；关闭后焦点返回触发打开的元素（若仍可聚焦）
  useEffect(() => {
    if (transitioned.phase === 'opening' && transitioned.value) {
      returnFocusRef.current = document.activeElement;
      closeButtonRef.current?.focus?.();
    }
  }, [transitioned.phase, transitioned.value]);

  useEffect(() => {
    if (transitioned.phase === 'closed' && !transitioned.value) {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target && typeof target.focus === 'function' && target.isConnected) {
        target.focus();
      }
    }
  }, [transitioned.phase, transitioned.value]);

  if (!transitioned.value) return null;
  const current = transitioned.value;
  return (
    <aside
      className={`workflow-floating-panel-host is-${transitioned.phase}${rightPanel ? ' has-right-panel' : ''}`}
      data-testid="workflow-floating-panel"
      data-panel-phase={transitioned.phase}
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-floating-panel-title"
    >
      <PanelHeader
        title={<span id="workflow-floating-panel-title">{t('workflow.panelTitle')}</span>}
        onClose={closeWorkflowPanel}
        closeAriaLabel={t('workflow.panelClose')}
        closeTitle={t('workflow.panelClose')}
        closeRef={closeButtonRef}
      />
      <WorkflowFloatingPanelBody threadId={current.payload?.threadId} />
    </aside>
  );
}
