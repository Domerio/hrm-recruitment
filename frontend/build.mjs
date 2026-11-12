import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: ['frontend/main.jsx'],
  outfile: 'static/workbench.js',
  bundle: true,
  jsx: 'automatic',
  minify: true,
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'eof',
  logLevel: 'info',
  plugins: [{
    name: 'workbench-style-nonce',
    setup({ onLoad }) {
      // The table measurement and modal scroll lock use this injector without ConfigProvider's nonce.
      onLoad({ filter: /[\\/]@rc-component[\\/]util[\\/]es[\\/]Dom[\\/]dynamicCSS\.js$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const options = /csp,\s+prepend,/;
        if (!options.test(source)) throw new Error('Check the Ant Design style injector after updating dependencies.');
        return {
          contents: source.replace(options, `csp = { nonce: document.querySelector('meta[name="style-nonce"]')?.content },
    prepend,`),
        };
      });
    },
  }],
});
