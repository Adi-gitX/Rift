import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import raftConfig from './packages/eslint-config/index.js';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  ...raftConfig,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    settings: {
      'import-x/resolver': {
        typescript: { alwaysTryTypes: true, project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'] },
      },
      'import-x/core-modules': ['cloudflare:workers', 'cloudflare:test'],
    },
    rules: {
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',
    },
  },
);
