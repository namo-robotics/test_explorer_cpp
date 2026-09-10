/** Expand test-tree selections while honoring excluded ancestors. */
/** The tree structure needed to expand a test selection. */
export interface TreeNode<T> { id: string; parent?: T; children: { forEach(callback: (item: T) => void): void }; }
/** Expand selected nodes into unique cases while pruning excluded ancestors. */
export function selectLeaves<T extends TreeNode<T>>(roots: T[], include: readonly T[] | undefined, exclude: readonly T[] | undefined, isLeaf: (item: T) => boolean): T[] {
  const excluded = new Set(exclude?.map(item => item.id));
  const selected = new Map<string, T>();
  const visit = (item: T) => {
    for (let ancestor: T | undefined = item; ancestor; ancestor = ancestor.parent) if (excluded.has(ancestor.id)) return;
    if (isLeaf(item)) selected.set(item.id, item);
    else item.children.forEach(visit);
  };
  (include ?? roots).forEach(visit);
  return [...selected.values()];
}
