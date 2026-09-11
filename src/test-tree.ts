/** Build the workspace, executable, suite, and case items shown in Testing. */
import * as vscode from 'vscode';
import path from 'node:path';
import { createTestGrouper } from './test-grouping';
import { stableId } from './discovery';
import type { Discovery, Executable, Settings, TestCase } from './types';

/** Connect a test item to the configuration used to run it. */
export interface Binding {
  executable: Executable;
  test: TestCase;
  folder: vscode.WorkspaceFolder;
  settings: Settings;
  executableItem: vscode.TestItem;
}

/** Reuse stable test items and track the execution data for each leaf. */
export class TestTree {
  /** Current test cases indexed by their test item IDs. */
  readonly bindings = new Map<string, Binding>();

  /** Use the controller and debug tag owned by the extension. */
  constructor(
    private readonly controller: vscode.TestController,
    private readonly debugTag: vscode.TestTag,
  ) {}

  /** Replace one workspace's children with its latest discovery results. */
  updateFolder(
    folder: vscode.WorkspaceFolder,
    settings: Settings | undefined,
    discovery: Discovery,
  ): vscode.TestItem {
    const rootId = stableId(folder.uri.toString());
    const root =
      this.controller.items.get(rootId) ??
      this.controller.createTestItem(rootId, folder.name, folder.uri);
    root.error = discovery.diagnostics.length ? discovery.diagnostics.join('\n') : undefined;
    for (const [id, binding] of this.bindings) {
      if (binding.folder.uri.toString() === folder.uri.toString()) this.bindings.delete(id);
    }
    if (!settings) {
      root.children.replace([]);
      return root;
    }
    const previous = this.collectItems(root);
    const groups = new Map<string, vscode.TestItem>();
    const children = new Map<vscode.TestItem, vscode.TestItem[]>([[root, []]]);
    for (const executable of discovery.executables) {
      const mode = executable.testGroupByMode ?? settings.testGroupByMode;
      const grouping = executable.testGrouping ?? settings.testGrouping;
      const placeTest = createTestGrouper(
        folder.uri.fsPath,
        mode === 'name' && !('groupBySplittedTestName' in grouping)
          ? { groupBySplittedTestName: {} }
          : grouping,
      );
      for (const test of executable.cases) {
        const placement = placeTest(test);
        const prefix =
          mode === 'namespace'
            ? test.namespaces?.length
              ? test.namespaces
              : [test.namespaces ? 'Global namespace' : 'Unknown namespace']
            : [
                executable.group,
                ...(mode === 'executable' ? [path.basename(executable.path)] : []),
              ];
        let parent = root;
        let executableItem = root;
        const segments: string[] = [];
        for (const [index, label] of [...prefix, ...placement.groups].entries()) {
          segments.push(label);
          const groupId = stableId(
            rootId,
            mode,
            segments,
            mode === 'executable' && index >= 1 ? executable.id : '',
          );
          let child = groups.get(groupId);
          if (!child) {
            child = previous.get(groupId) ?? this.controller.createTestItem(groupId, label);
            groups.set(groupId, child);
            children.set(child, []);
            children.get(parent)!.push(child);
          }
          parent = child;
          if (mode === 'executable' && index === 1) executableItem = child;
        }
        const id = stableId(executable.id, test.name);
        const uri = test.source ? vscode.Uri.file(test.source.file) : undefined;
        let leaf = previous.get(id);
        if (!leaf || leaf.parent?.id !== parent.id || leaf.uri?.toString() !== uri?.toString()) {
          leaf = this.controller.createTestItem(id, placement.label, uri);
        }
        leaf.label = placement.label;
        leaf.range = test.source
          ? new vscode.Range(test.source.line, 0, test.source.line, 0)
          : undefined;
        leaf.tags = [this.debugTag];
        leaf.description =
          test.disabled || executable.disabled
            ? 'disabled'
            : mode === 'executable'
              ? undefined
              : path.basename(executable.path);
        this.bindings.set(id, {
          executable,
          test,
          folder,
          settings,
          executableItem: mode === 'executable' ? executableItem : leaf,
        });
        children.get(parent)!.push(leaf);
      }
    }
    children.forEach((items, parent) => parent.children.replace(items));
    return root;
  }

  /** Index existing descendants so refreshes can reuse stable test items. */
  private collectItems(root: vscode.TestItem): Map<string, vscode.TestItem> {
    const items = new Map<string, vscode.TestItem>();
    const visit = (item: vscode.TestItem) => {
      items.set(item.id, item);
      item.children.forEach(visit);
    };
    root.children.forEach(visit);
    return items;
  }
}
