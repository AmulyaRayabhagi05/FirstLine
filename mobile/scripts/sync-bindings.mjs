// The resident app talks to the same SpacetimeDB module as the dashboard. Its generated bindings
// live in web/src/module_bindings (regenerated when the module changes); copy them here so this
// app has its own copy built against its own spacetimedb package.
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, '..', 'web', 'src', 'module_bindings');
const to = join(root, 'src', 'module_bindings');
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log('bindings copied from web/src/module_bindings');
