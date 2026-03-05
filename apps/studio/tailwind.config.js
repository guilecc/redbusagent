/** @type {import('tailwindcss').Config} */
export default {
    content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
    theme: {
        extend: {
            colors: {
                studio: {
                    bg: '#050816',
                    panel: '#0b1220',
                    accent: '#ef4444',
                    muted: '#94a3b8',
                },
            },
        },
    },
    plugins: [],
};