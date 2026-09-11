/** Find lexical C++ namespaces at Google Test source locations. */

/** Read namespace scopes while ignoring comments, strings, and preprocessor directives. */
export function namespacesByLine(source: string): string[][] {
  const scopes: string[][] = [];
  const lines: string[][] = [[]];
  let pending: string[] | undefined;
  // Keep newlines in ignored text so source locations still match.
  const clean = source.replace(
    /R"([^\s()\\]{0,16})\([\s\S]*?\)\1"|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|^[ \t]*#(?:[^\n\\]|\\[\s\S])*/gm,
    (text) => text.replace(/[^\n]/g, ' '),
  );
  const tokens = clean.match(/\n|[a-zA-Z_]\w*|::|[{};=]/g) ?? [];
  for (const token of tokens) {
    if (token === '\n') {
      lines.push(scopes.flat());
    } else if (token === 'namespace') {
      pending = [];
    } else if (token === '{') {
      scopes.push(pending ?? []);
      pending = undefined;
      lines[lines.length - 1] = scopes.flat();
    } else if (token === '}') {
      scopes.pop();
      pending = undefined;
    } else if (token === ';' || token === '=') {
      pending = undefined;
    } else if (pending && token !== '::' && token !== 'inline') {
      pending.push(token);
    }
  }
  return lines;
}
