/** Find ROS packages and normalize existing Google Test registrations. */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { attachSourceLocations } from './test-locations';
import { createHash } from 'node:crypto';
import { minimatch } from 'minimatch';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { applyEnvironment, resolvePath, workspaceEnvironment } from './environment';
import { cleanArgs, matchesFilter, parseList, testEnvironment } from './gtest';
import { runProcess, Scheduler } from './process';
import type { Discovery, Environment, Executable, ManualExecutable, Settings } from './types';

/** Create a repeatable identifier from normalized discovery data. */
export const stableId = (...parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
/** Check whether a path is the same as or below another directory. */
export const inside = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
/** Match a path or any ancestor against workspace exclusion globs. */
export function excluded(root: string, file: string, patterns: string[]): boolean {
  let relative = path.relative(root, file).split(path.sep).join('/');
  while (relative && relative !== '.') {
    if (
      patterns.some((pattern) => minimatch(relative, pattern.replace(/\/$/, ''), { dot: true }))
    ) {
      return true;
    }
    const parent = path.posix.dirname(relative);
    if (parent === relative) {
      break;
    }
    relative = parent;
  }
  return patterns.some((pattern) => pattern === '.' || pattern === '**');
}
interface Package {
  name: string;
  source: string;
}
interface PackageScan {
  packages: Package[];
  ignored: string[];
  watch: string[];
}
function ignoredAncestor(root: string, directory: string): string | undefined {
  for (let current = directory; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, 'COLCON_IGNORE'))) {
      return current;
    }
    if (current === root || path.dirname(current) === current) {
      return undefined;
    }
  }
}
async function scanPackages(
  root: string,
  settings: Settings,
  diagnostics: string[],
  signal?: AbortSignal,
): Promise<PackageScan> {
  const result: PackageScan = { packages: [], ignored: [], watch: [] };
  const seen = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    if (signal?.aborted) {
      throw new Error('Cancelled');
    }
    if (seen.has(directory)) {
      return;
    }
    seen.add(directory);
    result.watch.push(path.join(directory, 'COLCON_IGNORE'), path.join(directory, 'package.xml'));
    const ignored = ignoredAncestor(root, directory);
    if (excluded(root, directory, settings.exclude) || ignored) {
      result.ignored.push(ignored ?? directory);
      return;
    }
    if (existsSync(path.join(directory, 'package.xml'))) {
      try {
        const xml = await fs.readFile(path.join(directory, 'package.xml'), 'utf8');
        if (XMLValidator.validate(xml) !== true) {
          throw new Error('Malformed package.xml');
        }
        const name = new XMLParser().parse(xml).package?.name;
        if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)) {
          throw new Error('Invalid package name');
        }
        if (result.packages.some((p) => p.name === name)) {
          throw new Error(`Duplicate ROS package name ${name}`);
        }
        result.packages.push({ name, source: directory });
      } catch (e) {
        diagnostics.push(`${directory}: ${String(e)}`);
      }
      return;
    }
    try {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          !['.git', 'node_modules', 'build', 'install', 'log'].includes(entry.name)
        ) {
          await walk(path.join(directory, entry.name));
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        diagnostics.push(`${directory}: ${String(e)}`);
      }
    }
  };
  for (const source of settings.sourceRoots) {
    await walk(resolvePath(root, source));
  }
  return result;
}

/** The CTest JSON fields used to discover a test program. */
export interface CTestEntry {
  name: string;
  command?: string[];
  properties?: { name: string; value: any }[];
}
/** Convert a supported CTest registration into a native test invocation. */
export function fromCTest(
  entry: CTestEntry,
  root: string,
  build: string,
  group: string,
  env: Environment,
  settings: Settings,
  pkg?: string,
): Executable | undefined {
  const properties = Object.fromEntries((entry.properties ?? []).map((p) => [p.name, p.value]));
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(';') : [];
  let command = [...(entry.command ?? [])];
  const labels = list(properties.LABELS);
  const isAment = command.some((arg) => /(?:^|\/)ament_cmake_test\/.*run_test\.py$/.test(arg));
  const markedGtest = labels.includes('gtest');
  const hasFlags = command.some((arg) => arg.startsWith('--gtest_'));
  const scriptOrWrapper =
    command[0] &&
    (/^(python[\d.]*|bash|sh|cmake|env)$/.test(path.basename(command[0])) ||
      /\.(py|sh)$/.test(command[0]));
  if (!markedGtest && !hasFlags && !isAment && scriptOrWrapper) {
    return undefined;
  }
  if (!command.length) {
    throw new Error(`${entry.name}: test executable is missing; build the project first`);
  }
  let append: string[] = [];
  let assignments: string[] = [];
  let disabled = properties.DISABLED === true || properties.DISABLED === 'TRUE';
  if (isAment) {
    if (!markedGtest && !hasFlags) {
      return undefined;
    }
    const index = command.indexOf('--command');
    if (index < 0) {
      throw new Error(`${entry.name}: unsupported ament wrapper (missing --command)`);
    }
    const wrapper = command.slice(0, index);
    disabled ||= wrapper.includes('--skip-test');
    for (let i = 0; i < wrapper.length; i++) {
      if (wrapper[i] === '--env' || wrapper[i] === '--append-env') {
        const target = wrapper[i] === '--env' ? assignments : append;
        while (i + 1 < wrapper.length && !wrapper[i + 1].startsWith('--')) {
          target.push(wrapper[++i]);
        }
      }
    }
    command = command.slice(index + 1);
  }
  if (
    !command.length ||
    /^(python[\d.]*|bash|sh|cmake|env)$/.test(path.basename(command[0])) ||
    command[0].endsWith('.py')
  ) {
    throw new Error(
      `${entry.name}: unsupported test wrapper; configure the Google Test executable explicitly`,
    );
  }
  if (properties.FIXTURES_REQUIRED || properties.RESOURCE_GROUPS) {
    throw new Error(
      `${entry.name}: CTest fixtures/resources require orchestration; configure a standalone executable explicitly`,
    );
  }
  const cwd = properties.WORKING_DIRECTORY
    ? path.resolve(build, properties.WORKING_DIRECTORY)
    : build;
  const program = path.resolve(build, command[0]);
  let testEnv = applyEnvironment(
    env,
    list(properties.ENVIRONMENT),
    list(properties.ENVIRONMENT_MODIFICATION),
  );
  testEnv = applyEnvironment(testEnv, assignments, [], append);
  const args = cleanArgs(command.slice(1));
  const filter = command
    .find((arg) => arg.startsWith('--gtest_filter='))
    ?.slice('--gtest_filter='.length);
  const registrations = filter !== undefined ? [{ filter, disabled }] : undefined;
  if (registrations) {
    disabled = false;
  }
  const timeout = settings.timeout ?? (Number(properties.TIMEOUT) || 60);
  return {
    id: stableId(root, program, args, cwd, testEnv, group, disabled, timeout),
    workspace: root,
    group,
    package: pkg,
    path: program,
    args,
    cwd,
    env: { ...testEnv, ...settings.env },
    timeout,
    disabled,
    cases: [],
    registrations,
  };
}

/** Discover and list existing test binaries while collecting recoverable errors. */
export async function discover(
  root: string,
  settings: Settings,
  scheduler: Scheduler,
  signal?: AbortSignal,
): Promise<Discovery> {
  return new DiscoverySession(root, settings, scheduler, signal).run();
}

/** Keep the state of one discovery pass separate from other workspace refreshes. */
class DiscoverySession {
  private readonly diagnostics: string[] = [];
  private readonly candidates: Executable[] = [];
  private readonly manual: Executable[] = [];
  private readonly overridden = new Set<string>();
  private readonly watchPaths = new Set<string>();
  private readonly projectNames = new Map<string, string>();
  private scan: PackageScan = { packages: [], ignored: [], watch: [] };
  private env: Environment = {};
  private readonly base: string;

  /** Capture the workspace and shared process queue for this discovery pass. */
  constructor(
    private readonly root: string,
    private readonly settings: Settings,
    private readonly scheduler: Scheduler,
    private readonly signal?: AbortSignal,
  ) {
    this.base = resolvePath(root, settings.buildBase);
  }

  /** Collect registrations, apply explicit overrides, and list the resulting tests. */
  async run(): Promise<Discovery> {
    const { root, settings, signal, diagnostics, watchPaths } = this;
    this.scan = await scanPackages(root, settings, diagnostics, signal);
    this.scan.watch.forEach((file) => watchPaths.add(file));
    const builds = await this.collectBuildDirectories();
    this.env = await workspaceEnvironment(root, settings, signal);
    for (const script of settings.setupScripts) {
      watchPaths.add(resolvePath(root, script));
    }
    watchPaths.add(path.join(root, 'install/setup.bash'));
    await this.collectCTestCandidates(builds);
    await this.addManualExecutables();
    const executables = await Promise.all(
      this.mergeCandidates().map((candidate) => this.listCases(candidate)),
    );
    return {
      executables: executables.filter((executable): executable is Executable => !!executable),
      diagnostics,
      watchPaths: [...watchPaths],
    };
  }

  /** Find configured builds and associate them with their source packages. */
  private async collectBuildDirectories() {
    const { root, settings, scan, diagnostics, projectNames } = this;
    const base = resolvePath(root, settings.buildBase);
    const builds = new Map<string, { group: string; pkg?: string }>();
    for (const pkg of scan.packages) {
      builds.set(path.join(base, pkg.name), { group: pkg.name, pkg: pkg.name });
    }
    for (const value of settings.buildDirectories) {
      const build = resolvePath(root, value);
      const pkg = await this.associatedPackage(build);
      if (pkg === false || excluded(root, build, settings.exclude)) {
        continue;
      }
      if (!builds.has(build) && existsSync(path.join(build, 'CTestTestfile.cmake'))) {
        builds.set(build, { group: pkg ?? projectNames.get(build) ?? path.basename(root), pkg });
      } else if (!existsSync(build) && !scan.packages.length) {
        diagnostics.push(
          `${build}: no existing build directory. Build your tests or configure buildDirectories/executables.`,
        );
      }
    }
    return builds;
  }

  /** Read a build's source association, excluding ignored package sources. */
  private async associatedPackage(build: string): Promise<string | undefined | false> {
    const { root, settings, scan, projectNames } = this;
    try {
      const cache = await fs.readFile(path.join(build, 'CMakeCache.txt'), 'utf8');
      const projectName = /^CMAKE_PROJECT_NAME:[^=\r\n]+=(.+)$/m.exec(cache)?.[1]?.trim();
      if (projectName) {
        projectNames.set(build, projectName);
      }
      const source = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$/m.exec(cache)?.[1]?.trim();
      if (
        source &&
        (excluded(root, source, settings.exclude) ||
          ignoredAncestor(root, source) ||
          scan.ignored.some((dir) => inside(dir, source)))
      ) {
        return false;
      }
      return scan.packages.find((pkg) => source && inside(pkg.source, source))?.name;
    } catch {
      return undefined;
    }
  }

  /** Read supported CTest registrations from builds that contain test metadata. */
  private async collectCTestCandidates(
    builds: Map<string, { group: string; pkg?: string }>,
  ): Promise<void> {
    const { root, settings, scheduler, signal, env, candidates, diagnostics, watchPaths } = this;
    for (const [build, info] of builds) {
      if (signal?.aborted) {
        throw new Error('Cancelled');
      }
      watchPaths.add(path.join(build, 'CTestTestfile.cmake'));
      watchPaths.add(path.join(build, 'CMakeCache.txt'));
      if (excluded(root, build, settings.exclude)) {
        continue;
      }
      if (!existsSync(path.join(build, 'CTestTestfile.cmake'))) {
        continue;
      }
      try {
        const result = await scheduler.schedule(
          () =>
            runProcess(
              settings.ctestPath,
              [
                '--show-only=json-v1',
                ...(settings.buildConfiguration ? ['-C', settings.buildConfiguration] : []),
              ],
              {
                cwd: build,
                env: { ...env, ...settings.env },
                signal,
                timeout: settings.discoveryTimeout,
              },
            ),
          signal,
        );
        if (result.code !== 0 || result.timedOut || result.cancelled || result.truncated) {
          throw new Error(`CTest discovery failed: ${result.stderr || result.stdout}`);
        }
        const data = JSON.parse(result.stdout);
        if (!Array.isArray(data.tests)) {
          throw new Error('Invalid CTest JSON response');
        }
        for (const file of data.backtraceGraph?.files ?? []) {
          watchPaths.add(path.resolve(build, file));
        }
        for (const test of data.tests as CTestEntry[]) {
          try {
            const executable = fromCTest(test, root, build, info.group, env, settings, info.pkg);
            if (executable) {
              candidates.push(executable);
            }
          } catch (e) {
            diagnostics.push(`${info.group}: ${String(e)}`);
          }
        }
      } catch (e) {
        diagnostics.push(`${build}: ${String(e)}`);
      }
    }
  }

  /** Apply explicit executables and inherit unambiguous automatic metadata. */
  private async addManualExecutables(): Promise<void> {
    const { root, settings, scan, base, env, candidates, manual, overridden, diagnostics } = this;
    const manualIds = new Set<string>();
    for (const entry of settings.executables) {
      try {
        if (!entry.id || !entry.path || manualIds.has(entry.id)) {
          throw new Error(`Explicit executables need unique nonempty IDs and paths: ${entry.id}`);
        }
        manualIds.add(entry.id);
        const program = resolvePath(root, entry.path);
        let pkg = entry.package;
        if (pkg && !scan.packages.some((p) => p.name === pkg)) {
          continue;
        }
        if (
          excluded(root, program, settings.exclude) ||
          ignoredAncestor(root, path.dirname(program)) ||
          scan.ignored.some((dir) => inside(dir, program))
        ) {
          continue;
        }
        if (inside(base, program)) {
          const packageBuild = path.join(base, path.relative(base, program).split(path.sep)[0]);
          const association = await this.associatedPackage(packageBuild);
          if (association === false) {
            continue;
          }
          pkg ??= association;
          // Stale colcon builds from excluded packages must not be resurrected by manual entries.
          if (
            existsSync(path.join(packageBuild, 'colcon_build.rc')) &&
            !scan.packages.some((p) => p.name === path.basename(packageBuild))
          ) {
            continue;
          }
        }
        const inherited = this.findInheritedExecutable(entry, program, pkg);
        if (inherited) {
          overridden.add(inherited.id);
        }
        pkg ??= inherited?.package;
        const group = entry.group ?? pkg ?? 'Manual';
        const explicit: Executable = {
          id: stableId(root, 'manual', entry.id),
          workspace: root,
          group,
          package: pkg,
          path: program,
          args: cleanArgs(entry.args ?? []),
          cwd: entry.cwd ? resolvePath(root, entry.cwd) : (inherited?.cwd ?? path.dirname(program)),
          env: { ...(inherited?.env ?? env), ...settings.env, ...entry.env },
          timeout: entry.timeout ?? settings.timeout ?? inherited?.timeout ?? 60,
          disabled: inherited?.disabled ?? false,
          testGrouping: entry.testGrouping,
          cases: [],
        };
        manual.push(explicit);
        candidates.push(explicit);
      } catch (e) {
        diagnostics.push(String(e));
      }
    }
  }

  /** Use unique automatic metadata, or require an exact environment and directory match. */
  private findInheritedExecutable(
    entry: ManualExecutable,
    program: string,
    pkg?: string,
  ): Executable | undefined {
    const { root, settings, candidates, env } = this;
    const args = JSON.stringify(cleanArgs(entry.args ?? []));
    const configuredCwd = entry.cwd ? resolvePath(root, entry.cwd) : undefined;
    const matches = new Map<string, Executable>();
    for (const candidate of candidates) {
      if (candidate.path !== program || JSON.stringify(candidate.args) !== args) {
        continue;
      }
      if (configuredCwd && candidate.cwd !== configuredCwd) {
        continue;
      }
      if (pkg && candidate.package !== pkg) {
        continue;
      }
      matches.set(candidate.id, candidate);
    }
    if (matches.size === 1) {
      return matches.values().next().value;
    }

    const cwd = configuredCwd ?? path.dirname(program);
    const environment = JSON.stringify(
      Object.entries({ ...env, ...settings.env, ...entry.env }).sort(),
    );
    return [...matches.values()].find(
      (candidate) =>
        candidate.cwd === cwd &&
        JSON.stringify(Object.entries(candidate.env).sort()) === environment,
    );
  }

  /** Combine equivalent registrations and remove explicitly overridden entries. */
  private mergeCandidates(): Executable[] {
    const { candidates, manual, overridden } = this;
    const unique = new Map<string, Executable>();
    for (const candidate of candidates) {
      if (!manual.includes(candidate) && overridden.has(candidate.id)) {
        continue;
      }
      const previous = unique.get(candidate.id);
      if (previous) {
        previous.registrations =
          previous.registrations && candidate.registrations
            ? [...previous.registrations, ...candidate.registrations]
            : undefined;
      } else {
        unique.set(candidate.id, candidate);
      }
    }
    return [...unique.values()];
  }

  /** Request names and optional source metadata, then remove the temporary listing. */
  private async readCaseListing(candidate: Executable) {
    const { settings, signal } = this;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-test-list-'));
    const listingFile = path.join(directory, 'tests.xml');
    try {
      const result = await runProcess(
        candidate.path,
        [
          ...candidate.args,
          '--gtest_list_tests',
          '--gtest_color=no',
          `--gtest_output=xml:${listingFile}`,
        ],
        {
          cwd: candidate.cwd,
          env: testEnvironment(candidate.env),
          timeout: settings.discoveryTimeout,
          signal,
        },
      );
      candidate.cases = parseList(result.stdout);
      const packageSource = this.scan.packages.find(
        (pkg) => pkg.name === candidate.package,
      )?.source;
      await attachSourceLocations(candidate.cases, listingFile, [
        candidate.cwd,
        path.dirname(candidate.path),
        this.root,
        ...(packageSource ? [packageSource] : []),
      ]);
      return result;
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  /** List one binary and keep the cases selected by its CTest registrations. */
  private async listCases(candidate: Executable): Promise<Executable | undefined> {
    const { scheduler, signal, diagnostics, watchPaths } = this;
    watchPaths.add(candidate.path);
    try {
      const result = await scheduler.schedule(() => this.readCaseListing(candidate), signal);
      if (result.code !== 0 || result.timedOut || result.cancelled || result.truncated) {
        throw new Error(
          `Google Test listing failed (${result.timedOut ? 'timeout' : result.code}): ${result.stderr || result.stdout}`,
        );
      }
      const registrations = candidate.registrations;
      if (registrations) {
        candidate.cases = candidate.cases.flatMap((test) => {
          const matching = registrations.filter((r) => matchesFilter(test.name, r.filter));
          return matching.length
            ? [{ ...test, disabled: test.disabled || matching.every((r) => r.disabled) }]
            : [];
        });
      }
      if (!candidate.cases.length) {
        return undefined;
      }
      return candidate;
    } catch (e) {
      diagnostics.push(`${candidate.path}: ${String(e)}`);
      return undefined;
    }
  }
}
