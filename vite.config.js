import { defineConfig } from 'vite';
export default defineConfig({ base:'./', server:{host:'127.0.0.1',port:5220,strictPort:true,watch:{ignored:['**/output/**','**/release/**','**/dist/**']}} });
