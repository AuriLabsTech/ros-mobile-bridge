import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2020',
  // Bundled rather than imported: the code needs its `/wkt`, `/wire` and
  // `/reflect` subpath exports, which Metro resolves by default only from
  // React Native 0.79. Notices in THIRD_PARTY_NOTICES.md.
  noExternal: ['@bufbuild/protobuf'],
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
});
