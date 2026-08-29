// G11: 编辑器多标签纯逻辑（pin 排序、关闭焦点迁移、关闭其它、预览类型）。
import { describe, expect, it } from 'vitest';
import {
  addEditorTab,
  closeEditorTab,
  closeOtherEditorTabs,
  editorFileKind,
  nextActiveAfterClose,
  tabBasename,
  toggleEditorTabPin,
} from '../../src/lib/editor-tabs';

const tab = (path, pinned = false) => ({ path, pinned });

describe('addEditorTab / closeEditorTab', () => {
  it('appends new paths once', () => {
    let tabs = addEditorTab([], 'a.js');
    tabs = addEditorTab(tabs, 'b.js');
    tabs = addEditorTab(tabs, 'a.js');
    expect(tabs.map((item) => item.path)).toEqual(['a.js', 'b.js']);
  });

  it('closes by path', () => {
    expect(closeEditorTab([tab('a'), tab('b')], 'a').map((item) => item.path)).toEqual(['b']);
  });
});

describe('nextActiveAfterClose', () => {
  const tabs = [tab('a'), tab('b'), tab('c')];

  it('keeps focus when a background tab closes', () => {
    expect(nextActiveAfterClose(tabs, 'a', 'b')).toBe('b');
  });

  it('prefers the right neighbour, then the left', () => {
    expect(nextActiveAfterClose(tabs, 'b', 'b')).toBe('c');
    expect(nextActiveAfterClose(tabs, 'c', 'c')).toBe('b');
  });

  it('returns null when the last tab closes', () => {
    expect(nextActiveAfterClose([tab('a')], 'a', 'a')).toBeNull();
  });
});

describe('pin / close others', () => {
  it('toggle pin moves pinned tabs to the front', () => {
    const tabs = toggleEditorTabPin([tab('a'), tab('b'), tab('c')], 'c');
    expect(tabs.map((item) => item.path)).toEqual(['c', 'a', 'b']);
    expect(tabs[0].pinned).toBe(true);
    const unpinned = toggleEditorTabPin(tabs, 'c');
    expect(unpinned.every((item) => !item.pinned)).toBe(true);
  });

  it('close others keeps pinned tabs and the target', () => {
    const tabs = [tab('pinned', true), tab('a'), tab('b')];
    expect(closeOtherEditorTabs(tabs, 'b').map((item) => item.path)).toEqual(['pinned', 'b']);
  });
});

describe('editorFileKind / tabBasename', () => {
  it('classifies preview kinds', () => {
    expect(editorFileKind('README.md')).toBe('markdown');
    expect(editorFileKind('doc.mdx')).toBe('markdown');
    expect(editorFileKind('logo.svg')).toBe('svg');
    expect(editorFileKind('report.PDF')).toBe('pdf');
    expect(editorFileKind('photo.jpeg')).toBe('image');
    expect(editorFileKind('main.rs')).toBe('text');
    expect(editorFileKind('')).toBe('text');
  });

  it('extracts basenames across separators', () => {
    expect(tabBasename('src/lib/a.js')).toBe('a.js');
    expect(tabBasename('C:\\repo\\file.ts')).toBe('file.ts');
    expect(tabBasename('plain')).toBe('plain');
  });
});
