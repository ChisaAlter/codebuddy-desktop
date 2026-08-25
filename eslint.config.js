// ESLint v9 flat config（2026-07-09 引入）
// 目标：不强整改存量，仅立配置 + npm script，新增/修改代码逐步 lint
// 后续可逐步收紧 rules 至 stricter，或引入 eslint-config-prettier 协同风格

import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        // Electron 渲染层暴露的全局
        electronAPI: 'readonly',
        // 浏览器遗留全局（部分组件用）
        globalThis: 'readonly',
      },
    },
    files: ['electron/**/*.{js,cjs}', 'src/**/*.{js,jsx}', 'tests/**/*.{js,jsx}'],
    rules: {
      // R10（2026-08-25 收紧）：全量 lint 已零告警，warn → error 并打开 no-undef，
      // 防止新增未定义全局/未使用变量悄悄溜进主干。
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'error',
      'no-irregular-whitespace': 'error',
      'no-undef': 'error',
    },
  },
  {
    files: ['src/**/*.jsx', 'tests/**/*.jsx'],
    plugins: { react },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'react/jsx-uses-vars': 'warn',
      'react/jsx-uses-react': 'warn',
    },
  },
  {
    // electron 主进程 CJS 文件：放行 require/module 等 CJS 全局
    files: ['electron/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, require: 'readonly', module: 'readonly' },
    },
  },
  {
    // 忽略目录（构建产物、依赖、对照源）
    ignores: ['node_modules/', 'dist/', 'out/', 'build/', 'webui-css.css', 'webui-js.js', '.playwright-cli/', '.trae/', '.codebuddy/'],
  },
];
