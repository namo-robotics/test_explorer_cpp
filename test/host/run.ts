import { runTests } from '@vscode/test-electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function command(program: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'inherit' }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`)));
  });
}
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-explorer-host-'));
  try {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
    await command('cmake', ['-S', path.resolve('test/fixtures/cmake'), '-B', path.join(workspace, 'build'), '-DCMAKE_BUILD_TYPE=Debug']);
    await command('cmake', ['--build', path.join(workspace, 'build'), '-j2']);
    await fs.writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
      'cppTestExplorer.autoSourceWorkspace': false,
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
      'cppTestExplorer.debug': { lldb: { terminal: 'console' }, cppdbg: { externalConsole: false } },
    }));
    const extensions = path.join(root, 'extensions'); await fs.mkdir(extensions);
    const debugExtensions = (process.env.CPP_TEST_DEBUG_EXTENSIONS ?? '').split(path.delimiter).filter(Boolean);
    for (const extension of debugExtensions) await fs.symlink(extension, path.join(extensions, path.basename(extension)), 'dir');
    delete process.env.ELECTRON_RUN_AS_NODE;
    await runTests({
      vscodeExecutablePath: process.env.CPP_TEST_VSCODE_PATH,
      extensionDevelopmentPath: path.resolve('.'), extensionTestsPath: path.resolve('out/test/host/suite'),
      launchArgs: [workspace, '--disable-gpu', '--user-data-dir', path.join(root, 'user'), '--extensions-dir', extensions],
      extensionTestsEnv: { CPP_TEST_WITH_DEBUGGERS: debugExtensions.length ? '1' : '', CPP_TEST_SOURCE: path.resolve('test/fixtures/cmake/tests.cpp') },
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
