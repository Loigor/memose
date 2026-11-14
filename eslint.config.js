import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "release/", "src-tauri/", "test-results/", "playwright-report/", "node_modules/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["tests/**/*.ts", "*.config.ts", "release/**/*.mjs", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // main.ts declares controllers with `let x!` so earlier closures can reference them before assignment.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  prettier,
);
