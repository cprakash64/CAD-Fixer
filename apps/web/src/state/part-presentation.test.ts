import { describe, expect, it } from 'vitest';
import { describeActivePart, describePartAt } from './part-presentation';

/**
 * ONE NAME PER PART, ACROSS THREE SURFACES.
 *
 * The selector, Mesh Health and the repair panel all name parts. A user who
 * selects "Left bracket" and is then told a repair will change "Part 2" has
 * been shown two names for one thing.
 */

describe('naming a part', () => {
  it('quotes the source’s name when there is one', () => {
    expect(describePartAt({ partId: 'a', name: 'Left bracket' }, 0)).toBe('Left bracket');
  });

  it('falls back to a one-based position when the source named nothing', () => {
    // `Part 3` does not pretend to be a name the file contained. Anything
    // descriptive would be information about the user's model that nothing
    // established.
    expect(describePartAt({ partId: 'c' }, 2)).toBe('Part 3');
  });

  it('treats a blank or whitespace name as no name at all', () => {
    expect(describePartAt({ partId: 'a', name: '' }, 0)).toBe('Part 1');
    expect(describePartAt({ partId: 'a', name: '   ' }, 0)).toBe('Part 1');
  });

  it('names a missing part positionally rather than throwing', () => {
    expect(describePartAt(undefined, 4)).toBe('Part 5');
  });
});

describe('naming the active part', () => {
  const parts = [{ partId: 'a', name: 'Left bracket' }, { partId: 'b' }, { partId: 'c' }];

  it('resolves the selection by id, not by position', () => {
    expect(describeActivePart(parts, 'a')).toBe('Left bracket');
    expect(describeActivePart(parts, 'c')).toBe('Part 3');
  });

  it('reads awkwardly rather than crashing when the selection does not resolve', () => {
    // A panel mid-transition must not take the tab down.
    expect(describeActivePart(parts, 'gone')).toBe('the selected part');
    expect(describeActivePart(parts, undefined)).toBe('the selected part');
    expect(describeActivePart([], 'a')).toBe('the selected part');
  });
});
