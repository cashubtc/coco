import { format, resolveConfig } from 'prettier';

import packageJson from '../package.json' with { type: 'json' };
import { createV1RouteMetadata } from '../src/v1/http.js';
import { generateV1InterfaceDescription } from '../src/v1/interface-description.js';

const outputPath = new URL('../docs/lifecycle-api-v1.json', import.meta.url);
const description = generateV1InterfaceDescription(createV1RouteMetadata(), packageJson.version);
const prettierConfig = (await resolveConfig(outputPath.pathname)) ?? {};
const output = await format(JSON.stringify(description), {
  ...prettierConfig,
  parser: 'json',
});

if (process.argv.includes('--check')) {
  const checkedIn = await Bun.file(outputPath).text();
  if (checkedIn !== output) {
    console.error('lifecycle-api-v1.json is out of date; run bun run generate:interface');
    process.exit(1);
  }
} else {
  await Bun.write(outputPath, output);
}
