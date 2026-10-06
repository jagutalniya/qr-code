// Rebuilds js/vendor/ from the npm packages listed in package.json.
// Only needed when you want to upgrade the bundled libraries:  npm install && npm run vendor
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'js', 'vendor');
await mkdir(out, { recursive: true });

// qrcode ships no browser bundle, so bundle its browser entry into a global `QRCode`.
await build({
  entryPoints: [require.resolve('qrcode/lib/browser.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'QRCode',
  outfile: join(out, 'qrcode.min.js'),
  legalComments: 'none',
});

// jsQR already ships a UMD build that defines a global `jsQR`.
await copyFile(require.resolve('jsqr/dist/jsQR.js'), join(out, 'jsQR.js'));
await copyFile(join(dirname(require.resolve('qrcode/package.json')), 'license'), join(out, 'qrcode.LICENSE'));
await copyFile(join(dirname(require.resolve('jsqr/package.json')), 'LICENSE'), join(out, 'jsQR.LICENSE'));

console.log('Vendor files written to js/vendor/');
