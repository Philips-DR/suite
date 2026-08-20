// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// recommendedTypeChecked, not strictTypeChecked: strict fights this codebase's own established idiom
// (a `!` non-null assertion once an index/lookup has already been checked, used consistently
// throughout emit/ index arithmetic) rather than catching real bugs. recommended still keeps the
// type-aware rules that DO catch real bugs — floating promises, unsafe `any` flow — without
// re-litigating a style already chosen on purpose.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // eslint.config.js itself isn't part of tsconfig.json's include (src/test only, on purpose —
        // it's a tooling file, not project source). allowDefaultProject lets typescript-eslint parse
        // just this one file against an implicit standalone config instead of erroring.
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md: "No any, no untyped object literals — the compiler checking request shapes is the
      // main reason this project is in TypeScript." Already 'warn' in recommended; this is that rule.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
)
