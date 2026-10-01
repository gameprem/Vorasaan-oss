/**
 * Builds the single-file `vorasaan` binary. Ink only loads React DevTools
 * (`react-devtools-core`, `ws`) when DEV=true and they are installed; neither is
 * a dependency, so they are replaced by empty modules instead of failing the bundle.
 */
const OPTIONAL = /^(react-devtools-core|ws)$/;

const result = await Bun.build({
  entrypoints: [new URL('../src/index.ts', import.meta.url).pathname],
  compile: { outfile: new URL('../dist/vorasaan', import.meta.url).pathname },
  plugins: [
    {
      name: 'no-devtools',
      setup(build) {
        build.onResolve({ filter: OPTIONAL }, (args) => ({ path: args.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default {};',
          loader: 'js',
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log('Built apps/cli/dist/vorasaan');
