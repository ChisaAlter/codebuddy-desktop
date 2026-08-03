import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const cssPath = path.resolve(process.cwd(), 'src/index.css');
const hostPath = path.resolve(process.cwd(), 'src/components/RightPanelHost.jsx');
const floatingPath = path.resolve(process.cwd(), 'src/components/WorkflowFloatingPanelHost.jsx');

describe('panel layout contracts', () => {
  it('keeps animated right and workflow hosts separate', () => {
    const css = fs.readFileSync(cssPath, 'utf8');
    const host = fs.readFileSync(hostPath, 'utf8');
    const floating = fs.readFileSync(floatingPath, 'utf8');
    expect(host).toContain('data-panel-phase');
    expect(host).not.toContain('WorkflowRightPanel');
    expect(floating).toContain('workflow-floating-panel-host');
    expect(css).toContain('.workflow-floating-panel-host');
    expect(css).toContain('.right-panel-host.is-closing');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
