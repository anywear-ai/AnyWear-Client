import eslint from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Orval output is validated by regeneration and TypeScript compilation.
    // `dist-smoke` and the Rust build target are build output, not source; a
    // Tauri codegen step emits a JS asset under `src-tauri/target`.
    ignores: ['dist/**', 'dist-smoke/**', 'src-tauri/target/**', 'src/api/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  {
    // Test doubles occasionally need to cross deliberately untyped boundaries.
    files: ['**/*.test.{ts,tsx}', 'browser/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Playwright fixtures name their callback argument `use`; browser mocks patch readonly APIs.
    files: ['browser/**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    // #356: `.mjs` scripts were traversed with no rules before this block; this
    // block puts the module's read policy on the same script files.
    files: ['scripts/**/*.mjs'],
    ignores: ['scripts/created-run-read.mjs', '**/*.node-test.mjs'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^repos\\/[^/]+\\/[^/]+\\/actions\\/runs\\/(?:[^/]+)?$/]',
          message: 'Call readCreatedRunById() from scripts/created-run-read.mjs: the module owns the 404 retry, the identity check and the failure message.',
        },
        {
          selector: 'TemplateElement[value.raw=/repos\\/$/] ~ TemplateElement[value.raw="/actions/runs/"]:nth-last-child(2) ~ TemplateElement[value.raw=""]:last-child',
          message: 'Call readCreatedRunById() from scripts/created-run-read.mjs: the module owns the 404 retry, the identity check and the failure message.',
        },
        {
          selector: 'TemplateElement[value.raw=/^repos\\/[^/]+\\/[^/]+\\/actions\\/runs\\/(?:[^/]+)?$/]:nth-last-child(2) ~ TemplateElement[value.raw=""]:last-child',
          message: 'Call readCreatedRunById() from scripts/created-run-read.mjs: the module owns the 404 retry, the identity check and the failure message.',
        },
        {
          selector: 'TemplateElement[value.raw=/^repos\\/[^/]+\\/[^/]+\\/actions\\/runs\\/[^/]+$/]:first-child:last-child',
          message: 'Call readCreatedRunById() from scripts/created-run-read.mjs: the module owns the 404 retry, the identity check and the failure message.',
        },
      ],
    },
  },
);
