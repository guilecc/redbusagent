import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function prepareNativeRebuild(appDir = process.cwd()) {
  let cpuFeaturesPackageJson;

  try {
    const appRequire = createRequire(join(appDir, 'package.json'));
    cpuFeaturesPackageJson = appRequire.resolve('cpu-features/package.json');
  } catch {
    console.log('[studio] cpu-features not installed; skipping native rebuild prep.');
    return true;
  }

  const packageDir = dirname(cpuFeaturesPackageJson);
  const buildcheckScript = join(packageDir, 'buildcheck.js');
  const buildcheckGypi = join(packageDir, 'buildcheck.gypi');

  if (!existsSync(buildcheckScript)) {
    console.log('[studio] cpu-features buildcheck.js missing; skipping native rebuild prep.');
    return true;
  }

  const { stdout } = await execFileAsync(process.execPath, [buildcheckScript], {
    cwd: packageDir,
  });

  await writeFile(buildcheckGypi, stdout);
  console.log(`[studio] refreshed ${buildcheckGypi}`);
  return true;
}

export default async function beforeBuild({ appDir } = {}) {
  return prepareNativeRebuild(appDir);
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await prepareNativeRebuild();
}