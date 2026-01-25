/// <reference types="vitest" />
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['server/**/*.ts'],
            exclude: ['server/vite.ts', 'server/static.ts'],
        },
    },
    resolve: {
        alias: {
            '@shared': path.resolve(__dirname, './shared'),
        },
    },
});
