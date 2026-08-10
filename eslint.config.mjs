import js from '@eslint/js';
import globals from 'globals';

const rules = {
  ...js.configs.recommended.rules,
  eqeqeq: ['error', 'smart'],
  'no-empty': 'off', // empty catch blocks intentionally make teardown best-effort
  'no-useless-assignment': 'off', // last-snapshot bookkeeping aids failure output
  'no-unused-vars': ['error', { args: 'none' }], // wrapper arity mirrors native APIs
  'no-var': 'off', // classic extension scripts deliberately expose one guarded SQZ global
};

export default [
  { ignores: ['.cft/**', 'node_modules/**'] },
  {
    files: ['background.js', 'shared/**/*.js', 'content/**/*.js', 'options/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        chrome: 'readonly',
        importScripts: 'readonly',
      },
    },
    rules,
  },
  {
    files: ['background.js', 'options/options.js'],
    languageOptions: { globals: { SQZ: 'readonly' } },
  },
  {
    files: ['test/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        WebSocket: 'readonly',
      },
    },
    rules,
  },
];
