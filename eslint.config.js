import eslint from '@eslint/js';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

const bareNodeBuiltins = builtinModules.filter(
  (specifier) => !specifier.startsWith('node:'),
);

export default tseslint.config(
  {
    ignores: ['**/coverage/**', '**/dist/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/contracts/src/**/*.ts'],
    ignores: ['packages/contracts/src/conformance/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'Buffer',
          message: 'The contracts root runtime must stay browser-compatible.',
        },
        {
          name: 'process',
          message: 'The contracts root runtime must stay browser-compatible.',
        },
        ...[
          'global',
          '__dirname',
          '__filename',
          'require',
          'module',
          'setImmediate',
        ].map((name) => ({
          name,
          message: 'The contracts root runtime must stay browser-compatible.',
        })),
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                'Node builtins belong under src/conformance or build/test tooling.',
            },
          ],
          paths: bareNodeBuiltins,
        },
      ],
    },
  },
);
