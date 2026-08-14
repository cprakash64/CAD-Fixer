import { describe, expect, it } from 'vitest';
import {
  AppError,
  AppErrorCode,
  deserializeAppError,
  isAppError,
  malformedFile,
  toAppError,
} from './errors';

describe('AppError serialization across the worker boundary', () => {
  it('round-trips code, message, and details', () => {
    const original = malformedFile('Header declared more triangles than the file contains.', {
      declared: 1000,
      actual: 12,
    });

    const restored = deserializeAppError(original.toSerializable());

    expect(restored.code).toBe(AppErrorCode.MalformedFile);
    expect(restored.message).toBe('Header declared more triangles than the file contains.');
    expect(restored.details).toEqual({ declared: 1000, actual: 12 });
  });

  it('carries a cause message but not the cause object', () => {
    const error = new AppError(AppErrorCode.Internal, 'Wrapped failure.', {
      cause: new RangeError('offset out of bounds'),
    });

    const serialized = error.toSerializable();

    expect(serialized.causeMessage).toBe('offset out of bounds');
    // The wire form must remain structured-cloneable; an Error instance is not
    // guaranteed to survive every transport.
    expect(
      Object.values(serialized).every(
        (value) => typeof value !== 'object' || value === null || !(value instanceof Error),
      ),
    ).toBe(true);
  });

  it('omits causeMessage when there is no cause', () => {
    const serialized = malformedFile('No cause here.').toSerializable();
    expect(serialized.causeMessage).toBeUndefined();
  });
});

describe('toAppError', () => {
  it('returns an existing AppError unchanged', () => {
    const original = malformedFile('Already typed.');
    expect(toAppError(original)).toBe(original);
  });

  it('classifies an unknown throw as INTERNAL_ERROR and keeps the original as cause', () => {
    const cause = new TypeError('cannot read length of undefined');

    const converted = toAppError(cause);

    expect(converted.code).toBe(AppErrorCode.Internal);
    expect(converted.message).toBe('cannot read length of undefined');
    expect(converted.cause).toBe(cause);
  });

  it('handles thrown non-Error values without losing them', () => {
    const converted = toAppError('a bare string');

    expect(converted.code).toBe(AppErrorCode.Internal);
    expect(converted.cause).toBe('a bare string');
  });

  it('reconstitutes a serialized error that arrived from a worker', () => {
    const wire = malformedFile('From the worker.', { chunk: 3 }).toSerializable();

    // A structured clone produces a plain object, not an AppError instance.
    const converted = toAppError(JSON.parse(JSON.stringify(wire)) as unknown);

    expect(isAppError(converted)).toBe(true);
    expect(converted.code).toBe(AppErrorCode.MalformedFile);
    expect(converted.details).toEqual({ chunk: 3 });
  });
});
