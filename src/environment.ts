/** Resolve workspace paths and the environment needed by test processes. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from './process';
import type { Environment, Settings } from './types';

/** Resolve a configured path relative to its workspace folder. */
export function resolvePath(root: string, value: string): string {
  return path.resolve(root, value.replace(/\$\{workspaceFolder\}/g, root));
}
/** Copy the defined environment variables from the extension host. */
export function hostEnvironment(): Environment {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
/** Source configured Bash setup files and capture their resulting environment. */
export async function workspaceEnvironment(root: string, settings: Settings, signal?: AbortSignal): Promise<Environment> {
  const scripts = settings.setupScripts.map(script => resolvePath(root, script));
  const automatic = path.join(root, 'install/setup.bash');
  if (settings.autoSourceWorkspace && existsSync(automatic) && !scripts.includes(automatic)) scripts.push(automatic);
  if (!scripts.length) return hostEnvironment();
  // Paths are positional arguments, never interpolated shell code. Keep script chatter off stdout.
  const result = await runProcess('/bin/bash', ['--noprofile', '--norc', '-c',
    'for script in "$@"; do source "$script" 1>&2 || exit $?; done; /usr/bin/env -0', 'cpp-test-explorer', ...scripts],
  { cwd: root, env: hostEnvironment(), signal, timeout: settings.discoveryTimeout });
  if (result.code !== 0 || result.cancelled || result.timedOut || result.truncated) {
    throw new Error(`Could not source ROS setup scripts: ${result.stderr || (result.timedOut ? 'timed out' : 'cancelled or output too large')}`);
  }
  return Object.fromEntries(result.stdout.split('\0').filter(Boolean).map(entry => {
    const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)];
  }));
}
/** Apply CTest and ament environment changes to a copy of the base environment. */
export function applyEnvironment(base: Environment, assignments: string[] = [], modifications: string[] = [], append: string[] = []): Environment {
  const env = { ...base };
  for (const entry of assignments) {
    const i = entry.indexOf('=');
    if (i < 1) throw new Error(`Invalid environment assignment: ${entry}`);
    env[entry.slice(0, i)] = entry.slice(i + 1);
  }
  const original = { ...env };
  for (const entry of modifications) {
    const match = /^([^=]+)=([^:]+):(.*)$/s.exec(entry);
    if (!match) throw new Error(`Invalid CTest environment modification: ${entry}`);
    const [, key, op, value] = match;
    switch (op) {
      case 'reset': if (key in original) env[key] = original[key]; else delete env[key]; break;
      case 'set': env[key] = value; break;
      case 'unset': delete env[key]; break;
      case 'string_append': env[key] = (env[key] ?? '') + value; break;
      case 'string_prepend': env[key] = value + (env[key] ?? ''); break;
      case 'path_list_append': case 'cmake_list_append': env[key] = env[key] ? env[key] + (op.startsWith('path') ? ':' : ';') + value : value; break;
      case 'path_list_prepend': case 'cmake_list_prepend': env[key] = env[key] ? value + (op.startsWith('path') ? ':' : ';') + env[key] : value; break;
      default: throw new Error(`Unsupported CTest environment operation: ${op}`);
    }
  }
  // Match ament's path append behavior, including its leading separator for an unset variable.
  for (const entry of append) {
    const i = entry.indexOf('=');
    if (i < 1) throw new Error(`Invalid ament environment assignment: ${entry}`);
    const key = entry.slice(0, i), value = entry.slice(i + 1);
    env[key] = (env[key] ?? '') + ((env[key] ?? '').endsWith(':') ? '' : ':') + value;
  }
  return env;
}
