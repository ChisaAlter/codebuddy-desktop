import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  replicaSidebarFooterItems,
  replicaSidebarGroupForRoute,
  replicaSidebarGroupInitiallyExpanded,
  replicaSidebarMainGroups,
  replicaSidebarWidthStyle,
} from '../../src/components/ReplicaSidebar';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('ReplicaSidebar layout', () => {
  it('lets the application shell follow the resized window instead of pinning the initial viewport width', () => {
    const appSource = fs.readFileSync(path.join(testRoot, 'src', 'App.jsx'), 'utf8');
    const cssSource = fs.readFileSync(path.join(testRoot, 'src', 'index.css'), 'utf8');

    expect(appSource).toContain('app-shell flex h-full w-full min-w-0');
    expect(appSource).not.toContain('app-shell flex h-screen w-screen');
    // rem root stays on html (16px); body/#root carry width fill + WebUI 15px type
    expect(cssSource).toMatch(/html\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/);
    expect(cssSource).toMatch(/body,\s*#root\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/);
    expect(cssSource).toMatch(/\.app-shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;/);
  });
  it('pins collapsed and expanded widths against flex min-content growth', () => {
    expect(replicaSidebarWidthStyle(true)).toEqual({ width: 60, minWidth: 60, maxWidth: 60 });
    expect(replicaSidebarWidthStyle(false)).toEqual({
      width: 'clamp(220px, 21vw, 252px)',
      minWidth: 'clamp(220px, 21vw, 252px)',
      maxWidth: 'clamp(220px, 21vw, 252px)',
    });
  });

  it('animates sidebar width and keeps expanded panels mountable for smooth collapse', () => {
    const sidebarSource = fs.readFileSync(path.join(testRoot, 'src', 'components', 'ReplicaSidebar.jsx'), 'utf8');
    const cssSource = fs.readFileSync(path.join(testRoot, 'src', 'index.css'), 'utf8');
    expect(sidebarSource).toMatch(/data-collapsed=\{sidebarCollapsed \? 'true' : 'false'\}/);
    expect(sidebarSource).toContain('sidebar-expand-panel');
    expect(sidebarSource).toContain('sidebar-expand-label');
    expect(cssSource).toMatch(/\.sidebar-nav\s*\{[\s\S]*?transition:[\s\S]*?width/);
    expect(cssSource).toContain('.sidebar-expand-panel.is-collapsed');
    expect(cssSource).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('keeps WebUI groups and desktop extensions folded by default', () => {
    expect(replicaSidebarGroupInitiallyExpanded('primary')).toBe(true);
    expect(replicaSidebarGroupInitiallyExpanded('workspace')).toBe(false);
    expect(replicaSidebarGroupInitiallyExpanded('observability')).toBe(false);
    expect(replicaSidebarGroupInitiallyExpanded('desktop-extensions')).toBe(false);
  });

  it('keeps the primary navigation focused on remote control', () => {
    const primary = replicaSidebarMainGroups().find((group) => group.id === 'primary');
    expect(primary.items.map((item) => item.id)).toEqual(['remote-control']);
  });

  it('matches the WebUI workspace and observability navigation order', () => {
    expect(replicaSidebarMainGroups().map((group) => group.id)).toEqual([
      'primary',
      'workspace',
      'observability',
      'desktop-extensions',
    ]);
    expect(replicaSidebarMainGroups().find((group) => group.id === 'workspace')).toMatchObject({
      title: '工作区',
      items: [
        { id: 'tasks', label: '任务' },
        { id: 'terminal', label: '终端' },
        { id: 'canvas', label: '画布' },
        { id: 'editor', label: '编辑器' },
        { id: 'changes', label: '变更' },
        { id: 'plugins', label: '插件' },
      ],
    });
    expect(replicaSidebarMainGroups().find((group) => group.id === 'observability')).toMatchObject({
      title: '可观测',
      items: [
        { id: 'stats', label: '统计' },
        { id: 'traces', label: '链路' },
        { id: 'metrics', label: '监控' },
        { id: 'logs', label: '日志' },
      ],
    });
  });

  it('keeps GUI-only pages discoverable in the collapsed desktop extension group', () => {
    const extensions = replicaSidebarMainGroups().find((group) => group.id === 'desktop-extensions');
    expect(extensions).toMatchObject({
      title: '桌面扩展',
      items: [
        { id: 'archived', label: '已归档' },
        { id: 'instances', label: '实例列表' },
        { id: 'skills', label: '技能' },
        { id: 'agents', label: 'Agents' },
        { id: 'mcp', label: 'MCP' },
        { id: 'sandboxes', label: 'Sandboxes' },
        { id: 'workers', label: 'Agent 实例管理' },
      ],
    });
    expect(replicaSidebarGroupForRoute('monitor')).toBeNull();
    expect(replicaSidebarGroupForRoute('metrics')).toBe('observability');
  });

  it('keeps the settings footer in WebUI order', () => {
    expect(replicaSidebarMainGroups().map((group) => group.id)).not.toContain('preferences');
    // Models live under Settings → 模型选择; the legacy models route remains compatible.
    expect(replicaSidebarFooterItems().map((item) => item.id)).toEqual(['settings', 'keybindings', 'docs']);
  });

  it('omits the redundant chat button from primary navigation', () => {
    const primary = replicaSidebarMainGroups().find((group) => group.id === 'primary');
    expect(primary.items.map((item) => item.id)).toEqual(['remote-control']);
  });
});
