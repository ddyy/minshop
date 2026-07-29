// A subpath of a denied module. An exact-match rule would wave this through
// while banning the bare specifier.
//
// .mjs rather than .astro so it does not need node type declarations to
// type-check — the point being proven is the checker's matching, not the file's
// component shape.
import { readFile } from 'node:fs/promises';

export const read = readFile;
