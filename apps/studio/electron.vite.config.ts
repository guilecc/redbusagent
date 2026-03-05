import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const sharedStudioEntry = resolve('../../packages/shared/src/types/studio.ts');

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: {
                '@redbusagent/shared/studio': sharedStudioEntry,
            },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: {
                '@redbusagent/shared/studio': sharedStudioEntry,
            },
        },
    },
    renderer: {
        resolve: {
            alias: {
                '@renderer': resolve('src/renderer/src'),
                '@redbusagent/shared/studio': sharedStudioEntry,
            },
        },
        plugins: [react()],
    },
});