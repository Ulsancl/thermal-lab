import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';

const root = normalizePath(fileURLToPath(new URL('./', import.meta.url))).replace(/[[\]{}()*?!+]/g, '\\$&');
const internal = ['.security-stage-*', 'output', 'release', 'dist', 'dist-desktop-test']
  .flatMap(name => [root + name, root + name + '/**']);

export default defineConfig({
  base: './',
  define: { __THERMAL_TEST_BUILD__: 'true' },
  server: {
    host: '127.0.0.1',
    port: 5220,
    strictPort: true,
    watch: { ignored: internal },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...internal] },
  },
});
