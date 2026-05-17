/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: ['./tsconfig.json'],
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  settings: {
    'import/resolver': {
      typescript: { project: './tsconfig.json' },
      node: true,
    },
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    'import/no-default-export': 'off',
    'import/order': [
      'warn',
      {
        groups: ['builtin', 'external', 'parent', 'sibling', 'index'],
        'newlines-between': 'never',
      },
    ],
    'no-restricted-globals': [
      'error',
      { name: 'Buffer', message: 'Buffer is Node-only. Use Uint8Array.' },
      { name: '__DEV__', message: '__DEV__ is React Native only. Inject behavior via ProtocolClientOptions.' },
      { name: 'process', message: 'process is Node-only. Inject behavior via ProtocolClientOptions.' },
    ],
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: ['react-native', 'react-native/*'], message: 'react-native is forbidden in package code.' },
          { group: ['expo', 'expo/*', '@expo/*'], message: 'Expo packages are forbidden in package code.' },
          { group: ['fs', 'path', 'os', 'child_process', 'cluster', 'worker_threads', 'crypto', 'net', 'tls', 'http', 'https'], message: 'Node.js builtins are forbidden in package code.' },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['tests/**/*.ts', 'tests/**/*.tsx', 'examples/**/*.ts', 'vitest.config.ts', 'tsup.config.ts'],
      rules: {
        'no-restricted-globals': 'off',
        'no-restricted-imports': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      files: ['src/index.ts'],
      rules: {
        'import/no-default-export': 'off',
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', '*.cjs', '*.mjs', 'coverage', 'docs'],
};
