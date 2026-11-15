// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `src/generated/` is written by `pnpm generate:client` and never edited by
  // hand, so a lint rule can only ever be satisfied by editing it. `tsc` still
  // covers it; see tsconfig.json.
  { ignores: ['dist/**', 'src/generated/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The tests install fake browser globals on `globalThis` and reach into
    // them with casts; the SDK itself must not.
    files: ['test/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['**/*.mjs', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
)
