import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Most outbound tests are written against the H/L layout with ISO dates; the server's default
    // is now the SAP team's flat file. Tests of the flat file set it themselves.
    env: { CSV_LAYOUT: 'single_file', CSV_DATE_FORMAT: 'iso' },
  },
});
