/** Remap absolute paths recorded by a build tree that has since moved. */
export interface Relocation {
  /** Workspace prefix recorded at configure time. */
  from: string;
  /** Prefix where the same files live now. */
  to: string;
}

/** Derive the workspace move from where CMake configured a build tree and where it is now. */
export function buildRelocation(configured: string, actual: string): Relocation | undefined {
  if (configured === actual) {
    return undefined;
  }
  const from = configured.split('/');
  const to = actual.split('/');
  while (from.length > 1 && to.length > 1 && from[from.length - 1] === to[to.length - 1]) {
    from.pop();
    to.pop();
  }
  const source = from.join('/');
  const target = to.join('/');
  return source && target && source !== target ? { from: source, to: target } : undefined;
}

/** Replace the recorded prefix wherever it appears as a whole path segment in a value. */
export function relocate(value: string, relocation?: Relocation): string {
  if (!relocation || !value.includes(relocation.from)) {
    return value;
  }
  const escaped = relocation.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`${escaped}(?=$|[/:;])`, 'g'), relocation.to);
}
