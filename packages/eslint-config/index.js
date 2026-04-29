/**
 * Shared ESLint flat-config rules for Raft.
 * Enforces PRD §20 coding standards.
 */
const raftRules = {
  files: ['**/*.{ts,tsx,js,mjs}'],
  rules: {
    'import-x/no-default-export': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': [
      'error',
      { max: 40, skipBlankLines: true, skipComments: true, IIFEs: true },
    ],
    'no-restricted-globals': [
      'error',
      { name: 'process', message: 'Use the typed Env interface; never read process.env in Workers.' },
    ],
    eqeqeq: ['error', 'always'],
    curly: ['error', 'multi-line'],
  },
};

const testOverrides = {
  files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
  rules: {
    'max-lines-per-function': 'off',
    'max-lines': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
};

const configFileOverrides = {
  files: [
    '**/*.config.{js,ts,mjs}',
    'eslint.config.js',
    'vitest.config.ts',
    'packages/eslint-config/index.js',
  ],
  rules: {
    'import-x/no-default-export': 'off',
  },
};

export default [raftRules, testOverrides, configFileOverrides];
