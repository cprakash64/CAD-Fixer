/**
 * HOW A PART IS NAMED, decided in ONE place.
 *
 * Three surfaces name parts — the selector, Mesh Health and the repair panel —
 * and they must never disagree. A user who selects "Left bracket" and is then
 * told a repair will change "Part 2" has been shown two names for one thing,
 * which is the same class of drift the repair copy rule exists to prevent.
 *
 * The rule itself: quote the SOURCE'S name when there is one, and fall back to
 * a deterministic position otherwise. `Part 3` is not a name the file
 * contained, and it does not pretend to be one — anything descriptive would be
 * information about the user's model that nothing established.
 */

/** The minimum a caller must know about a part to name it. */
export interface NameablePart {
  readonly partId: string;
  readonly name?: string;
}

/** The label for a part at a known position in document order. */
export function describePartAt(part: NameablePart | undefined, index: number): string {
  if (part?.name !== undefined && part.name.trim().length > 0) return part.name;
  return `Part ${String(index + 1)}`;
}

/**
 * The label for whichever part is currently selected.
 *
 * Returns a neutral phrase rather than throwing when the selection does not
 * resolve: a panel mid-transition should read awkwardly, not crash.
 */
export function describeActivePart(
  parts: readonly NameablePart[],
  activePartId: string | undefined,
): string {
  const index = parts.findIndex((part) => part.partId === activePartId);
  if (index < 0) return 'the selected part';
  return describePartAt(parts[index], index);
}
