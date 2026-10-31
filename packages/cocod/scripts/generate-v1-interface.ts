import { format, resolveConfig } from 'prettier';

import packageJson from '../package.json' with { type: 'json' };
import { createV1RouteMetadata, generateV1OpenApiDocument } from '../src/v1/http.js';

// The committed document is the reviewable contract; `GET /v1/openapi.json` serves the same output.
const outputPath = new URL('../docs/openapi-v1.json', import.meta.url);
const description = generateV1OpenApiDocument(createV1RouteMetadata(), packageJson.version);
const prettierConfig = (await resolveConfig(outputPath.pathname)) ?? {};
const output = await format(JSON.stringify(description), {
  ...prettierConfig,
  parser: 'json',
});

if (process.argv.includes('--check')) {
  const checkedIn = await Bun.file(outputPath)
    .text()
    .catch(() => '');
  if (checkedIn !== output) {
    console.error('docs/openapi-v1.json is out of date; run bun run generate:interface');
    process.exit(1);
  }
} else {
  await Bun.write(outputPath, output);
}
