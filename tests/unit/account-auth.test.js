import { describe, expect, it } from 'vitest';
import {
  accountFooterPresentation,
  classifyPromptRefusal,
  formatCodeBuddyAccountLabel,
  formatCustomModelAuthFailureMessage,
  formatNetworkOrProxyFailureMessage,
  internetEnvironmentForAccountSite,
  isCloudAuthFailureMessage,
  isCustomModelAuthFailureMessage,
  isNetworkOrProxyFailureMessage,
  normalizeAccountLoginSite,
  normalizeLastAccountUser,
  pickAuthMethodId,
  preferredAuthMethodIdsForSite,
} from '../../src/lib/account-auth';

describe('account-auth helpers', () => {
  it('normalizes login site (default matches bare CLI = global)', () => {
    expect(normalizeAccountLoginSite('cn')).toBe('cn');
    expect(normalizeAccountLoginSite('global')).toBe('global');
    expect(normalizeAccountLoginSite('ioa')).toBe('global');
    expect(normalizeAccountLoginSite(undefined)).toBe('global');
  });

  it('maps site to internet environment without forcing ioa', () => {
    expect(internetEnvironmentForAccountSite('cn')).toBe('internal');
    expect(internetEnvironmentForAccountSite('global')).toBeNull();
    expect(internetEnvironmentForAccountSite(undefined)).toBeNull();
  });

  it('prefers internal method for cn and external for global', () => {
    expect(preferredAuthMethodIdsForSite('cn')[0]).toBe('internal');
    expect(preferredAuthMethodIdsForSite('global')[0]).toBe('external');
    const methods = [
      { id: 'iOA' },
      { id: 'external' },
      { id: 'internal' },
    ];
    expect(pickAuthMethodId(methods, 'cn')).toBe('internal');
    expect(pickAuthMethodId(methods, 'global')).toBe('external');
    expect(pickAuthMethodId([{ id: 'iOA' }], 'cn')).toBe('iOA');
    expect(pickAuthMethodId(methods, undefined)).toBe('external');
  });

  it('formats user labels in preference order', () => {
    expect(formatCodeBuddyAccountLabel({ userNickname: 'Ayase', userName: 'a' })).toBe('Ayase');
    expect(formatCodeBuddyAccountLabel({ userName: 'alice', email: 'a@b.c' })).toBe('alice');
    expect(formatCodeBuddyAccountLabel({ email: 'a@b.c' })).toBe('a@b.c');
    expect(formatCodeBuddyAccountLabel(null)).toBeNull();
  });

  it('normalizes last account user for cache', () => {
    expect(normalizeLastAccountUser({ userId: '1', userNickname: ' N ' })).toEqual({
      userId: '1',
      userNickname: 'N',
    });
    expect(normalizeLastAccountUser({ junk: true })).toBeNull();
  });

  it('builds footer presentation states', () => {
    // required + lastUser → cached display so sidebar keeps the name
    expect(
      accountFooterPresentation({
        authState: 'required',
        lastUser: { userName: 'x' },
      }),
    ).toMatchObject({ kind: 'cached', label: 'x', showLogin: true, cached: true });
    expect(
      accountFooterPresentation({
        authState: 'required',
        lastUser: null,
      }).kind,
    ).toBe('needs_login');
    expect(
      accountFooterPresentation({
        authState: 'authenticated',
        user: { userNickname: 'Ayase' },
        site: 'global',
      }),
    ).toMatchObject({ kind: 'authenticated', label: 'Ayase', site: 'global', showLogin: false });
    expect(
      accountFooterPresentation({
        authState: 'unknown',
        lastUser: { userName: 'cached' },
      }),
    ).toMatchObject({ kind: 'cached', label: 'cached', showLogin: true, cached: true });
    expect(accountFooterPresentation({ authState: 'authenticating' }).kind).toBe('authenticating');
  });

  it('classifies network/proxy refusals separately from cloud auth failures', () => {
    const html502 =
      '502 <html><head><title>502 Bad Gateway</title></head></html> (proxy: http://127.0.0.1:10809 -> https://ayase.cn)';
    expect(isNetworkOrProxyFailureMessage(html502)).toBe(true);
    expect(isCloudAuthFailureMessage(html502)).toBe(false);
    const classified = classifyPromptRefusal({
      stopReason: 'refusal',
      category: 'network',
      errorMessage: html502,
    });
    expect(classified.kind).toBe('network');
    expect(classified.message).toMatch(/502|Bad Gateway|proxy/i);
    expect(
      classifyPromptRefusal({
        stopReason: 'refusal',
        category: 'auth',
        errorMessage: 'Authentication required',
      }).kind,
    ).toBe('auth');
    expect(classifyPromptRefusal({ stopReason: 'refusal' }).kind).toBe('refusal');
    expect(isCloudAuthFailureMessage('Authentication required')).toBe(true);
    expect(isCloudAuthFailureMessage('connect ECONNREFUSED 127.0.0.1:10809')).toBe(false);
  });

  it('unwraps CLI JSON errorMessage with embedded network category (no top-level category)', () => {
    const details =
      '502 <html><head><title>502 Bad Gateway</title></head></html> (proxy: http://127.0.0.1:10809 -> https://ayase.cn)';
    const errorMessage = JSON.stringify({
      code: -32001,
      message: `Network error: ${details}`,
      data: { category: 'network', statusCode: 502, details, code: 502 },
    });
    const classified = classifyPromptRefusal({
      stopReason: 'refusal',
      errorMessage,
    });
    expect(classified.kind).toBe('network');
    expect(classified.statusCode).toBe(502);
    expect(String(classified.message || '')).toMatch(/502|Bad Gateway|Network error|proxy/i);

    const summary = formatNetworkOrProxyFailureMessage(classified.message || details, {
      statusCode: classified.statusCode,
    });
    expect(summary).toMatch(/HTTP 502/);
    expect(summary).toMatch(/不是登录失效/);
    expect(summary).not.toMatch(/<\s*html/i);
  });

  it('explains unknown provider model id from custom endpoints', () => {
    const summary = formatNetworkOrProxyFailureMessage(
      '502 unknown provider for model grok (abc/session)',
      { statusCode: 502 },
    );
    expect(summary).toMatch(/不认识模型 ID「grok」/);
    expect(summary).toMatch(/真实模型名/);
    expect(summary).toMatch(/HTTP 502/);
  });

  it('compacts env-style proxy dumps instead of pasting full NO_PROXY lists into UI', () => {
    const dump =
      '模型请求失败 · HTTP 502 · http://38.76.185.154:13001 · 经代理 ' +
      'http_proxy=http://127.0.0.1:10809; https_proxy=http://127.0.0.1:10809; ' +
      'HTTP_PROXY=http://127.0.0.1:10809; HTTPS_PROXY=http://127.0.0.1:10809; ' +
      'NO_PROXY=localhost,127.0.0.1,::1,ispure.dynv6.net,api.longcat.chat,api5-normal.gl.doubao.com,' +
      'www.doubao.com,*.doubao.com,*.zijieapi.com; ' +
      'no_proxy=localhost,127.0.0.1,::1,ispure.dynv6.net。这不是登录失效；请检查代理、网络或自定义模型端点后重试。';
    const summary = formatNetworkOrProxyFailureMessage(dump, { statusCode: 502 });
    expect(summary).toMatch(/HTTP 502/);
    expect(summary).toMatch(/38\.76\.185\.154:13001/);
    expect(summary).toMatch(/经代理 http:\/\/127\.0\.0\.1:10809/);
    expect(summary).toMatch(/不是登录失效/);
    expect(summary).not.toMatch(/NO_PROXY=/i);
    expect(summary).not.toMatch(/doubao\.com/);
    expect(summary.length).toBeLessThan(220);
  });

  it('classifies custom_model_auth 401 separately from cloud login failures', () => {
    const customAuth =
      '401 Authentication failed (401) for model "grok-4.5". The request was sent to http://ayase.cn:13001, which differs from the current product endpoint https://copilot.tencent.com. (token-length:1293)';
    expect(isCustomModelAuthFailureMessage(customAuth)).toBe(true);
    expect(isCloudAuthFailureMessage(customAuth)).toBe(false);
    const classified = classifyPromptRefusal({
      stopReason: 'refusal',
      errorMessage: JSON.stringify({
        code: -32603,
        message: customAuth,
        data: { category: 'custom_model_auth', statusCode: 401 },
      }),
    });
    expect(classified.kind).toBe('custom_model_auth');
    expect(classified.statusCode).toBe(401);
    const summary = formatCustomModelAuthFailureMessage(customAuth);
    expect(summary).toMatch(/自定义模型鉴权失败/);
    expect(summary).toMatch(/grok-4\.5/);
    expect(summary).toMatch(/不是 CodeBuddy 云端登录失效/);
    expect(summary).toMatch(/API Key/);
  });
});
