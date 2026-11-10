import { describe, expect, it } from 'vitest';
import { describeBasePhotoDeleteFailure } from './basePhotoDeleteFailure';

/** An Axios rejection: the status and body live on `error.response`. */
function rejection(status: number, data?: unknown) {
  return { isAxiosError: true, response: { status, data } };
}

/** The Service's 409 body for a photo a try-on references. */
function referencedBody(dependentResources: { resource: string; count?: number }[], hint?: string) {
  return {
    error: 'RESOURCE_REFERENCED',
    message: 'The base photo is still referenced by other resources',
    details: {
      reason: 'RESOURCE_REFERENCED',
      dependent_resources: dependentResources,
      action: 'DELETE_DEPENDENTS_FIRST',
      hint: hint ?? 'Delete the outfit generation that references this base photo, then delete the photo',
    },
  };
}

describe('describeBasePhotoDeleteFailure', () => {
  it('names the try-on count the Service reports for a 409', () => {
    const failure = describeBasePhotoDeleteFailure(
      rejection(409, referencedBody([{ resource: 'outfit_generation', count: 2 }])),
    );

    expect(failure).toEqual({
      message: 'This photo is used by 2 try-on(s). Delete it/them in History first.',
      refresh: false,
    });
    // The card never repeats the Service's database resource name.
    expect(failure.message).not.toContain('outfit_generation');
  });

  it('states the count-less sentence when a recognised reference has no count', () => {
    expect(
      describeBasePhotoDeleteFailure(rejection(409, referencedBody([{ resource: 'outfit_generation' }]))),
    ).toEqual({
      message: 'This photo is used by a try-on. Delete it in History first.',
      refresh: false,
    });

    // A zero count is not a number of try-ons to list, so it reads count-less.
    expect(
      describeBasePhotoDeleteFailure(rejection(409, referencedBody([{ resource: 'outfit_generation', count: 0 }]))),
    ).toEqual({
      message: 'This photo is used by a try-on. Delete it in History first.',
      refresh: false,
    });
  });

  it('keeps the Service hint verbatim for an unrecognised resource', () => {
    const body = referencedBody([{ resource: 'outfit', count: 1 }], 'Delete the outfit that uses this photo first');

    expect(describeBasePhotoDeleteFailure(rejection(409, body))).toEqual({
      message: 'Delete the outfit that uses this photo first',
      refresh: false,
    });
  });

  it('falls back to the Service message when an unrecognised 409 carries no hint', () => {
    const body = { ...referencedBody([{ resource: 'outfit' }]), details: { dependent_resources: [{ resource: 'outfit' }] } };

    expect(describeBasePhotoDeleteFailure(rejection(409, body))).toEqual({
      message: 'The base photo is still referenced by other resources',
      refresh: false,
    });
  });

  it('renders the Service message for a 403', () => {
    const body = { error: 'FORBIDDEN', message: 'A shared system base photo cannot be deleted' };

    expect(describeBasePhotoDeleteFailure(rejection(403, body))).toEqual({
      message: 'A shared system base photo cannot be deleted',
      refresh: false,
    });
  });

  it('treats a 404 as already gone: refresh, and nothing to say', () => {
    expect(describeBasePhotoDeleteFailure(rejection(404, { error: 'NOT_FOUND', message: 'Base photo not found' }))).toEqual({
      message: null,
      refresh: true,
    });
  });

  it('reports a server error with its status', () => {
    expect(describeBasePhotoDeleteFailure(rejection(500, { message: 'Internal Server Error' }))).toEqual({
      message: 'Could not remove this photo (server error 500). Try again.',
      refresh: false,
    });
    expect(describeBasePhotoDeleteFailure(rejection(503, undefined))).toEqual({
      message: 'Could not remove this photo (server error 503). Try again.',
      refresh: false,
    });
  });

  it('reports a request that never reached the server as a connection failure', () => {
    // Axios records the attempted request and no response for a network failure.
    expect(describeBasePhotoDeleteFailure({ isAxiosError: true, request: {}, message: 'Network Error' })).toEqual({
      message: 'Could not reach the server. Check your connection and try again.',
      refresh: false,
    });
  });

  it('reports a value that is not an error with the generic sentence', () => {
    expect(describeBasePhotoDeleteFailure('failure')).toEqual({
      message: 'Could not remove this photo.',
      refresh: false,
    });
    expect(describeBasePhotoDeleteFailure(null)).toEqual({
      message: 'Could not remove this photo.',
      refresh: false,
    });
  });

  it('uses the Service message for the remaining 4xx statuses', () => {
    expect(describeBasePhotoDeleteFailure(rejection(422, { message: 'Invalid request' }))).toEqual({
      message: 'Invalid request',
      refresh: false,
    });
    // A body without a message keeps the error's own sentence.
    expect(describeBasePhotoDeleteFailure({ response: { status: 400 }, message: 'Request failed with status code 400' })).toEqual({
      message: 'Request failed with status code 400',
      refresh: false,
    });
  });
});
