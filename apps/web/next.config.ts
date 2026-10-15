import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source (ADR 0005).
  transpilePackages: ['@vorasaan/shared'],
  turbopack: {
    rules: {
      // React Aria's string tables, cut to the locales the app speaks (en and th).
      'intlStrings.mjs': {
        condition: { path: /\/react-(aria|aria-components|stately)\/dist\// },
        loaders: [fileURLToPath(new URL('./lib/react-aria-locales-loader.js', import.meta.url))],
      },
    },
  },
};

export default config;
