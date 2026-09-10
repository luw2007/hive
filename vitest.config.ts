import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    include: ['tests/**/*.test.{js,ts,tsx}'],
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/sqlite-schema-v*.ts'],
    },
  },
})
