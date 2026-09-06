import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Flat config for the whole repo — client, server and build scripts.
 *
 * Deliberately narrow: TypeScript already catches undefined identifiers, wrong
 * types and most typos on every build, so ESLint here exists for the things the
 * compiler cannot see — stale hook dependency arrays, dead bindings, and React's
 * rules of hooks. Rules that would only restyle working code are off.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "dev-dist/**",
      "node_modules/**",
      "data/**",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // TypeScript resolves identifiers itself, and the base rule cannot see
      // type-only names — it reports false positives on every interface.
      "no-undef": "off",

      // `any` is used deliberately at the untyped boundaries: driver result
      // rows, `better-sqlite3` statements and JSON columns. Flagging 200 of
      // them would train everyone to ignore the linter.
      "@typescript-eslint/no-explicit-any": "off",

      // `_`-prefixed bindings are the convention for a value that has to be
      // destructured but not read.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // `declare global { namespace Express { … } }` is the only way to augment
      // the Express Request type (server/middleware/auth.ts).
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
    },
  },

  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // Advisory, not blocking: the React Compiler rules flag patterns that are
      // wrong in principle but working in practice here. Warnings keep them
      // visible without making `npm run lint` a wall of red to be ignored.
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
    },
  },
);
