/**
 * Session-scoped identifiers.
 *
 * These are branded strings so that an arbitrary string cannot be passed where
 * an operation identifier is required.
 */

declare const operationIdBrand: unique symbol;

/**
 * Correlates a worker request with its progress, result, error, and cancel
 * messages.
 *
 * Uniqueness is guaranteed only within a single JavaScript realm for the
 * lifetime of that realm. That is sufficient: identifiers are never persisted,
 * never sent over a network, and never shared between tabs. A counter is used
 * rather than `crypto.randomUUID` so this module stays free of any platform
 * global and remains trivially deterministic under test.
 */
export type OperationId = string & { readonly [operationIdBrand]: true };

let nextOperationSequence = 0;

export function createOperationId(): OperationId {
  nextOperationSequence += 1;
  return `op-${String(nextOperationSequence)}` as OperationId;
}

/** Test-only hook so identifier sequences do not leak between test cases. */
export function resetOperationIdSequenceForTesting(): void {
  nextOperationSequence = 0;
}
