import { checkedPath, readInput, copyInput, stagingDirectory, publishDirectory, writeArtifact, checkTree } from './safe-files.mjs';
import { buildWeb } from './web.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['start', 'package', 'package-test', 'package-release', 'prepare-test'].includes(mode)) {
  throw new Error('Use start, package, package-test, package-release or prepare-test');
}
const testBuild = mode === 'package-test' || mode === 'prepare-test';
const signed = mode === 'package-release';
const thumbprint = process.env.THERMAL_WINDOWS_SIGNER_THUMBPRINT?.trim();
if (signed && (process.platform !== 'win32' || !/^[a-f0-9]{40}$/i.test(thumbprint ?? ''))) {
  throw new Error('A Windows release requires THERMAL_WINDOWS_SIGNER_THUMBPRINT with the approved certificate thumbprint');
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (!signed) {
  delete env.WIN_CSC_LINK;
  delete env.CSC_LINK;
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`)));
  });
}

async function verifyFuses(executable) {
  const wire = await getCurrentFuseWire(executable);
  const expected = {
    RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: testBuild, EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true, GrantFileProtocolExtraPrivileges: false,
  };
  for (const [name, enabled] of Object.entries(expected)) {
    if (wire[FuseV1Options[name]] !== (enabled ? 0x31 : 0x30)) throw new Error(`Unexpected Electron fuse: ${name}`);
  }
  console.log('Verified Electron fuses in the packaged executable.');
}

const electronPackage = path.dirname(require.resolve('electron/package.json'));
checkTree(root, electronPackage);
await run(process.execPath, [path.join(electronPackage, 'install.js')]);

if (mode === 'start' || mode === 'prepare-test') {
  await buildWeb(path.join(root, testBuild ? 'dist-desktop-test' : 'dist'), { testBuild });
  if (mode === 'start') await run(require('electron'), [root]);
} else {
  const stage = stagingDirectory(root);
  try {
    const app = path.join(stage, 'app'), output = path.join(stage, 'windows');
    const configuration = JSON.parse(readInput(root, path.join(root, 'electron-builder.json')));
    const packageInfo = JSON.parse(readInput(root, path.join(root, 'package.json')));
    const inputs = [...new Set(['desktop', configuration.directories.buildResources,
      ...configuration.files.filter(file => !file.includes('*') && file !== 'package.json'),
      ...configuration.extraResources.map(item => item.from)])];
    for (const input of inputs.filter(file => !inputs.some(parent => file !== parent && file.startsWith(parent + '/')))) {
      copyInput(root, path.join(root, input), path.join(app, input));
    }
    if (testBuild) packageInfo.thermalTestBuild = true;
    writeArtifact(root, path.join(app, 'package.json'), JSON.stringify(packageInfo));
    await buildWeb(path.join(app, 'dist'), { testBuild });
    const electronDist = checkedPath(root, path.join(electronPackage, 'dist'));
    checkTree(root, electronDist);
    configuration.electronDist = electronDist;
    configuration.electronVersion = packageInfo.devDependencies.electron;
    configuration.directories.output = output;
    configuration.npmRebuild = false;
    configuration.forceCodeSigning = signed;
    if (testBuild) configuration.electronFuses.enableNodeCliInspectArguments = true;
    const config = path.join(stage, 'electron-builder.json');
    writeArtifact(root, config, JSON.stringify(configuration));
    const builder = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
    await run(process.execPath, [builder, '--win', '--x64', ...(testBuild ? ['--dir'] : []),
      '--config', config, '--projectDir', app, '--publish', 'never']);
    const executable = checkedPath(root, path.join(output, 'win-unpacked', 'Thermal Lab.exe'));
    await verifyFuses(executable);
    if (!testBuild) {
      const file = path.join(output, `Thermal-Lab-Setup-${packageInfo.version}.exe`);
      if (signed) {
        const verifier = checkedPath(root, path.join(root, 'scripts', 'verify-signature.ps1'));
        const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        for (const target of [executable, checkedPath(root, file)]) {
          await run(powershell, ['-NoProfile', '-NonInteractive', '-File', verifier, '-Target', target, '-Thumbprint', thumbprint]);
        }
      }
      writeArtifact(root, file + '.sha256', `${createHash('sha256').update(readInput(root, file)).digest('hex')}  ${path.basename(file)}\n`);
    }
    const directory = signed ? 'windows-signed' : testBuild ? 'windows-test' : 'windows';
    checkTree(root, output);
    publishDirectory(root, output, path.join(root, 'release', directory));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
