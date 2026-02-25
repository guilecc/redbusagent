import { Vault } from '@redbusagent/shared';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const storagePath = join(Vault.dir, 'scheduler.json');
console.log('Vault.dir:', Vault.dir);
console.log('storagePath:', storagePath);
try {
    writeFileSync(storagePath, '[]', 'utf-8');
    console.log('Saved to disk successfully.');
} catch (e) {
    console.error('Error saving to disk:', e.message);
}
