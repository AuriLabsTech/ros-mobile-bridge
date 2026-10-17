export function sectionOf(changelog: string, version: string): string | null;

export function changedSections(
  current: string,
  tagged: Map<string, string>,
): { version: string; reason: string }[];

export function loadTagged(git: (...args: string[]) => string): Map<string, string>;
