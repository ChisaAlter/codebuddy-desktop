import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const saveSelectedFile = vi.fn();
  return {
    saveSelectedFile,
    state: () => ({
      selectedFile: 'src/example.js',
      filePreview: 'const value = true;\n',
      filePreviewLoading: false,
      fileDirty: true,
      fileSaving: false,
      setFilePreview: vi.fn(),
      saveSelectedFile,
    }),
  };
});

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  loader: { config: vi.fn() },
}));
vi.mock('monaco-editor/editor/editor.api.js', () => ({
  languages: {
    getLanguages: () => [{ id: 'json' }],
    register: vi.fn(),
    setTokensProvider: vi.fn(),
    setLanguageConfiguration: vi.fn(),
  },
}));
vi.mock('monaco-editor/editor/editor.worker.js?worker', () => ({ default: class EditorWorker {} }));
vi.mock('monaco-editor/languages/features/json/tokenization.js', () => ({ createTokenizationSupport: vi.fn() }));
vi.mock('monaco-editor/languages/definitions/css/register.js', () => ({}));
vi.mock('monaco-editor/languages/definitions/html/register.js', () => ({}));
vi.mock('monaco-editor/languages/definitions/javascript/register.js', () => ({}));
vi.mock('monaco-editor/languages/definitions/markdown/register.js', () => ({}));
vi.mock('monaco-editor/languages/definitions/python/register.js', () => ({}));
vi.mock('monaco-editor/languages/definitions/shell/register.js', () => ({}));
vi.mock('monaco-editor/languages/definitions/typescript/register.js', () => ({}));
vi.mock('monaco-editor/languages/definitions/yaml/register.js', () => ({}));

vi.mock('../../src/store', () => ({
  useStore: Object.assign(
    (selector) => selector(mocks.state()),
    { getState: mocks.state },
  ),
}));

import { EditorPane } from '../../src/components/ReplicaWorkspaceView';

describe('workspace editor saving', () => {
  let container;
  let root;

  beforeEach(() => {
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.saveSelectedFile.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    delete window.matchMedia;
  });

  it('invokes the real save action from the editor toolbar', async () => {
    await act(async () => root.render(React.createElement(EditorPane)));

    const saveButton = container.querySelector('button[title="保存文件 (Ctrl+S)"]');
    expect(saveButton).toBeTruthy();
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.saveSelectedFile).toHaveBeenCalledTimes(1);
  });
});
