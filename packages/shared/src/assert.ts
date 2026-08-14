import { internalError } from './errors';

/**
 * Compile-time exhaustiveness check. Reaching this at runtime means a union
 * gained a member without every switch being updated, which is a defect, so it
 * throws rather than returning a fallback.
 */
export function assertNever(value: never, context: string): never {
  throw internalError(`Unhandled case in ${context}.`, {
    details: { received: String(value) },
  });
}
