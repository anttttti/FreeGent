import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals:     true,
        environment: 'jsdom',
        setupFiles:  ['./tests/setup.js'],
        include:     ['tests/**/*.{test,spec}.{js,ts}'],
        exclude:     ['.claude/**', 'node_modules/**', 'tmp/**', 'FreeGent_refactored/**'],
    },
});
