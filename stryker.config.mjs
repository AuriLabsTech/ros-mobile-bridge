// Mutation testing for the schema and decode code. Run with `npx stryker run`.
//
// Scope is deliberately narrow: the modules that turn schemas into readers and
// bytes into values, plus the module-level schema helpers and the
// service-response decoders in FoxgloveClient. Socket handling is left out on
// purpose: a mutant that survives there mostly says something about
// MockWebSocket, not about the client.

import { readFileSync } from 'node:fs';

const FOXGLOVE = 'src/FoxgloveClient.ts';
const foxgloveLines = readFileSync(new URL(FOXGLOVE, import.meta.url), 'utf8').split('\n');

/** 1-based number of the first line at or after `from` that starts with `prefix`. */
function lineStarting(prefix, from = 1) {
  const index = foxgloveLines.findIndex((line, i) => i >= from - 1 && line.startsWith(prefix));
  if (index < 0) throw new Error(`stryker.config.mjs: no line starting "${prefix}" in ${FOXGLOVE}`);
  return index + 1;
}

// The FoxgloveClient ranges follow anchors in the source, so they stay right
// as the file changes; a renamed anchor fails the run instead of mutating the
// wrong lines.
// Module-level helpers: base64, goal UUIDs, fieldless and empty-request
// detection, action-wrapper lifting, schema parsing and resolution.
const helpersStart = lineStarting('const TEXT_ENCODER');
const helpersEnd = lineStarting('// ─── Constants', helpersStart) - 1;
// decodeServiceResponse and decodeCdrServiceResponse.
const decodersStart = lineStarting('  private decodeServiceResponse(');
const decodersEnd = lineStarting(
  '  }',
  lineStarting('  private decodeCdrServiceResponse(', decodersStart),
);

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
    `${FOXGLOVE}:${helpersStart}-${helpersEnd}`,
    `${FOXGLOVE}:${decodersStart}-${decodersEnd}`,
  ],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
};
