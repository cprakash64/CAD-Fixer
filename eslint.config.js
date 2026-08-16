import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * Beyond the usual correctness rules, this file mechanically enforces two
 * project invariants that would otherwise rely on reviewer memory:
 *
 * 1. NETWORK SILENCE — the browser's network APIs are banned outright. CAD
 *    Fixer must not transmit anything, and the cheapest way to keep that true
 *    is to make an accidental `fetch` fail CI. Lifting this requires an ADR.
 * 2. LAYER SEPARATION — geometry packages may not import UI libraries, and no
 *    package may reach into the application.
 */

const networkGlobals = [
  {
    name: 'fetch',
    message: 'CAD Fixer does not make network requests. See docs/PRIVACY_ARCHITECTURE.md.',
  },
  {
    name: 'XMLHttpRequest',
    message: 'CAD Fixer does not make network requests. See docs/PRIVACY_ARCHITECTURE.md.',
  },
  {
    name: 'WebSocket',
    message: 'CAD Fixer does not open network connections. See docs/PRIVACY_ARCHITECTURE.md.',
  },
  {
    name: 'EventSource',
    message: 'CAD Fixer does not open network connections. See docs/PRIVACY_ARCHITECTURE.md.',
  },
];

const noBeacon = {
  selector: "MemberExpression[object.name='navigator'][property.name='sendBeacon']",
  message: 'Beacons exfiltrate data silently and are banned. See docs/PRIVACY_ARCHITECTURE.md.',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      // Stage 3A-2 bakeoff: third-party sources and the Emscripten SDK are
      // fetched, not authored here. Our own scripts and bindings under
      // experiments/ ARE linted; only the fetched trees are excluded.
      'experiments/repair-kernels/.toolchain/**',
      'experiments/repair-kernels/*/upstream/**',
      'experiments/repair-kernels/*/build/**',
      // The native Geogram reference build tree. CMake emits stub files named
      // `compiler_depend.ts` which are Makefile fragments, not TypeScript, and
      // the parser chokes on them.
      'experiments/repair-kernels/*/build-native/**',
      'experiments/repair-kernels/*/artifacts/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-globals': ['error', ...networkGlobals],
      'no-restricted-syntax': ['error', noBeacon],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: false, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Empty catch blocks and bare rethrows hide failures; the project rule is
      // that errors are surfaced as typed AppErrors.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // Geometry and format packages are platform- and framework-free.
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', 'react/*', 'react-dom/*'],
              message: 'Geometry and format packages must not depend on the UI framework.',
            },
            {
              group: ['three', 'three/*'],
              message: 'Three.js is a rendering concern. The canonical mesh must not depend on it.',
            },
            {
              group: ['@cadfixer/web', '../../apps/*', '../../../apps/*'],
              message: 'Packages must not import from the application.',
            },
          ],
        },
      ],
    },
  },

  // React application code.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    // `configs.flat.*` is the flat-config form; `configs['recommended-latest']`
    // is still the legacy eslintrc shape and is rejected by ESLint 10.
    ...reactHooks.configs.flat['recommended-latest'],
  },

  // Node-hosted tooling and end-to-end specs.
  {
    files: ['*.config.ts', 'e2e/**/*.ts', 'eslint.config.js'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-restricted-globals': 'off',
    },
  },

  // Plain JS and .mjs live outside any tsconfig, so type-aware rules cannot run
  // against them. `.mjs` is included because the Stage 3A-2 experiment scripts
  // must be runnable by a bare `node` with no build step.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Node-hosted scripts that must run as plain JavaScript.
  //
  // `scripts/check-node-version.js` cannot be TypeScript: it guards the project
  // against unsupported runtimes and therefore has to execute before any build
  // or loader exists. `explicit-function-return-type` is turned off for these
  // files only because JavaScript has no return-type syntax to satisfy it —
  // the types are declared in the accompanying `.d.ts`, which IS checked.
  {
    files: ['scripts/**/*.js', 'experiments/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-restricted-globals': 'off',
    },
  },

  prettier,
);
