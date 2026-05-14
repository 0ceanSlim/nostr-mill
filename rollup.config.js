import resolve  from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser   from '@rollup/plugin-terser';

const banner = `/*!
 * nostr-mill — Multi-Interface Login Layer
 * https://github.com/0ceanslim/nostr-mill
 * MIT License
 */`;

const input = 'src/mill-core.js';

export default [
  // ESM (tree-shakeable, for bundlers; nostr-tools left external)
  {
    input,
    output: { file: 'dist/mill.esm.js', format: 'es', banner, sourcemap: true },
    plugins: [resolve(), commonjs()],
    external: id => /^nostr-tools(\/|$)/.test(id),
  },

  // CJS (Node / SSR; nostr-tools left external)
  {
    input,
    output: { file: 'dist/mill.cjs.js', format: 'cjs', exports: 'named', banner, sourcemap: true },
    plugins: [resolve(), commonjs()],
    external: id => /^nostr-tools(\/|$)/.test(id),
  },

  // UMD unminified (CDN, debug-friendly; bundles nostr-tools)
  {
    input: 'src/umd-entry.js',
    output: { file: 'dist/mill.umd.js', format: 'umd', name: 'MILL', exports: 'default', banner, sourcemap: true },
    plugins: [resolve({ browser: true, preferBuiltins: false }), commonjs()],
  },

  // UMD minified (CDN, production)
  {
    input: 'src/umd-entry.js',
    output: { file: 'dist/mill.umd.min.js', format: 'umd', name: 'MILL', exports: 'default', banner, sourcemap: true },
    plugins: [
      resolve({ browser: true, preferBuiltins: false }),
      commonjs(),
      terser({ compress: { drop_console: false }, format: { comments: /^!/ } }),
    ],
  },

  // Themes standalone
  {
    input: 'src/themes.js',
    output: { file: 'dist/themes.js', format: 'es', banner },
  },
];
