import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'oxfmt';
import ts from 'typescript';

const sourceUrl = new URL('../service-worker/sw.ts', import.meta.url);
const outputUrl = new URL('../public/sw.js', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const result = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'service-worker/sw.ts',
  reportDiagnostics: true,
});

if (result.diagnostics && result.diagnostics.length > 0) {
  throw new Error('Service Worker transpilation reported diagnostics');
}
const formatted = await format('public/sw.js', result.outputText, {
  printWidth: 80,
  singleQuote: true,
});
if (formatted.errors.length > 0) {
  throw new Error('Service Worker formatting reported errors');
}
await writeFile(outputUrl, formatted.code);
