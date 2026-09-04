import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Known, tracked debt rather than accepted style. These are warnings so
      // that CI fails on genuine errors instead of on a backlog everyone has
      // learned to scroll past. See the "code quality" issues in the tracker.

      // Was ~28 sites of untyped marketplace API responses; all of them now have
      // response types (see src/services/*.ts). Kept as an error so a renamed
      // marketplace field fails the build instead of silently becoming undefined.
      '@typescript-eslint/no-explicit-any': 'error',

      // Files that export both a component and its helpers. Costs fast refresh
      // granularity in development; harmless in a build.
      'react-refresh/only-export-components': 'warn',

      // Several effects deliberately omit dependencies to run once, and the
      // rule cannot tell those from real omissions. Each needs reading.
      'react-hooks/exhaustive-deps': 'warn',

      // Fires on the ordinary "load data on mount" shape, where setState
      // happens after an await rather than synchronously.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
