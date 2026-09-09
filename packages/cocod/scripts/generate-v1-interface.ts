import packageJson from '../package.json' with { type: 'json' };
import { createV1RouteMetadata } from '../src/v1/http.js';
import { generateV1OpenApiDocument } from '../src/v1/interface-description.js';

// Export on demand; the authenticated HTTP endpoint uses this same generator.
console.log(
  JSON.stringify(generateV1OpenApiDocument(createV1RouteMetadata(), packageJson.version), null, 2),
);
