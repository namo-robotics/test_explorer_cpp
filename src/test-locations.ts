/** Read source locations reported by Google Test without running test bodies. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { SourceLocation, TestCase } from './types';
import { relocate, type Relocation } from './relocation';

/** XML fields that identify a test definition. */
interface ListedCase {
  name?: string;
  file?: string;
  line?: string;
}

/** XML fields that group test definitions by suite. */
interface ListedSuite {
  name?: string;
  testcase?: ListedCase | ListedCase[];
}

/** Normalize optional XML elements into a list. */
function elements<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Extract exact test names and zero-based definition lines from listing XML. */
export function parseSourceLocations(xml: string): Map<string, SourceLocation> {
  if (XMLValidator.validate(xml) !== true) {
    throw new Error('Malformed Google Test listing XML');
  }
  const document = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
  }).parse(xml);
  const suites: ListedSuite[] = elements(document.testsuites?.testsuite);
  const locations = new Map<string, SourceLocation>();
  for (const suite of suites) {
    if (typeof suite.name !== 'string') continue;
    for (const test of elements(suite.testcase)) {
      if (typeof test.name !== 'string' || typeof test.file !== 'string' || !test.file) continue;
      const line = Number(test.line);
      if (!Number.isSafeInteger(line) || line <= 0) continue;
      locations.set(`${suite.name}.${test.name}`, { file: test.file, line: line - 1 });
    }
  }
  return locations;
}

/** Resolve reported paths only when they identify one existing source file. */
async function resolveSourceFile(file: string, directories: string[]): Promise<string | undefined> {
  const candidates = path.isAbsolute(file)
    ? [file]
    : [...new Set(directories.map((directory) => path.resolve(directory, file)))];
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) existing.push(candidate);
    } catch {
      // Sources may be unavailable when binaries were built on another machine.
    }
  }
  return existing.length === 1 ? existing[0] : undefined;
}

/** Add navigation metadata when the binary supplies usable source locations. */
export async function attachSourceLocations(
  cases: TestCase[],
  xmlFile: string,
  directories: string[],
  relocation?: Relocation,
): Promise<void> {
  let locations: Map<string, SourceLocation>;
  try {
    locations = parseSourceLocations(await fs.readFile(xmlFile, 'utf8'));
  } catch {
    // Older Google Test binaries may only support the plain-text listing.
    return;
  }
  const resolved = new Map<string, string | undefined>();
  for (const test of cases) {
    const location = locations.get(test.name);
    if (!location) continue;
    if (!resolved.has(location.file)) {
      resolved.set(
        location.file,
        await resolveSourceFile(relocate(location.file, relocation), directories),
      );
    }
    const file = resolved.get(location.file);
    if (file) test.source = { file, line: location.line };
  }
}
