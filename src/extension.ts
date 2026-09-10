/** Connect discovery and execution to the native VS Code Testing view. */
import * as vscode from 'vscode';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { settingsFor } from './config';
import { discover, stableId } from './discovery';
import { Scheduler } from './process';
import { readResults, runExecutable } from './runner';
import { debugConfiguration, DebugAdapter } from './debug';
import { selectLeaves } from './selection';
import type { CaseResult, Discovery, Executable, Settings, TestCase } from './types';

interface Binding { executable: Executable; test: TestCase; folder: vscode.WorkspaceFolder; settings: Settings }
const values = (collection: vscode.TestItemCollection) => { const items: vscode.TestItem[] = []; collection.forEach(item => items.push(item)); return items; };

/** Own the test tree, run profiles, discovery watchers and active runs. */
export class Explorer implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController('cppTestExplorer', 'C++ Google Tests');
  readonly output = vscode.window.createOutputChannel('C++ Test Explorer');
  private bindings = new Map<string, Binding>();
  private disposables: vscode.Disposable[] = [];
  private fileWatches = new Map<string, () => void>();
  private profiles: vscode.TestRunProfile[] = [];
  private scheduler = new Scheduler(4);
  private debugScheduler = new Scheduler(1);
  private refreshPromise: Promise<void> = Promise.resolve();
  private refreshAbort?: AbortController;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private active = new Set<AbortController>();
  private readonly debugTag = new vscode.TestTag('cpp-single-case');

  /** Register test actions and workspace change listeners. */
  constructor() {
    this.controller.refreshHandler = token => this.refresh(token);
    this.controller.resolveHandler = item => { if (!item) return this.refresh(); };
    this.disposables.push(this.controller, this.output,
      vscode.commands.registerCommand('cppTestExplorer.refresh', () => this.refresh()),
      vscode.commands.registerCommand('cppTestExplorer.showOutput', () => this.output.show()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('cppTestExplorer')) this.scheduleRefresh(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleRefresh()),
      vscode.extensions.onDidChange(() => this.updateProfiles()));
    const metadata = vscode.workspace.createFileSystemWatcher('**/{package.xml,COLCON_IGNORE,CTestTestfile.cmake,CMakeCache.txt,*[Tt]ests.cmake}');
    this.disposables.push(metadata, metadata.onDidChange(() => this.scheduleRefresh()), metadata.onDidCreate(() => this.scheduleRefresh()), metadata.onDidDelete(() => this.scheduleRefresh()));
    this.updateProfiles();
  }
  private updateProfiles() {
    this.profiles.forEach(p => p.dispose());
    this.profiles = [this.controller.createRunProfile('Run Google Tests', vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token), true)];
    for (const [extension, adapter, label] of [
      ['vadimcn.vscode-lldb', 'lldb', 'Debug Google Test (CodeLLDB)'],
      ['ms-vscode.cpptools', 'cppdbg', 'Debug Google Test (C++ / GDB)'],
    ] as const) {
      if (vscode.extensions.getExtension(extension)) this.profiles.push(this.controller.createRunProfile(label, vscode.TestRunProfileKind.Debug,
        (request, token) => this.run(request, token, adapter), false, this.debugTag));
    }
  }
  private scheduleRefresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refresh(); }, 500);
  }
  /** Replace discovery data while reusing stable test items. */
  refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.refreshAbort?.abort();
    const abort = new AbortController(); this.refreshAbort = abort;
    const subscription = token?.onCancellationRequested(() => abort.abort());
    if (token?.isCancellationRequested) abort.abort();
    this.refreshPromise = this.refreshPromise.then(async () => {
      if (abort.signal.aborted || this.disposed) return;
      if (!vscode.workspace.isTrusted) { this.output.appendLine('Trust the workspace to discover or run tests.'); return; }
      const folders = vscode.workspace.workspaceFolders ?? [];
      const configurations = new Map<vscode.WorkspaceFolder, Settings>();
      for (const folder of folders) {
        try { configurations.set(folder, settingsFor(folder)); }
        catch (e) { this.output.appendLine(`${folder.name}: ${String(e)}`); }
      }
      this.scheduler.setLimit(Math.min(...[...configurations.values()].map(s => s.concurrency), 1024));
      const discoveries: { folder: vscode.WorkspaceFolder; settings?: Settings; discovery: Discovery }[] = [];
      for (const folder of folders) {
        const settings = configurations.get(folder);
        if (!settings) { discoveries.push({ folder, discovery: { executables: [], diagnostics: ['Invalid C++ Test Explorer settings; see discovery output.'], watchPaths: [] } }); continue; }
        try { discoveries.push({ folder, settings, discovery: await discover(folder.uri.fsPath, settings, this.scheduler, abort.signal) }); }
        catch (e) { discoveries.push({ folder, settings, discovery: { executables: [], diagnostics: [String(e)], watchPaths: [] } }); }
      }
      if (abort.signal.aborted || this.disposed) return;
      this.bindings.clear();
      const roots: vscode.TestItem[] = [], watches = new Set<string>();
      for (const { folder, settings, discovery } of discoveries) {
        const rootId = stableId(folder.uri.toString());
        const root = this.controller.items.get(rootId) ?? this.controller.createTestItem(rootId, folder.name, folder.uri);
        root.error = discovery.diagnostics.length ? discovery.diagnostics.join('\n') : undefined;
        discovery.diagnostics.forEach(message => this.output.appendLine(`[${folder.name}] ${message}`));
        const groups = new Map<string, vscode.TestItem>();
        const groupChildren = new Map<string, vscode.TestItem[]>();
        for (const executable of discovery.executables) {
          const groupId = stableId(rootId, executable.group);
          const group = groups.get(groupId) ?? root.children.get(groupId) ?? this.controller.createTestItem(groupId, executable.group);
          groups.set(groupId, group);
          const item = group.children.get(executable.id) ?? this.controller.createTestItem(executable.id, path.basename(executable.path), vscode.Uri.file(executable.path));
          item.description = executable.package ? path.relative(folder.uri.fsPath, executable.path) : executable.cwd;
          const suites = new Map<string, vscode.TestItem>(), suiteChildren = new Map<string, vscode.TestItem[]>();
          for (const test of executable.cases) {
            const suiteId = stableId(executable.id, test.suite);
            const suite = suites.get(suiteId) ?? item.children.get(suiteId) ?? this.controller.createTestItem(suiteId, test.suite);
            suites.set(suiteId, suite);
            const id = stableId(executable.id, test.name);
            const leaf = suite.children.get(id) ?? this.controller.createTestItem(id, test.label);
            leaf.tags = [this.debugTag]; leaf.description = test.disabled || executable.disabled ? 'disabled' : undefined;
            this.bindings.set(id, { executable, test, folder, settings: settings! });
            suiteChildren.set(suiteId, [...(suiteChildren.get(suiteId) ?? []), leaf]);
          }
          suites.forEach((suite, id) => suite.children.replace(suiteChildren.get(id) ?? []));
          item.children.replace([...suites.values()]);
          groupChildren.set(groupId, [...(groupChildren.get(groupId) ?? []), item]);
        }
        groups.forEach((group, id) => group.children.replace(groupChildren.get(id) ?? []));
        root.children.replace([...groups.values()]); roots.push(root);
        discovery.watchPaths.forEach(file => watches.add(file));
        this.output.appendLine(`[${folder.name}] Discovered ${discovery.executables.reduce((count, e) => count + e.cases.length, 0)} cases in ${discovery.executables.length} executables.`);
      }
      this.controller.items.replace(roots);
      this.watch(watches);
    }).catch(e => this.output.appendLine(`Discovery error: ${String(e)}`)).finally(() => subscription?.dispose());
    return this.refreshPromise;
  }
  private watch(paths: Set<string>) {
    for (const [file, stop] of this.fileWatches) if (!paths.has(file)) { stop(); this.fileWatches.delete(file); }
    for (const file of paths) if (!this.fileWatches.has(file)) {
      const listener = (current: fs.Stats, previous: fs.Stats) => {
        if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size || current.ino !== previous.ino) this.scheduleRefresh();
      };
      fs.watchFile(file, { persistent: false, interval: 1500 }, listener);
      this.fileWatches.set(file, () => fs.unwatchFile(file, listener));
    }
  }
  /** Execute or debug a selection using the native Testing result interface. */
  async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, adapter?: DebugAdapter): Promise<void> {
    if (!vscode.workspace.isTrusted) { void vscode.window.showErrorMessage('Trust this workspace before running Google Tests.'); return; }
    await this.refreshPromise;
    if (this.disposed) return;
    const run = this.controller.createTestRun(request);
    const abort = new AbortController(); this.active.add(abort);
    const subscriptions = [token.onCancellationRequested(() => abort.abort()), run.token.onCancellationRequested(() => abort.abort())];
    if (token.isCancellationRequested || run.token.isCancellationRequested) abort.abort();
    const selected = selectLeaves(values(this.controller.items), request.include, request.exclude, item => this.bindings.has(item.id));
    const bindings = new Map(selected.map(item => [item.id, this.bindings.get(item.id)!]));
    const report = (item: vscode.TestItem, result: CaseResult) => {
      if (result.state === 'passed') run.passed(item, result.duration);
      else if (result.state === 'skipped') run.skipped(item);
      else run[result.state === 'failed' ? 'failed' : 'errored'](item, new vscode.TestMessage(result.message ?? 'Test failed'), result.duration);
    };
    try {
      selected.forEach(item => run.enqueued(item));
      if (adapter) {
        if (selected.length !== 1) {
          selected.forEach(item => run.errored(item, new vscode.TestMessage('Select exactly one Google Test case to debug.')));
          void vscode.window.showInformationMessage('Select exactly one Google Test case to debug.'); return;
        }
        const item = selected[0], binding = bindings.get(item.id)!;
        await this.debugScheduler.schedule(() => this.scheduler.schedule(async () => {
          run.started(item);
          const result = await this.debug(binding, adapter, abort.signal);
          report(item, result);
        }, abort.signal), abort.signal);
      } else {
        const grouped = new Map<string, { binding: Binding; items: vscode.TestItem[] }>();
        for (const item of selected) {
          const binding = bindings.get(item.id)!;
          const group = grouped.get(binding.executable.id) ?? { binding, items: [] };
          group.items.push(item); grouped.set(binding.executable.id, group);
        }
        await Promise.all([...grouped.values()].map(({ binding, items }) => {
          const byName = new Map(items.map(item => [bindings.get(item.id)!.test.name, item]));
          const executableItem = items[0]?.parent?.parent;
          return runExecutable(binding.executable, items.map(item => bindings.get(item.id)!.test), binding.settings, this.scheduler, {
            started: test => run.started(byName.get(test.name)!),
            result: result => report(byName.get(result.name)!, result),
            output: (text, name) => run.appendOutput(text.replace(/\r?\n/g, '\r\n'), undefined, name ? byName.get(name) ?? executableItem : executableItem),
          }, abort.signal);
        }));
      }
    } catch (e) { selected.forEach(item => report(item, { name: item.label, state: abort.signal.aborted ? 'skipped' : 'errored', message: String(e) })); }
    finally { subscriptions.forEach(s => s.dispose()); this.active.delete(abort); run.end(); }
  }
  private async debug(binding: Binding, adapter: DebugAdapter, signal: AbortSignal): Promise<CaseResult> {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'cpp-test-debug-'));
    const file = path.join(directory, 'results.xml'), sessionId = randomUUID();
    let session: vscode.DebugSession | undefined;
    let finish!: () => void;
    const terminated = new Promise<void>(resolve => { finish = resolve; });
    const cancel = () => { if (session) void vscode.debug.stopDebugging(session); };
    const subscriptions = [
      vscode.debug.onDidStartDebugSession(started => {
        if (started.configuration.__cppTestExplorerSession === sessionId) { session = started; if (signal.aborted) cancel(); }
      }),
      vscode.debug.onDidTerminateDebugSession(ended => { if (ended.configuration.__cppTestExplorerSession === sessionId) finish(); }),
    ];
    signal.addEventListener('abort', cancel);
    try {
      if (signal.aborted) throw new Error('Debug cancelled');
      const config = debugConfiguration(adapter, binding.executable, binding.test.name, file, binding.settings.debug[adapter] ?? {}, sessionId);
      if (!await vscode.debug.startDebugging(binding.folder, config as vscode.DebugConfiguration, { testRun: undefined })) throw new Error('Debugger did not start. Check the selected debugger installation and launch overrides.');
      await terminated;
      return (await readResults(file, [binding.test.name], signal.aborted ? 'Debug session cancelled' : undefined))[0];
    } finally { signal.removeEventListener('abort', cancel); subscriptions.forEach(s => s.dispose()); await fsp.rm(directory, { recursive: true, force: true }); }
  }
  /** Stop owned processes and release extension resources. */
  dispose() {
    this.disposed = true; clearTimeout(this.timer); this.refreshAbort?.abort();
    this.active.forEach(abort => abort.abort()); this.fileWatches.forEach(stop => stop());
    this.profiles.forEach(profile => profile.dispose()); this.disposables.forEach(disposable => disposable.dispose());
  }
}
/** Start the extension and populate its initial test tree. */
export async function activate(context: vscode.ExtensionContext): Promise<Explorer> {
  const explorer = new Explorer(); context.subscriptions.push(explorer); await explorer.refresh(); return explorer;
}
