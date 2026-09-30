import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source (ADR 0005).
  transpilePackages: ['@vorasaan/shared'],
};

export default config;
