import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

async function goFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return goFiles(file);
      return entry.isFile() && entry.name.endsWith('.go') ? [file] : [];
    }),
  );
  return nested.flat().sort();
}

const files = await goFiles('backend');
if (files.length === 0) {
  throw new Error('No Go source files found under backend/.');
}
const unformatted = execFileSync('gofmt', ['-l', ...files], {
  encoding: 'utf8',
}).trim();
if (unformatted !== '') {
  process.stderr.write(`Go files require gofmt:\n${unformatted}\n`);
  process.exitCode = 1;
}
