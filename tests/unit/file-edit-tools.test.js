import { describe, expect, it } from 'vitest';
import { isFileEditTool, normalizeToolName } from '../../src/lib/file-edit-tools';

describe('normalizeToolName', () => {
  it('lowercases, splits camelCase, and collapses punctuation to underscores', () => {
    expect(normalizeToolName('Write')).toBe('write');
    expect(normalizeToolName('NotebookEdit')).toBe('notebook_edit');
    expect(normalizeToolName('str-replace')).toBe('str_replace');
    expect(normalizeToolName('str.replace')).toBe('str_replace');
    expect(normalizeToolName('ApplyPatch')).toBe('apply_patch');
  });
});

describe('isFileEditTool', () => {
  it('allows the exact file-edit tools and their normalized aliases', () => {
    expect(isFileEditTool('write')).toBe(true);
    expect(isFileEditTool('Write')).toBe(true);
    expect(isFileEditTool('edit')).toBe(true);
    expect(isFileEditTool('str_replace')).toBe(true);
    expect(isFileEditTool('str-replace')).toBe(true);
    expect(isFileEditTool('notebook_edit')).toBe(true);
    expect(isFileEditTool('NotebookEdit')).toBe(true);
    expect(isFileEditTool('apply_patch')).toBe(true);
    expect(isFileEditTool('ApplyPatch')).toBe(true);
  });

  it('rejects substring and unrelated tools that the old regex would have allowed', () => {
    expect(isFileEditTool('write_todos')).toBe(false);
    expect(isFileEditTool('WriteTodos')).toBe(false);
    expect(isFileEditTool('create')).toBe(false);
    expect(isFileEditTool('create_file')).toBe(false);
    expect(isFileEditTool('file')).toBe(false);
    expect(isFileEditTool('read_file')).toBe(false);
    expect(isFileEditTool('AskUserQuestion')).toBe(false);
    expect(isFileEditTool('bash')).toBe(false);
    expect(isFileEditTool('')).toBe(false);
    expect(isFileEditTool(null)).toBe(false);
  });
});
