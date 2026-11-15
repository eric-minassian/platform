// Regenerates platform.schema.json (editor completion for apps' platform.json).
// Run: node scripts/schema.ts
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ManifestSchema } from '../src/manifest.ts';

const schema = z.toJSONSchema(ManifestSchema, { io: 'input', unrepresentable: 'any' });
const out = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://raw.githubusercontent.com/eric-minassian/platform/main/packages/core/platform.schema.json',
  title: 'platform.json',
  description: 'What an app needs from the platform. See docs/DESIGN.md.',
  ...schema,
};
writeFileSync(new URL('../platform.schema.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log('wrote platform.schema.json (run biome format after regenerating)');
