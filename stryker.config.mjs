// Mutation testing for the schema and decode code. Run with `npx stryker run`.
//
// Scope is deliberately narrow: the modules that turn schemas into readers and
// bytes into values, plus the module-level schema helpers and the
// service-response decoders in FoxgloveClient. Socket handling is left out on
// purpose: a mutant that survives there mostly says something about
// MockWebSocket, not about the client.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.config.ts' },
  coverageAnalysis: 'perTest',
  mutate: [
    'src/builtinSchemas.ts',
    'src/schemaName.ts',
    'src/schemaToTemplate.ts',
    'src/jsonSchemaToTemplate.ts',
    'src/materializeBytes.ts',
    'src/protobufReader.ts',
    // Module-level helpers: base64, goal UUIDs, fieldless and empty-request
    // detection, action-wrapper lifting, schema parsing and resolution.
    'src/FoxgloveClient.ts:87-562',
    // decodeServiceResponse and decodeCdrServiceResponse.
    'src/FoxgloveClient.ts:3052-3128',
  ],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
};
