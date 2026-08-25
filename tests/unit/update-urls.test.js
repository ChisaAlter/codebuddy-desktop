import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  GUI_REPO_SLUGS,
  GUI_RELEASES_URL,
  GUI_LATEST_RELEASE_API,
  compareVersions,
  trustedGuiReleaseUrl,
  trustedGuiDownloadUrl,
} = require('../../electron/update-urls.cjs');

describe('update-urls', () => {
  it('canonical URLs point at the renamed codebuddy-desktop repo', () => {
    expect(GUI_RELEASES_URL).toBe('https://github.com/ChisaAlter/codebuddy-desktop/releases');
    expect(GUI_LATEST_RELEASE_API).toBe(
      'https://api.github.com/repos/ChisaAlter/codebuddy-desktop/releases/latest',
    );
    expect(GUI_REPO_SLUGS).toContain('ChisaAlter/codebuddy-desktop');
    // 旧 slug 保留为重定向别名：历史 release 资产地址仍可能带旧路径。
    expect(GUI_REPO_SLUGS).toContain('ChisaAlter/codebuddy-gui');
  });

  describe('trustedGuiReleaseUrl', () => {
    it('accepts release pages on the new and legacy repo slugs', () => {
      expect(trustedGuiReleaseUrl('https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.1.1')).toBe(
        'https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.1.1',
      );
      expect(trustedGuiReleaseUrl('https://github.com/ChisaAlter/codebuddy-gui/releases/tag/v1.0.5')).toBe(
        'https://github.com/ChisaAlter/codebuddy-gui/releases/tag/v1.0.5',
      );
    });

    it('falls back to the canonical releases page for anything else', () => {
      expect(trustedGuiReleaseUrl('https://github.com/evil/repo/releases')).toBe(GUI_RELEASES_URL);
      expect(trustedGuiReleaseUrl('https://example.com/ChisaAlter/codebuddy-desktop/releases')).toBe(
        GUI_RELEASES_URL,
      );
      expect(trustedGuiReleaseUrl('not-a-url')).toBe(GUI_RELEASES_URL);
      expect(trustedGuiReleaseUrl(null)).toBe(GUI_RELEASES_URL);
    });
  });

  describe('trustedGuiDownloadUrl', () => {
    const good =
      'https://github.com/ChisaAlter/codebuddy-desktop/releases/download/v1.1.1/CodeBuddy-GUI-Setup-1.1.1.exe';
    const legacy =
      'https://github.com/ChisaAlter/codebuddy-gui/releases/download/v1.0.5/CodeBuddy-GUI-Setup-1.0.5.exe';

    it('accepts installer assets under the new repo slug', () => {
      expect(trustedGuiDownloadUrl(good)).toBe(good);
    });

    it('still accepts installer assets under the legacy slug (GitHub redirect)', () => {
      expect(trustedGuiDownloadUrl(legacy)).toBe(legacy);
    });

    it('requires the tag version to match the installer file version', () => {
      expect(
        trustedGuiDownloadUrl(
          'https://github.com/ChisaAlter/codebuddy-desktop/releases/download/v1.1.1/CodeBuddy-GUI-Setup-9.9.9.exe',
        ),
      ).toBeNull();
    });

    it('rejects foreign hosts, foreign repos, credentials, query and hash', () => {
      expect(
        trustedGuiDownloadUrl(
          'https://example.com/ChisaAlter/codebuddy-desktop/releases/download/v1.1.1/CodeBuddy-GUI-Setup-1.1.1.exe',
        ),
      ).toBeNull();
      expect(
        trustedGuiDownloadUrl(
          'https://github.com/evil/codebuddy-desktop/releases/download/v1.1.1/CodeBuddy-GUI-Setup-1.1.1.exe',
        ),
      ).toBeNull();
      expect(trustedGuiDownloadUrl(`${good}?x=1`)).toBeNull();
      expect(trustedGuiDownloadUrl(`${good}#frag`)).toBeNull();
      expect(
        trustedGuiDownloadUrl(
          'https://user:pass@github.com/ChisaAlter/codebuddy-desktop/releases/download/v1.1.1/CodeBuddy-GUI-Setup-1.1.1.exe',
        ),
      ).toBeNull();
      expect(trustedGuiDownloadUrl('')).toBeNull();
      expect(trustedGuiDownloadUrl(null)).toBeNull();
    });
  });

  it('compareVersions orders semantic-ish versions', () => {
    expect(compareVersions('1.1.1', '1.1.0')).toBe(1);
    expect(compareVersions('1.1.0', '1.1.1')).toBe(-1);
    expect(compareVersions('v1.1.1', '1.1.1')).toBe(0);
    expect(compareVersions('1.1.1-beta', '1.1.1')).toBe(0);
    expect(compareVersions('2.0', '1.9.9')).toBe(1);
  });
});
