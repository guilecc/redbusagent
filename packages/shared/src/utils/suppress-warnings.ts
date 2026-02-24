/**
 * Global Warning Suppressor
 * Suppresses annoying Node.js deprecation warnings (e.g., punycode) from third-party libraries.
 */
const originalEmitWarning = process.emitWarning;

process.emitWarning = function (warning: string | Error, ...args: any[]) {
    if (typeof warning === 'string' && warning.includes('punycode')) {
        return;
    }

    if (warning instanceof Error && warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
        return;
    }

    // @ts-ignore
    return originalEmitWarning.call(process, warning, ...args);
};
