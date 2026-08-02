import { describe, expect, it } from 'vitest';
import {
  nextLocaleMode,
  nextThemeMode,
  resolveLocaleMode,
  translate,
} from '../../src/lib/i18n.js';

describe('i18n', () => {
  it('cycles locale like WebUI: zh → en → system → zh', () => {
    expect(nextLocaleMode('zh')).toBe('en');
    expect(nextLocaleMode('en')).toBe('system');
    expect(nextLocaleMode('system')).toBe('zh');
  });

  it('cycles theme like WebUI: light → dark → system → light', () => {
    expect(nextThemeMode('light')).toBe('dark');
    expect(nextThemeMode('dark')).toBe('system');
    expect(nextThemeMode('system')).toBe('light');
  });

  it('resolves fixed locale modes without system detection', () => {
    expect(resolveLocaleMode('zh')).toBe('zh');
    expect(resolveLocaleMode('en')).toBe('en');
  });

  it('translates settings and thinking strings', () => {
    expect(translate('zh', 'sidebar.language')).toBe('界面语言');
    expect(translate('en', 'sidebar.language')).toBe('Language');
    expect(translate('zh', 'thinking.thinking')).toBe('思考中');
    expect(translate('en', 'thinking.thinking')).toBe('Thinking');
    expect(translate('zh', 'thinking.seconds', { n: 3 })).toBe('（用时 3 秒）');
    expect(translate('en', 'thinking.seconds', { n: 3 })).toBe(' (took 3s)');
    expect(translate('zh', 'thinking.duration', { duration: '<1 秒' })).toBe('（用时 <1 秒）');
    expect(translate('en', 'thinking.duration', { duration: '4 秒' })).toBe(' (took 4 秒)');
  });

  it('covers WebUI system info labels and desktop isolation labels', () => {
    expect(translate('zh', 'sidebar.cwd')).toBe('工作目录');
    expect(translate('zh', 'sidebar.tunnelUrl')).toBe('Tunnel URL');
    expect(translate('en', 'sidebar.gatewayMode')).toBe('Gateway Mode');
    expect(translate('zh', 'settings.desktopApp')).toBe('桌面应用');
    expect(translate('en', 'settings.desktopApp')).toBe('Desktop App');
  });

  it('covers WebUI chat chrome and CLI maintenance labels', () => {
    expect(translate('zh', 'chat.empty.subtitle')).toBe('今天有什么可以帮到你？');
    expect(translate('en', 'chat.empty.subtitle')).toBe('How can I help you today?');
    expect(translate('zh', 'input.placeholder')).toBe('从一个想法开始...');
    expect(translate('en', 'input.placeholder')).toBe('Start from an idea...');
    expect(translate('zh', 'chat.disclaimer')).toBe('回答由 AI 生成，仅供参考');
    expect(translate('en', 'input.stop')).toBe('Stop');
    expect(translate('zh', 'cli.installedVersion')).toBe('已安装版本');
    expect(translate('en', 'cli.maintenance')).toBe('Maintenance');
    expect(translate('zh', 'cli.compatStatus.desc', { min: '2.125.0', rec: '2.125.0' })).toContain('2.125.0');
  });

  it('covers remaining chat chrome: scroll/queue/attachment/effort/phase', () => {
    expect(translate('zh', 'chat.scrollToLatest')).toBe('跳到最新');
    expect(translate('en', 'chat.scrollToLatest')).toBe('Scroll to latest');
    expect(translate('zh', 'input.dropHint')).toBe('拖拽文件到这里');
    expect(translate('zh', 'input.addAttachment')).toBe('添加附件');
    expect(translate('en', 'input.addAttachment')).toBe('Add attachment');
    expect(translate('zh', 'input.menu.image')).toBe('图片');
    expect(translate('zh', 'input.menu.file')).toBe('文件');
    expect(translate('zh', 'input.imageCapabilityUnavailable')).toContain('图片输入能力');
    expect(translate('en', 'input.imageCapabilityUnavailable')).toContain('image input');
    expect(translate('zh', 'input.deepThinking')).toBe('深度思考');
    expect(translate('zh', 'phase.modelRequesting')).toBe('等待模型响应');
    expect(translate('zh', 'phase.thinking')).toBe('正在思考');
    expect(translate('zh', 'queue.title', { n: 2 })).toBe('待发送 2');
    expect(translate('en', 'composer.effort')).toBe('Reasoning effort');
    expect(translate('zh', 'attachment.remove')).toBe('移除附件');
    expect(translate('zh', 'suggestion.title')).toBe('CodeBuddy 建议');
    expect(translate('en', 'suggestion.title')).toBe('CodeBuddy suggestion');
    expect(translate('zh', 'suggestion.dismiss')).toBe('关闭建议');
    expect(translate('zh', 'message.clickToEnlarge')).toBe('点击放大');
    // e2e waitForVisibleSettingValue looks up this exact label (with space)
    expect(translate('zh', 'sidebar.sessionId')).toBe('会话 ID');
    expect(translate('en', 'sidebar.sessionId')).toBe('Session ID');
    expect(translate('zh', 'account.login')).toBe('登录');
    expect(translate('zh', 'account.cancelLogin')).toBe('取消登录');
    expect(translate('zh', 'account.site.cn')).toBe('国内站');
    expect(translate('zh', 'account.site.global')).toBe('国外站');
    expect(translate('en', 'account.site.global')).toBe('International');
    expect(translate('zh', 'sidebar.cliVersion', { version: '2.125.0' })).toBe(
      'CodeBuddy CLI v2.125.0',
    );
  });

  it('localizes workflow phases and never exposes an unknown translation key', () => {
    expect(translate('zh', 'workflow.phase.preparing')).toBe('正在准备工作流');
    expect(translate('en', 'workflow.phase.waiting_for_permission')).toBe('Waiting for permission');
    expect(translate('zh', 'workflow.phase.unknown')).toBe('正在执行');
    expect(translate('zh', 'workflow.waitingForPermission')).toBe('等待你的权限确认');
    expect(translate('zh', 'workflow.phase.not_yet_known')).toBe('workflow.phase.not_yet_known');
  });
  it('covers interruption/question keys aligned with WebUI 2.124', () => {
    expect(translate('zh', 'interruption.allow')).toBe('允许');
    expect(translate('zh', 'interruption.allowAll')).toBe('全部允许');
    expect(translate('en', 'interruption.deny')).toBe('Deny');
    expect(translate('zh', 'question.singleTitle')).toBe('问题');
    expect(translate('zh', 'question.submit')).toBe('提交');
    expect(translate('en', 'question.cancel')).toBe('Cancel');
    expect(translate('zh', 'composer.effort.disabled')).toBe('关闭');
    expect(translate('en', 'composer.effort.enabled')).toBe('Default');
    expect(translate('zh', 'composer.workspaceDirs')).toBe('附加工作目录');
    expect(translate('en', 'composer.workspaceDirs.add')).toBe('Add directory');
    expect(translate('zh', 'plugins.backToTop')).toBe('回到顶部');
    expect(translate('en', 'plugins.autoUpdate')).toBe('Auto update');
    expect(translate('zh', 'skills.title')).toBe('技能');
    expect(translate('en', 'agents.scopedMcp')).toBe('Scoped MCP');
  });

  // M-rc4: composer i18n leaks now route through keys added for this fix.
  it('covers composer usage / loadingModels / ultracode and instances stop keys', () => {
    expect(translate('zh', 'composer.usage')).toBe('用量');
    expect(translate('en', 'composer.usage')).toBe('Usage');
    expect(translate('zh', 'composer.loadingModels')).toBe('加载中...');
    expect(translate('en', 'composer.loadingModels')).toBe('Loading...');
    expect(translate('zh', 'composer.effort.ultracode')).toBe('ultracode');
    expect(translate('en', 'composer.effort.ultracode')).toBe('ultracode');
    // instances stop confirm (M-rc3)
    expect(translate('zh', 'instances.stopTitle')).toBe('停止运行时？');
    expect(translate('en', 'instances.confirmStop')).toBe('Stop');
    // mobileRemote revoke dialog (M-rc1)
    expect(translate('zh', 'mobileRemote.revokeTitle')).toBe('吊销设备？');
    expect(translate('en', 'mobileRemote.confirmRevoke')).toBe('Revoke');
  });
});
