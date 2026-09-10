/** Connect discovery and execution to the native VS Code Testing view. */
import * as vscode from 'vscode';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { settingsFor } from './config';
import { discover } from './discovery';
import { TestTree, Binding } from './test-tree';
import { Scheduler } from './process';
import { readResults, runExecutable } from './runner';
import { debugConfiguration, DebugAdapter } from './debug';
import { selectLeaves } from './selection';
import type { CaseResult, Discovery, Settings } from './types';

/** Collect the immediate children of a VS Code test item collection. */
const testItems = (collection: vscode.TestItemCollection) => {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => items.push(item));
  return items;
};

/** Translate a Google Test outcome into the native Testing result interface. */
function reportResult(run: vscode.TestRun, item: vscode.TestItem, result: CaseResult): void {
  if (result.state === 'passed') {
    run.passed(item, result.duration);
  } else if (result.state === 'skipped') {
    run.skipped(item);
  } else {
    const message = new vscode.TestMessage(result.message ?? 'Test failed');
    if (result.state === 'failed') {
      run.failed(item, message, result.duration);
    } else {
      run.errored(item, message, result.duration);
    }
  }
}

/** Own the test tree, run profiles, discovery watchers and active runs. */
export class Explorer implements vscode.Disposable {
  /** Native test controller exposed to the extension host. */
  readonly controller = vscode.tests.createTestController('cppTestExplorer', 'C++ Test Explorer');
  /** Discovery messages shown in the output panel. */
  readonly output = vscode.window.createOutputChannel('C++ Test Explorer');
  private disposables: vscode.Disposable[] = [];
  private fileWatches = new Map<string, () => void>();
  private profiles: vscode.TestRunProfile[] = [];
  private scheduler = new Scheduler(4);
  private debugScheduler = new Scheduler(1);
  private refreshPromise: Promise<void> = Promise.resolve();
  private refreshAbort?: AbortController;
  private refreshPending = false;
  private discoveredConfiguration?: string;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private active = new Set<AbortController>();
  private readonly debugTag = new vscode.TestTag('cpp-single-case');
  private readonly tree = new TestTree(this.controller, this.debugTag);

  /** Register test actions and workspace change listeners. */
  constructor() {
    this.controller.refreshHandler = (token) => this.refresh(token);
    this.controller.resolveHandler = (item) => {
      if (!item && !this.hasCurrentDiscovery()) {
        return this.refresh();
      }
    };
    this.disposables.push(
      this.controller,
      this.output,
      vscode.commands.registerCommand('cppTestExplorer.refresh', () => this.refresh()),
      vscode.commands.registerCommand('cppTestExplorer.showOutput', () => this.output.show()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('cppTestExplorer')) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleRefresh()),
      vscode.extensions.onDidChange(() => this.updateProfiles()),
    );
    const metadata = vscode.workspace.createFileSystemWatcher(
      '**/{package.xml,COLCON_IGNORE,CTestTestfile.cmake,CMakeCache.txt,*[Tt]ests.cmake}',
    );
    this.disposables.push(
      metadata,
      metadata.onDidChange(() => this.scheduleRefresh()),
      metadata.onDidCreate(() => this.scheduleRefresh()),
      metadata.onDidDelete(() => this.scheduleRefresh()),
    );
    this.updateProfiles();
  }
  /** Offer run and debug profiles for the installed adapters. */
  private updateProfiles() {
    this.profiles.forEach((p) => p.dispose());
    this.profiles = [
      this.controller.createRunProfile(
        'Run Google Tests',
        vscode.TestRunProfileKind.Run,
        (request, token) => this.run(request, token),
        true,
      ),
    ];
    for (const [extension, adapter, label] of [
      ['vadimcn.vscode-lldb', 'lldb', 'Debug Google Test (CodeLLDB)'],
      ['ms-vscode.cpptools', 'cppdbg', 'Debug Google Test (C++ / GDB)'],
    ] as const) {
      if (vscode.extensions.getExtension(extension)) {
        this.profiles.push(
          this.controller.createRunProfile(
            label,
            vscode.TestRunProfileKind.Debug,
            (request, token) => this.run(request, token, adapter),
            false,
            this.debugTag,
          ),
        );
      }
    }
  }
  /** Combine nearby workspace changes into a single refresh. */
  private scheduleRefresh() {
    clearTimeout(this.timer);
    if (this.active.size) {
      this.refreshPending = true;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.active.size) {
        this.refreshPending = true;
      } else {
        void this.refresh();
      }
    }, 500);
  }
  /** Replace discovery data while reusing stable test items. */
  refresh(token?: vscode.CancellationToken): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.refreshAbort?.abort();
    const abort = new AbortController();
    this.refreshAbort = abort;
    const subscription = token?.onCancellationRequested(() => abort.abort());
    if (token?.isCancellationRequested) {
      abort.abort();
    }
    this.refreshPromise = this.refreshPromise
      .then(async () => {
        await this.refreshWorkspaces(abort.signal);
      })
      .catch((e) => this.output.appendLine(`Discovery error: ${String(e)}`))
      .finally(() => {
        subscription?.dispose();
        if (this.refreshAbort === abort) this.refreshAbort = undefined;
      });
    return this.refreshPromise;
  }
  /** Discover workspace folders and apply results after checking cancellation. */
  private async refreshWorkspaces(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.disposed) {
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.output.appendLine('Trust the workspace to discover or run tests.');
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const configurations = new Map<vscode.WorkspaceFolder, Settings>();
    for (const folder of folders) {
      try {
        configurations.set(folder, settingsFor(folder));
      } catch (e) {
        this.output.appendLine(`${folder.name}: ${String(e)}`);
      }
    }
    this.scheduler.setLimit(
      configurations.size ? Math.min(...[...configurations.values()].map((s) => s.concurrency)) : 1,
    );
    const discoveries: {
      folder: vscode.WorkspaceFolder;
      settings?: Settings;
      discovery: Discovery;
    }[] = [];
    for (const folder of folders) {
      const settings = configurations.get(folder);
      const discovery = await this.discoverFolder(folder, settings, signal);
      discoveries.push({ folder, settings, discovery });
    }
    if (signal.aborted || this.disposed) {
      return;
    }
    this.tree.bindings.clear();
    const roots: vscode.TestItem[] = [];
    const watches = new Set<string>();
    for (const { folder, settings, discovery } of discoveries) {
      roots.push(this.tree.updateFolder(folder, settings, discovery));
      discovery.diagnostics.forEach((message) =>
        this.output.appendLine(`[${folder.name}] ${message}`),
      );
      discovery.watchPaths.forEach((file) => watches.add(file));
      this.output.appendLine(
        `[${folder.name}] Discovered ${discovery.executables.reduce((count, e) => count + e.cases.length, 0)} cases in ${discovery.executables.length} executables.`,
      );
    }
    this.controller.items.replace(roots);
    this.watch(watches);
    this.discoveredConfiguration =
      configurations.size === folders.length ? this.configurationKey(configurations) : undefined;
  }

  /** Represent invalid settings and discovery failures as workspace diagnostics. */
  private async discoverFolder(
    folder: vscode.WorkspaceFolder,
    settings: Settings | undefined,
    signal: AbortSignal,
  ): Promise<Discovery> {
    if (!settings) {
      return {
        executables: [],
        diagnostics: ['Invalid C++ Test Explorer settings; see discovery output.'],
        watchPaths: [],
      };
    }
    try {
      return await discover(folder.uri.fsPath, settings, this.scheduler, signal);
    } catch (error) {
      return { executables: [], diagnostics: [String(error)], watchPaths: [] };
    }
  }

  /** Reconcile file watches with the paths used by the latest discovery. */
  private watch(paths: Set<string>) {
    for (const [file, stop] of this.fileWatches) {
      if (!paths.has(file)) {
        stop();
        this.fileWatches.delete(file);
      }
    }
    for (const file of paths) {
      if (!this.fileWatches.has(file)) {
        const listener = (current: fs.Stats, previous: fs.Stats) => {
          if (
            current.mtimeMs !== previous.mtimeMs ||
            current.size !== previous.size ||
            current.ino !== previous.ino
          ) {
            this.scheduleRefresh();
          }
        };
        fs.watchFile(file, { persistent: false, interval: 1500 }, listener);
        this.fileWatches.set(file, () => fs.unwatchFile(file, listener));
      }
    }
  }
  /** Identify the workspace settings used to produce a discovery snapshot. */
  private configurationKey(configurations: Map<vscode.WorkspaceFolder, Settings>): string {
    return JSON.stringify(
      [...configurations].map(([folder, settings]) => [
        folder.uri.toString(),
        folder.name,
        settings,
      ]),
    );
  }

  /** Reuse discovered tests only while their workspace settings remain unchanged. */
  private hasCurrentDiscovery(): boolean {
    if (this.discoveredConfiguration === undefined) return false;
    try {
      const configurations = new Map(
        (vscode.workspace.workspaceFolders ?? []).map((folder) => [folder, settingsFor(folder)]),
      );
      return this.configurationKey(configurations) === this.discoveredConfiguration;
    } catch {
      return false;
    }
  }

  /** Let a cancelled run stop waiting for an unrelated discovery refresh. */
  private waitForRefresh(token: vscode.CancellationToken): Promise<boolean> {
    if (token.isCancellationRequested) return Promise.resolve(false);
    return new Promise((resolve) => {
      const subscription = token.onCancellationRequested(() => finish(false));
      const finish = (ready: boolean) => {
        subscription.dispose();
        resolve(ready);
      };
      this.refreshPromise.then(
        () => finish(true),
        () => finish(false),
      );
      if (token.isCancellationRequested) finish(false);
    });
  }

  /** Execute or debug a selection using the native Testing result interface. */
  async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    adapter?: DebugAdapter,
  ): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('Trust this workspace before running Google Tests.');
      return;
    }
    if (!this.hasCurrentDiscovery()) {
      if (!this.refreshAbort) void this.refresh();
      const refreshed = await this.waitForRefresh(token);
      if (!refreshed) return;
    }
    if (token.isCancellationRequested || this.disposed) return;
    if (this.timer) this.refreshPending = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.refreshAbort) {
      this.refreshPending = true;
      this.refreshAbort.abort();
    }
    const run = this.controller.createTestRun(request);
    const abort = new AbortController();
    this.active.add(abort);
    const subscriptions = [
      token.onCancellationRequested(() => abort.abort()),
      run.token.onCancellationRequested(() => abort.abort()),
    ];
    if (token.isCancellationRequested || run.token.isCancellationRequested) {
      abort.abort();
    }
    const selected = selectLeaves(
      testItems(this.controller.items),
      request.include,
      request.exclude,
      (item) => this.tree.bindings.has(item.id),
    );
    const bindings = new Map(selected.map((item) => [item.id, this.tree.bindings.get(item.id)!]));
    try {
      selected.forEach((item) => run.enqueued(item));
      if (adapter) {
        if (selected.length !== 1) {
          selected.forEach((item) =>
            run.errored(
              item,
              new vscode.TestMessage('Select exactly one Google Test case to debug.'),
            ),
          );
          void vscode.window.showInformationMessage(
            'Select exactly one Google Test case to debug.',
          );
          return;
        }
        const item = selected[0];
        const binding = bindings.get(item.id)!;
        await this.debugScheduler.schedule(
          () =>
            this.scheduler.schedule(async () => {
              run.started(item);
              const result = await this.debug(binding, adapter, abort.signal);
              reportResult(run, item, result);
            }, abort.signal),
          abort.signal,
        );
      } else {
        await this.runSelection(selected, bindings, run, abort.signal);
      }
    } catch (e) {
      selected.forEach((item) =>
        reportResult(run, item, {
          name: item.label,
          state: abort.signal.aborted ? 'skipped' : 'errored',
          message: String(e),
        }),
      );
    } finally {
      subscriptions.forEach((s) => s.dispose());
      this.active.delete(abort);
      run.end();
      if (!this.active.size && this.refreshPending && !this.disposed) {
        this.refreshPending = false;
        this.scheduleRefresh();
      }
    }
  }
  /** Group selected cases by binary and connect execution events to VS Code. */
  private async runSelection(
    selected: vscode.TestItem[],
    bindings: Map<string, Binding>,
    run: vscode.TestRun,
    signal: AbortSignal,
  ): Promise<void> {
    const grouped = new Map<string, { binding: Binding; items: vscode.TestItem[] }>();
    for (const item of selected) {
      const binding = bindings.get(item.id)!;
      const group = grouped.get(binding.executable.id) ?? { binding, items: [] };
      group.items.push(item);
      grouped.set(binding.executable.id, group);
    }
    await Promise.all(
      [...grouped.values()].map(({ binding, items }) => {
        const byName = new Map(items.map((item) => [bindings.get(item.id)!.test.name, item]));
        const executableItem = binding.executableItem;
        return runExecutable(
          binding.executable,
          items.map((item) => bindings.get(item.id)!.test),
          binding.settings,
          this.scheduler,
          {
            started: (test) => run.started(byName.get(test.name)!),
            result: (result) => reportResult(run, byName.get(result.name)!, result),
            output: (text, name) =>
              run.appendOutput(
                text.replace(/\r?\n/g, '\r\n'),
                undefined,
                name ? (byName.get(name) ?? executableItem) : executableItem,
              ),
          },
          signal,
        );
      }),
    );
  }

  /** Run one case under a debugger and read its result after the session ends. */
  private async debug(
    binding: Binding,
    adapter: DebugAdapter,
    signal: AbortSignal,
  ): Promise<CaseResult> {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'cpp-test-debug-'));
    const file = path.join(directory, 'results.xml');
    const sessionId = randomUUID();
    let session: vscode.DebugSession | undefined;
    let finish!: () => void;
    const terminated = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cancel = () => {
      if (session) {
        void vscode.debug.stopDebugging(session);
      }
    };
    const subscriptions = [
      vscode.debug.onDidStartDebugSession((started) => {
        if (started.configuration.__cppTestExplorerSession === sessionId) {
          session = started;
          if (signal.aborted) {
            cancel();
          }
        }
      }),
      vscode.debug.onDidTerminateDebugSession((ended) => {
        if (ended.configuration.__cppTestExplorerSession === sessionId) {
          finish();
        }
      }),
    ];
    signal.addEventListener('abort', cancel);
    try {
      if (signal.aborted) {
        throw new Error('Debug cancelled');
      }
      const config = debugConfiguration(
        adapter,
        binding.executable,
        binding.test.name,
        file,
        binding.settings.debug[adapter] ?? {},
        sessionId,
      );
      if (
        !(await vscode.debug.startDebugging(binding.folder, config as vscode.DebugConfiguration, {
          testRun: undefined,
        }))
      ) {
        throw new Error(
          'Debugger did not start. Check the selected debugger installation and launch overrides.',
        );
      }
      await terminated;
      return (
        await readResults(
          file,
          [binding.test.name],
          signal.aborted ? 'Debug session cancelled' : undefined,
        )
      )[0];
    } finally {
      signal.removeEventListener('abort', cancel);
      subscriptions.forEach((s) => s.dispose());
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }
  /** Stop owned processes and release extension resources. */
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.refreshAbort?.abort();
    this.active.forEach((abort) => abort.abort());
    this.fileWatches.forEach((stop) => stop());
    this.profiles.forEach((profile) => profile.dispose());
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}
/** Start the extension and populate its initial test tree. */
export async function activate(context: vscode.ExtensionContext): Promise<Explorer> {
  const explorer = new Explorer();
  context.subscriptions.push(explorer);
  await explorer.refresh();
  return explorer;
}
