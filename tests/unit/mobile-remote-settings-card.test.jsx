import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MobileRemoteSettingsCard, { deviceDisplayName } from '../../src/components/MobileRemoteSettingsCard';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,xx') },
}));

describe('deviceDisplayName', () => {
  it('prefers the device label when present', () => {
    expect(deviceDisplayName({ label: '我的手机', deviceId: 'abcdef123456' })).toBe('我的手机');
  });

  it('falls back to the deviceId prefix when the label is missing', () => {
    expect(deviceDisplayName({ deviceId: 'abcdef1234567890' })).toBe('abcdef123456');
  });

  it('never crashes on a missing or empty deviceId', () => {
    expect(deviceDisplayName({})).toBe('');
    expect(deviceDisplayName({ deviceId: null })).toBe('');
    expect(deviceDisplayName({ deviceId: '' })).toBe('');
    expect(deviceDisplayName(null)).toBe('');
    expect(deviceDisplayName(undefined)).toBe('');
  });

  it('returns empty when the device carries neither label nor id', () => {
    expect(deviceDisplayName({ deviceName: 'legacy' })).toBe('');
  });
});

describe('MobileRemoteSettingsCard TLS toggle', () => {
  let container;
  let root;
  let originalElectronAPI;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    originalElectronAPI = window.electronAPI;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.electronAPI = originalElectronAPI;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('guards the TLS toggle against double-clicks while a request is in flight', async () => {
    let resolveSetConfig;
    window.electronAPI = {
      mobileRemoteGetStatus: vi.fn().mockResolvedValue({}),
      mobileRemoteGetConfig: vi.fn().mockResolvedValue({
        enabled: false,
        relayEndpoint: '127.0.0.1:8787',
        relayUseTls: false,
      }),
      mobileRemoteListDevices: vi.fn().mockResolvedValue([]),
      mobileRemoteSetConfig: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveSetConfig = resolve;
          }),
      ),
    };
    const t = (key) => key;

    await act(async () => {
      root.render(React.createElement(MobileRemoteSettingsCard, { t }));
      await Promise.resolve();
    });

    // Find the TLS toggle (second settings-toggle-switch after the enable switch).
    const toggles = container.querySelectorAll('.settings-toggle-switch');
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    const tlsToggle = toggles[1];

    await act(async () => {
      tlsToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      tlsToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    // Only one request may be in flight for the double-click.
    expect(window.electronAPI.mobileRemoteSetConfig).toHaveBeenCalledTimes(1);

    // Resolve it: the UI adopts the confirmed config and the busy lock releases.
    await act(async () => {
      resolveSetConfig({
        config: { enabled: false, relayEndpoint: '127.0.0.1:8787', relayUseTls: true },
        status: {},
      });
      await Promise.resolve();
    });
    expect(tlsToggle.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('MobileRemoteSettingsCard pairing QR', () => {
  let container;
  let root;
  let originalElectronAPI;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    originalElectronAPI = window.electronAPI;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.electronAPI = originalElectronAPI;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('regenerates a tokenized offer even when no devices are paired', async () => {
    const getOffer = vi.fn().mockResolvedValue({ offerUrl: 'cbmr://offer-with-token' });
    const getOfferWithToken = vi.fn().mockResolvedValue({ offerUrl: 'cbmr://offer-with-token' });
    window.electronAPI = {
      mobileRemoteGetStatus: vi.fn().mockResolvedValue({}),
      mobileRemoteGetConfig: vi.fn().mockResolvedValue({
        enabled: true,
        relayEndpoint: '127.0.0.1:8787',
        relayUseTls: false,
      }),
      mobileRemoteListDevices: vi.fn().mockResolvedValue([]),
      mobileRemoteGetPairingOffer: getOffer,
      mobileRemoteGetPairingOfferWithToken: getOfferWithToken,
    };
    const t = (key) => key;

    await act(async () => {
      root.render(React.createElement(MobileRemoteSettingsCard, { t }));
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('首台设备无需令牌');

    const regenerate = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'mobileRemote.regenerate',
    );
    expect(regenerate).toBeTruthy();

    await act(async () => {
      regenerate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getOfferWithToken).toHaveBeenCalled();
  });
});
