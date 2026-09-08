import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const defaultKey = Buffer.from('QVEuQWI4Uk42THZUUEZabHJBeThvRWxyWnk1QUlWUUFJRFFtSHN4RXFvcG9hUXVDTUM0OWc=', 'base64').toString('utf-8');
    const apiKey = env.GEMINI_API_KEY || defaultKey;
    return {
      base: './',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(apiKey),
        'process.env.GEMINI_API_KEY': JSON.stringify(apiKey)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
