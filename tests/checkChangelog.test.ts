import { describe, expect, it } from 'vitest';
import { changedSections, loadTagged, sectionOf } from '../scripts/check-changelog.mjs';

const released = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-01-02

### Fixed

- A fix.

## [0.1.0] - 2026-01-01

- First release.

[0.1.0]: https://example.com/v0.1.0
`;

describe('sectionOf', () => {
  it('stops at the next version heading', () => {
    expect(sectionOf(released, '0.2.0')).toBe('## [0.2.0] - 2026-01-02\n\n### Fixed\n\n- A fix.');
  });

  it('does not match a version that only shares a prefix', () => {
    expect(sectionOf('## [0.1.17] - 2026-10-17\n', '0.1.1')).toBeNull();
  });

  it('leaves out link definitions, which each release appends at the end of the file', () => {
    const later = released.replace(
      '[0.1.0]: https://example.com/v0.1.0',
      '[0.2.0]: https://example.com/v0.2.0\n[0.1.0]: https://example.com/v0.1.0',
    );
    expect(sectionOf(later, '0.1.0')).toBe(sectionOf(released, '0.1.0'));
  });
});

describe('changedSections', () => {
  it('passes when every released section reads as it did at its tag', () => {
    const current = released.replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n### Added\n\n- New work.\n',
    );
    expect(changedSections(current, new Map([['0.2.0', released]]))).toEqual([]);
  });

  it('fails when a rebase moves an Unreleased entry into a released section', () => {
    const rebased = released.replace('- A fix.', '- A fix.\n- Work that landed after the release.');
    expect(changedSections(rebased, new Map([['0.2.0', released]]))).toEqual([
      { version: '0.2.0', reason: 'changed since v0.2.0' },
    ]);
  });

  it('fails when a released section is gone', () => {
    const current = released.replace(/## \[0\.2\.0\][\s\S]*?(?=## \[0\.1\.0\])/, '');
    expect(changedSections(current, new Map([['0.2.0', released]]))).toEqual([
      { version: '0.2.0', reason: 'missing from CHANGELOG.md' },
    ]);
  });

  it('skips a tag whose own CHANGELOG has no section for it', () => {
    expect(changedSections(released, new Map([['0.0.9', released]]))).toEqual([]);
  });

  it('reads a CRLF working copy the same as the LF text git stores', () => {
    const crlf = released.replace(/\n/g, '\r\n');
    expect(changedSections(crlf, new Map([['0.2.0', released]]))).toEqual([]);
  });

  it('sees a link definition changed inside a released section', () => {
    const atTag = released.replace('- A fix.', '- A [fix][f].\n\n[f]: https://example.com/a');
    const now = atTag.replace('https://example.com/a', 'https://example.com/b');
    expect(changedSections(now, new Map([['0.2.0', atTag]]))).toEqual([
      { version: '0.2.0', reason: 'changed since v0.2.0' },
    ]);
  });
});

function gitError(stderr: string): Error {
  return Object.assign(new Error('Command failed'), { stderr });
}

describe('loadTagged', () => {
  it('reads CHANGELOG.md at each release tag and ignores other tags', () => {
    const calls: string[][] = [];
    const tagged = loadTagged((...args) => {
      calls.push(args);
      return args[0] === 'tag' ? 'v0.1.0\nv0.2.0-rc.1\nv0.2.0\n' : `text at ${args[1]}`;
    });
    expect([...tagged]).toEqual([
      ['0.1.0', 'text at v0.1.0:CHANGELOG.md'],
      ['0.2.0', 'text at v0.2.0:CHANGELOG.md'],
    ]);
    expect(calls).toHaveLength(3);
  });

  it('skips a tag whose tree has no CHANGELOG.md', () => {
    const tagged = loadTagged((...args) => {
      if (args[0] === 'tag') return 'v0.0.1\nv0.1.0\n';
      if (args[1] === 'v0.0.1:CHANGELOG.md') {
        throw gitError("fatal: path 'CHANGELOG.md' does not exist in 'v0.0.1'");
      }
      return 'text';
    });
    expect([...tagged.keys()]).toEqual(['0.1.0']);
  });

  it('throws on any other git failure instead of comparing nothing', () => {
    expect(() =>
      loadTagged((...args) => {
        if (args[0] === 'tag') return 'v0.1.0\n';
        throw gitError('fatal: missing object');
      }),
    ).toThrow('Command failed');
  });
});
