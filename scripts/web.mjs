import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { checkTree, copyInput, publishDirectory, stagingDirectory } from './safe-files.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const contentSecurityPolicy = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; worker-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

export async function buildWeb(destination = path.join(root, 'dist'), { testBuild = false } = {}) {
  const stage = stagingDirectory(root);
  try {
    const input = path.join(stage, 'input'), output = path.join(stage, 'web');
    for (const name of ['index.html', 'src', 'public', 'package.json', 'node_modules/three']) {
      copyInput(root, path.join(root, name), path.join(input, name));
    }
    await build({
      root: input, base: './', configFile: false, envDir: false, cacheDir: path.join(stage, 'cache'),
      build: { outDir: output, emptyOutDir: false },
      define: { __THERMAL_TEST_BUILD__: JSON.stringify(testBuild) },
      plugins: [{
        name: 'thermal-web-content-security-policy',
        transformIndexHtml: () => [{
          tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy }, injectTo: 'head-prepend',
        }],
      }],
    });
    checkTree(root, output);
    publishDirectory(root, output, destination);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) await buildWeb();
