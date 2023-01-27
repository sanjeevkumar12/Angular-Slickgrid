import { defineConfig } from 'cypress';
import fs from 'fs';

import plugins from './plugins/index';

export default defineConfig({
  video: false,
  viewportWidth: 1200,
  viewportHeight: 950,
  fixturesFolder: 'fixtures',
  projectId: 'hqnfoi',
  screenshotsFolder: 'screenshots',
  videosFolder: 'videos',
  numTestsKeptInMemory: 5,
  retries: {
    runMode: 2,
    openMode: 0,
  },
  e2e: {
    baseUrl: 'http://localhost:4300/#',
    specPattern: 'e2e/**/*.cy.{js,ts}',
    supportFile: 'support/index.ts',
    excludeSpecPattern: process.env.CI ? ['**/node_modules/**', '**/000-*.cy.{js,ts}'] : ['**/node_modules/**'],
    setupNodeEvents(on, config) {
      on('task', {
        updateListOfTests() {
          const UPDATE_TESTS_LIST_CY_TS = '000-update-tests-list.cy.ts';
          const RUN_ALL_TESTS_CY_TS = '000-run-all-specs.cy.ts';
          const PATHNAME_OF_RUN_ALL_TESTS_CY_TS =
            './e2e/' + RUN_ALL_TESTS_CY_TS;

          const testsOnDisk = fs
            .readdirSync('./e2e/')
            .filter(filename => filename.endsWith('.cy.ts'))
            .filter(
              filename =>
                ![UPDATE_TESTS_LIST_CY_TS, RUN_ALL_TESTS_CY_TS].includes(
                  filename
                )
            );
          const scriptImportingAllTests =
            `// This script was autogenerated by ${UPDATE_TESTS_LIST_CY_TS}\n` +
            testsOnDisk.map(test => `import './${test}'`).join('\n');
          fs.writeFileSync(
            PATHNAME_OF_RUN_ALL_TESTS_CY_TS,
            scriptImportingAllTests
          );
          return true;
        },
      });
      return plugins(on, config);
    },
  },
});