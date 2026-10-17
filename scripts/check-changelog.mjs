// Released CHANGELOG sections are frozen: each `## [X.Y.Z]` section must read
// exactly as it did in the commit tagged vX.Y.Z. A rebase across a release can
// move a branch's Unreleased entries into the newly dated section without a
// conflict, and the next release's notes would then misstate what shipped.
//
// Usage: node scripts/check-changelog.mjs (needs the tags: fetch-depth 0 in CI)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
// git's message when the tag's tree has no CHANGELOG.md.
const NOT_IN_TAG = /does not exist in|exists on disk, but not in/;

/**
 * Line endings normalized, and the `[0.1.4]: https://...` block at the end of
 * the file dropped: each release appends a line to it, inside the oldest section.
 */
function normalize(changelog) {
  const lines = changelog.replace(/\r\n/g, '\n').trimEnd().split('\n');
  while (lines.length > 0 && /^\[[^\]]+\]: /.test(lines[lines.length - 1])) lines.pop();
  return lines;
}

/** The text of one version's section, or null. */
export function sectionOf(changelog, version) {
  const heading = `## [${version}]`;
  const lines = normalize(changelog);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## ['));
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join('\n')
    .trimEnd();
}

/**
 * Compares each released section with the CHANGELOG of its own tag.
 * `tagged` maps a version to the CHANGELOG text at tag v<version>.
 */
export function changedSections(current, tagged) {
  const problems = [];
  for (const [version, atTag] of tagged) {
    const frozen = sectionOf(atTag, version);
    if (frozen === null) continue;
    const now = sectionOf(current, version);
    if (now === null) problems.push({ version, reason: 'missing from CHANGELOG.md' });
    else if (now !== frozen) problems.push({ version, reason: `changed since v${version}` });
  }
  return problems;
}

/**
 * Reads CHANGELOG.md at every release tag through `git(...args)`, which returns
 * stdout or throws an error carrying git's `stderr`. A tag whose tree has no
 * CHANGELOG.md is skipped; any other git failure throws.
 */
export function loadTagged(git) {
  const tags = git('tag', '--list', 'v*')
    .split('\n')
    .filter((tag) => RELEASE_TAG.test(tag));
  const tagged = new Map();
  for (const tag of tags) {
    try {
      tagged.set(tag.slice(1), git('show', `${tag}:CHANGELOG.md`));
    } catch (error) {
      if (!NOT_IN_TAG.test(String(error.stderr ?? ''))) throw error;
    }
  }
  return tagged;
}

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main() {
  let tagged;
  try {
    tagged = loadTagged(git);
  } catch (error) {
    console.error(`check-changelog: git failed: ${String(error.stderr || error.message).trim()}`);
    process.exit(1);
  }
  if (tagged.size === 0) {
    console.error(
      'check-changelog: no release tag has a CHANGELOG.md; fetch the tags (fetch-depth: 0) and rerun',
    );
    process.exit(1);
  }
  const problems = changedSections(readFileSync('CHANGELOG.md', 'utf8'), tagged);
  for (const { version, reason } of problems) {
    console.error(
      `CHANGELOG.md: section [${version}] ${reason}. Move new entries to [Unreleased].`,
    );
  }
  if (problems.length > 0) process.exit(1);
  console.log(`check-changelog: ${tagged.size} released sections match their tags`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
