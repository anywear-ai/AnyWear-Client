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
);
