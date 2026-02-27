import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            '@redbusagent/shared': resolve(__dirname, '../shared/src/index.ts'),
        },
    },
    test: {
        exclude: ['dist/**', 'node_modules/**'],
        server: {
            deps: {
                inline: ['@redbusagent/shared'],
            },
        },
    },
});

