import { describe, expect, it } from 'vitest';
import { retainedKeyCountFromGenerationDelete } from './vtoGenerationDeleteFailure';

/** An Axios rejection: the status and the body live on `error.response`. */
function rejection(status: number, data?: unknown) {
  return { isAxiosError: true, response: { status, data } };
}

function incompleteBody(details: unknown) {
  return {
    error: 'OBJECT_DELETION_INCOMPLETE',
    message: 'The resource was deleted, but 3 stored object(s) could not be proven deleted',
    details,
  };
}

describe('retainedKeyCountFromGenerationDelete', () => {
  it('states the count the Service reported for a 502 incomplete delete', () => {
    expect(
      retainedKeyCountFromGenerationDelete(
        rejection(502, incompleteBody({ manifest_id: '5f0c', retained_key_count: 3 })),
      ),
    ).toBe(3);

    // The contract's minimum is 1, so one retained file is still a count.
    expect(
      retainedKeyCountFromGenerationDelete(
        rejection(502, incompleteBody({ manifest_id: '5f0c', retained_key_count: 1 })),
      ),
    ).toBe(1);
  });

  it.each<[string, unknown]>([
    ['no details at all', undefined],
    ['details that are not an object', 'none'],
    ['details without the count', { manifest_id: '5f0c' }],
    [
      'the outfit-shaped payload that still carries the raw key list',
      { manifest_id: '5f0c', retained_object_keys: ['outfit-generations/u/o/g/execution-1.png'] },
    ],
  ])('reports no count for a 502 whose body has %s', (_label, details) => {
    expect(retainedKeyCountFromGenerationDelete(rejection(502, incompleteBody(details)))).toBeNull();
  });

  it.each<[string, unknown]>([
    ['zero', 0],
    ['a negative count', -2],
    ['a fractional count', 1.5],
    ['a numeric string', '3'],
    ['NaN', Number.NaN],
  ])('reports no count for %s, which no manifest can owe', (_label, retainedKeyCount) => {
    expect(
      retainedKeyCountFromGenerationDelete(
        rejection(502, incompleteBody({ manifest_id: '5f0c', retained_key_count: retainedKeyCount })),
      ),
    ).toBeNull();
  });

  it('reports no count for a 502 that is not the incomplete-delete error', () => {
    expect(
      retainedKeyCountFromGenerationDelete(
        rejection(502, { error: 'UPSTREAM_UNAVAILABLE', details: { retained_key_count: 3 } }),
      ),
    ).toBeNull();
  });

  it.each<[string, number]>([
    ['a 500', 500],
    ['a 400', 400],
    ['a 404', 404],
  ])('reports no count for %s carrying the same body', (_label, status) => {
    expect(
      retainedKeyCountFromGenerationDelete(
        rejection(status, incompleteBody({ manifest_id: '5f0c', retained_key_count: 3 })),
      ),
    ).toBeNull();
  });

  it.each<[string, unknown]>([
    ['a transport failure', new Error('Network Error')],
    ['an empty rejection', {}],
    ['no body', rejection(502)],
    ['null', null],
    ['undefined', undefined],
  ])('reports no count for %s', (_label, error) => {
    expect(retainedKeyCountFromGenerationDelete(error)).toBeNull();
  });
});
