import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  onCompact: vi.fn(),
  locale: 'zh',
}));

vi.mock('../../src/store', () => ({
  useStore(selector) {
    return selector({ guiSettings: { locale: mocks.locale } });
  },
}));

import ContextUsageIndicator from '../../src/components/ContextUsageIndicator';

let container = null;
let root = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.onCompact = vi.fn();
});

afterEach(() => {
  if (root) {
    act(() => {
      root.unmount();
    });
  }
  if (container && container.parentNode) container.parentNode.removeChild(container);
});

function render(ui) {
  act(() => {
    root.render(ui);
  });
}

describe('ContextUsageIndicator', () => {
  it('usage 为 null 时不渲染', () => {
    render(<ContextUsageIndicator usage={null} onCompact={mocks.onCompact} />);
    expect(container.textContent).toBe('');
  });

  it('size<=0 时不渲染', () => {
    render(<ContextUsageIndicator usage={{ used: 0, size: 0 }} onCompact={mocks.onCompact} />);
    expect(container.textContent).toBe('');
  });

  it('显示百分比且 60% 时颜色为 yellow', () => {
    render(
      <ContextUsageIndicator
        usage={{ used: 6000, size: 10000, usageByCategory: null }}
        onCompact={mocks.onCompact}
      />,
    );
    const toggle = container.querySelector('[data-testid="context-usage-toggle"]');
    expect(toggle).toBeTruthy();
    expect(toggle.textContent).toContain('60%');
    // 颜色阈值 60% 命中 yellow：svg circle stroke 用 currentColor，按钮 span class 含 yellow token。
    const spans = toggle.querySelectorAll('span');
    expect([...spans].some((s) => s.className.includes('accent-yellow'))).toBe(true);
  });

  it('>=92% 时按钮加 animate-pulse', () => {
    render(
      <ContextUsageIndicator
        usage={{ used: 9300, size: 10000, usageByCategory: null }}
        onCompact={mocks.onCompact}
      />,
    );
    const toggle = container.querySelector('[data-testid="context-usage-toggle"]');
    expect(toggle.className).toContain('animate-pulse');
  });

  it('>=70% 时颜色为 red', () => {
    render(
      <ContextUsageIndicator
        usage={{ used: 7000, size: 10000, usageByCategory: null }}
        onCompact={mocks.onCompact}
      />,
    );
    const toggle = container.querySelector('[data-testid="context-usage-toggle"]');
    const spans = toggle.querySelectorAll('span');
    expect([...spans].some((s) => s.className.includes('accent-red'))).toBe(true);
  });

  it('点击环形展开详情面板，含五类明细', () => {
    render(
      <ContextUsageIndicator
        usage={{
          used: 6000,
          size: 10000,
          usageByCategory: {
            systemPrompt: 1000,
            tools: 500,
            conversation: 4000,
            mcp: 200,
            skills: 300,
          },
        }}
        onCompact={mocks.onCompact}
      />,
    );
    // 初始无面板。
    expect(container.querySelector('[data-testid="context-usage-panel"]')).toBeNull();
    const toggle = container.querySelector('[data-testid="context-usage-toggle"]');
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const panel = container.querySelector('[data-testid="context-usage-panel"]');
    expect(panel).toBeTruthy();
    // 五类标签均在（zh 文案）。
    expect(panel.textContent).toContain('系统提示词');
    expect(panel.textContent).toContain('工具及子智能体');
    expect(panel.textContent).toContain('对话消息');
    expect(panel.textContent).toContain('连接器及 MCP');
    expect(panel.textContent).toContain('技能');
  });

  it('点击压缩按钮触发 onCompact 并关闭面板', () => {
    render(
      <ContextUsageIndicator
        usage={{ used: 6000, size: 10000, usageByCategory: null }}
        onCompact={mocks.onCompact}
      />,
    );
    const toggle = container.querySelector('[data-testid="context-usage-toggle"]');
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const btn = container.querySelector('[data-testid="context-usage-compact"]');
    expect(btn).toBeTruthy();
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.onCompact).toHaveBeenCalledTimes(1);
    // 点击后面板关闭。
    expect(container.querySelector('[data-testid="context-usage-panel"]')).toBeNull();
  });

  it('compactState=compacting 时压缩按钮禁用且显示 compacting 文案', () => {
    render(
      <ContextUsageIndicator
        usage={{ used: 6000, size: 10000, usageByCategory: null }}
        onCompact={mocks.onCompact}
        compactState="compacting"
      />,
    );
    const toggle = container.querySelector('[data-testid="context-usage-toggle"]');
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const btn = container.querySelector('[data-testid="context-usage-compact"]');
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('正在压缩');
    // 点击禁用按钮不触发 onCompact。
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.onCompact).not.toHaveBeenCalled();
  });

  it('disabled=true 时压缩按钮禁用', () => {
    render(
      <ContextUsageIndicator
        usage={{ used: 6000, size: 10000, usageByCategory: null }}
        onCompact={mocks.onCompact}
        disabled
      />,
    );
    const toggle = container.querySelector('[data-testid="context-usage-toggle"]');
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const btn = container.querySelector('[data-testid="context-usage-compact"]');
    expect(btn.disabled).toBe(true);
  });
});