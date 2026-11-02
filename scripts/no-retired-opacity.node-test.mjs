import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// #236: Tailwind CSS v4 removed the `*-opacity-*` utility family in favour of
// opacity modifiers (`bg-gray-500/75`), and the build drops an unknown utility
// silently. A retired spelling therefore paints at full strength with no build,
// lint or type error — the four dialog backdrops carried `bg-opacity-75` and
// covered the page with an opaque sheet. This guard walks `src/` and fails with
// the offending `file:line`, so the retired family cannot return unnoticed. It
// sweeps all six families one framework update dropped, since each fails the
// same silent way; the issue's acceptance names `bg-opacity-*` as a subset.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectory = join(repositoryRoot, 'src');

// The utility form, not a prose mention: a family name followed by a real step —
// digits (`bg-opacity-75`) or an arbitrary value (`bg-opacity-[0.75]`).
const retiredOpacityUtilities =
  /\b(?:bg|text|border|divide|ring|placeholder)-opacity-(?:\d+|\[[^\]]+\])/;

/** Every file under `src/` in lexical path order, so the first hit is stable. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    })
    .sort();
}

/** The first retired opacity utility in one file as a reportable `file:line`, or none. */
function firstRetiredOpacity(file, text) {
  const match = retiredOpacityUtilities.exec(text);
  if (!match) return null;
  const line = text.slice(0, match.index).split('\n').length;
  return { path: relative(repositoryRoot, file).replaceAll('\\', '/'), line, utility: match[0] };
}

test('no retired Tailwind opacity utility remains under src/', () => {
  const hits = sourceFiles(sourceDirectory)
    .map((file) => firstRetiredOpacity(file, readFileSync(file, 'utf8')))
    .filter(Boolean);

  const locations = hits.map((hit) => `${hit.path}:${hit.line}: ${hit.utility}`);
  assert.deepEqual(
    locations,
    [],
    `Tailwind v4 does not generate the retired opacity family; use a slash modifier such as bg-gray-500/75${
      locations.length > 0 ? `\nretired opacity utility at ${locations[0]}` : ''
    }`,
  );
});
