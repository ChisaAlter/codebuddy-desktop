import { describe, it, expect } from 'vitest';
import { parseHashRoute, setHashRoute, ROUTES } from '../../src/lib/routes';

// jsdom 环境：window.location.hash 可读写
describe('parseHashRoute - hash 路由解析', () => {
  it('空 hash 兜底到 chat', () => {
    window.location.hash = '';
    expect(parseHashRoute()).toBe('chat');
  });

  it('#/chat 解析为 chat', () => {
    window.location.hash = '#/chat';
    expect(parseHashRoute()).toBe('chat');
  });

  it('#/terminal 解析为 terminal', () => {
    window.location.hash = '#/terminal';
    expect(parseHashRoute()).toBe('terminal');
  });

  it('带 query string 仅取路由段', () => {
    window.location.hash = '#/stats?range=7d';
    expect(parseHashRoute()).toBe('stats');
  });

  it('未注册路由兜底到 chat', () => {
    window.location.hash = '#/nonexistent';
    expect(parseHashRoute()).toBe('chat');
  });

  it('无前导斜杠形态（#/terminal 不带斜杠）也接受', () => {
    window.location.hash = '#terminal';
    expect(parseHashRoute()).toBe('terminal');
  });
});

describe('setHashRoute - hash 路由设置', () => {
  it('合法路由写入 #/route', () => {
    setHashRoute('workers');
    expect(window.location.hash).toBe('#/workers');
  });

  it('未注册路由兜底到 #/chat', () => {
    setHashRoute('evil');
    expect(window.location.hash).toBe('#/chat');
  });

  it('目标 hash 与当前相同则不触发重复写入', () => {
    window.location.hash = '#/chat';
    setHashRoute('chat');
    expect(window.location.hash).toBe('#/chat');
  });
});

describe('ROUTES 常量', () => {
  it('包含当前应用支持的路由', () => {
    expect(ROUTES).toContain('chat');
    expect(ROUTES).toContain('instances');
    expect(ROUTES).toContain('remote-control');
    expect(ROUTES).toContain('terminal');
    expect(ROUTES).toContain('canvas');
    expect(ROUTES).toContain('agent-home');
    expect(ROUTES).toContain('tasks');
    expect(ROUTES).toContain('archived');
    expect(ROUTES).toContain('plugins');
    expect(ROUTES).toContain('skills');
    expect(ROUTES).toContain('agents');
    expect(ROUTES).toContain('editor');
    expect(ROUTES).toContain('changes');
    expect(ROUTES).toContain('stats');
    expect(ROUTES).toContain('traces');
    expect(ROUTES).toContain('monitor');
    expect(ROUTES).toContain('metrics');
    expect(ROUTES).toContain('logs');
    expect(ROUTES).toContain('workers');
    expect(ROUTES).toContain('docs');
    expect(ROUTES).toContain('models');
    expect(ROUTES).toContain('settings');
    expect(ROUTES).toContain('keybindings');
  });
});
