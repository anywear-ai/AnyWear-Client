import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// #303: the wardrobe's delete confirmations and their outcome sentences used to
// ride on `window.confirm` and `window.alert`. A macOS Tauri build renders the
// bundle in `WKWebView`, whose pinned `wry` UI delegate implements none of the
// `runJavaScript*Panel` methods, so `confirm()` resolves `false` at once and
// `alert()` paints nothing: the delete silently did nothing and every refusal
// was silent on that shell. The dialogue is now painted by the page and its
// dialogs, and this guard walks `src/pages/wardrobe/` so a host script dialog
// cannot return unnoticed. It fails with the offending `file:line`, and it
// sweeps the test files too, because a test that stubs the host dialog would
// reintroduce the dependency the fix removes.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const wardrobeDirectory = join(repositoryRoot, 'src', 'pages', 'wardrobe');

// Both forms matter: the qualified call (`window.alert(...)`) and the bare call
// the shells resolve to the same function. The lookbehind excludes a member
// call on another object (`deps.confirm(...)`) and an identifier that merely ends
// in one of the words (`confirmUpload(`, `onConfirm(`), because neither reaches
// a host script dialog.
const nativeScriptDialog = /\bwindow\s*\.\s*(?:alert|confirm|prompt)\b|(?<![\w$.])(?:alert|confirm|prompt)\s*\(/g;

/** Every TypeScript source file under the wardrobe directory, in lexical path order. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    })
    .sort();
}

/** The first host script dialog in one file as a reportable `file:line`, or none. */
function firstNativeScriptDialog(file, text) {
  nativeScriptDialog.lastIndex = 0;
  const match = nativeScriptDialog.exec(text);
  if (!match) return null;
  const line = text.slice(0, match.index).split('\n').length;
  return { path: relative(repositoryRoot, file).replaceAll('\\', '/'), line, call: match[0] };
}

test('no wardrobe path calls a host script dialog', () => {
  const hits = sourceFiles(wardrobeDirectory)
    .map((file) => firstNativeScriptDialog(file, readFileSync(file, 'utf8')))
    .filter(Boolean);

  const locations = hits.map((hit) => `${hit.path}:${hit.line}: ${hit.call}`);
  assert.deepEqual(
    locations,
    [],
    `a wardrobe confirmation and its outcome are painted by the page or its dialog; the macOS WebView implements no host script dialog, so one here is silent on that build${
      locations.length > 0 ? `\nhost script dialog at ${locations[0]}` : ''
    }`,
  );
});
