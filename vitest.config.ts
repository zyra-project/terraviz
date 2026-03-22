import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    // Default environment — pure-logic tests (time.ts, dataService.ts)
    environment: 'node',
    // DOM-dependent services opt in via the inline docblock comment
    // `// @vitest-environment happy-dom`
    environmentMatchGlobs: [
      ['src/services/**/*.test.ts', 'happy-dom'],
    ],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './coverage/junit.xml',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/main.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
