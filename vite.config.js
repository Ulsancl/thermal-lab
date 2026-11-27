import { defineConfig } from 'vite';

const internal = ['**/.security-stage-*', '**/.security-stage-*/**', '**/output/**', '**/release/**', '**/dist/**', '**/dist-desktop-test/**'];

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
