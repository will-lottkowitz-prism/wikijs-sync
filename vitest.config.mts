import { defineConfig } from 'vitest/config';

// Unit tests for the pure (no VS Code API) logic — pathmap + pageFile.
export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts'],
    globals: true,
  },
});
