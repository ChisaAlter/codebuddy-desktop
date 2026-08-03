import React, { useEffect } from 'react';
import { useStore } from '../store';
import WorkflowRightPanel from './WorkflowRightPanel';
import { PanelHeader } from './RightPanelHost';
import { usePanelTransition } from './usePanelTransition';

export default function WorkflowFloatingPanelHost() {
  const panel = useStore((state) => state.workflowFloatingPanel);
  const rightPanel = useStore((state) => state.rightPanel);
  const closeWorkflowPanel = useStore((state) => state.closeWorkflowPanel);
  const transitioned = usePanelTransition(panel);

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

  if (!transitioned.value) return null;
  const current = transitioned.value;
  return (
    <aside
      className={`workflow-floating-panel-host is-${transitioned.phase}${rightPanel ? ' has-right-panel' : ''}`}
      data-testid="workflow-floating-panel"
      data-panel-phase={transitioned.phase}
      role="dialog"
      aria-label="工作流与子代理"
      aria-live="polite"
    >
      <PanelHeader title="工作流与子代理" onClose={closeWorkflowPanel} />
      <WorkflowRightPanel payload={current.payload} />
    </aside>
  );
}
