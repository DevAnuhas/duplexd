import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/drizzle/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The workspace app runs on both the server and the client. These globals
    // come from Next's runtime rather than being declared per file.
    files: ['apps/workspace/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      /**
       * One icon set, enforced rather than agreed.
       *
       * Phosphor is the icon set; `lucide-react` is not to be used anywhere.
       * A convention that lives only in a message is one a future import
       * quietly breaks — shadcn's own `add` command emits Lucide imports, so
       * the next primitive anyone installs reintroduces it by default. This
       * turns that into a lint failure at the moment it happens.
       */
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lucide-react',
              message:
                'Use @phosphor-icons/react instead. Lucide is not used in this project.',
            },
          ],
        },
      ],
    },
  },
);
