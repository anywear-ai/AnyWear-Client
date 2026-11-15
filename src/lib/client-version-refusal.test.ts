import { describe, expect, it } from 'vitest';

import {
  CLIENT_VERSION_UNSUPPORTED,
  getClientVersionRefusal,
  parseClientVersionRefusal,
} from './client-version-refusal';

/** The Service's real refusal body (ADR-0026 §2). */
function refusalBody(details: unknown, error = CLIENT_VERSION_UNSUPPORTED) {
  return { error, details };
}

describe('parseClientVersionRefusal', () => {
  it('reads both versions from the refusal contract', () => {
    expect(parseClientVersionRefusal(400, refusalBody({
      minimum_client_version: 9,
      received_client_version: 8,
    }))).toEqual({
      minimumClientVersion: 9,
      receivedClientVersion: 8,
      detailsReported: true,
    });
  });

  it('treats a reported zero as a version', () => {
    expect(parseClientVersionRefusal(400, refusalBody({
      minimum_client_version: 9,
      received_client_version: 0,
    }))).toMatchObject({ receivedClientVersion: 0 });
  });

  it('keeps the null received version the Service reports for a missing header', () => {
    expect(parseClientVersionRefusal(400, refusalBody({
      minimum_client_version: 9,
      received_client_version: null,
    }))).toEqual({
      minimumClientVersion: 9,
      receivedClientVersion: null,
      detailsReported: true,
    });
  });

  it('latches a refusal whose details is absent', () => {
    expect(parseClientVersionRefusal(400, { error: CLIENT_VERSION_UNSUPPORTED })).toEqual({
      minimumClientVersion: null,
      receivedClientVersion: null,
      detailsReported: false,
    });
  });

  it('latches a refusal whose details is malformed and reads no minimum', () => {
    expect(parseClientVersionRefusal(400, refusalBody({
      minimum_client_version: 'nine',
      received_client_version: 'eight',
    }))).toEqual({
      minimumClientVersion: null,
      receivedClientVersion: null,
      detailsReported: true,
    });
  });

  it('latches a refusal whose details is not an object', () => {
    expect(parseClientVersionRefusal(400, refusalBody('nine'))).toEqual({
      minimumClientVersion: null,
      receivedClientVersion: null,
      detailsReported: false,
    });
  });

  it('does not treat another 400 body code as a refusal', () => {
    expect(parseClientVersionRefusal(400, refusalBody(
      { minimum_client_version: 9 },
      'VALIDATION_ERROR',
    ))).toBeNull();
  });

  it('does not treat a non-400 status as a refusal', () => {
    const body = refusalBody({ minimum_client_version: 9, received_client_version: 8 });

    expect(parseClientVersionRefusal(401, body)).toBeNull();
    expect(parseClientVersionRefusal(403, body)).toBeNull();
    expect(parseClientVersionRefusal(404, body)).toBeNull();
    expect(parseClientVersionRefusal(409, body)).toBeNull();
    expect(parseClientVersionRefusal(undefined, body)).toBeNull();
  });

  it('does not treat a non-object body as a refusal', () => {
    expect(parseClientVersionRefusal(400, undefined)).toBeNull();
    expect(parseClientVersionRefusal(400, null)).toBeNull();
    expect(parseClientVersionRefusal(400, 'not json')).toBeNull();
    expect(parseClientVersionRefusal(400, '')).toBeNull();
  });
});

describe('getClientVersionRefusal', () => {
  it('reads the refusal from an Axios-shaped failure', () => {
    const error = {
      response: {
        status: 400,
        data: refusalBody({ minimum_client_version: 9, received_client_version: 8 }),
      },
    };

    expect(getClientVersionRefusal(error)).toMatchObject({
      minimumClientVersion: 9,
      receivedClientVersion: 8,
    });
  });

  it('ignores a failure with no response', () => {
    expect(getClientVersionRefusal(new Error('network down'))).toBeNull();
    expect(getClientVersionRefusal({ response: undefined })).toBeNull();
    expect(getClientVersionRefusal(undefined)).toBeNull();
  });

  it('ignores a 400 whose body is not the refusal contract', () => {
    expect(getClientVersionRefusal({
      response: { status: 400, data: { error: 'VALIDATION_ERROR', message: 'nope' } },
    })).toBeNull();
  });
});
