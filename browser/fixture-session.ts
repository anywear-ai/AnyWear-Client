// Framework-neutral fixture session shared by the Playwright suite and the
// packaged smoke entry. It imports no Playwright type: the smoke build compiles
// it into the WebView bundle, and `mockAmplifySession` serialises
// `seedAmplifySession.toString()` into an init script.
//
// These are unsigned synthetic tokens for a fixed fictitious pool/client. They
// create no real Cognito identity and are only valid against mocked Service and
// cloud boundaries.

export const MOCK_USER_POOL_ID = 'us-east-1_mockpool';
export const MOCK_USER_POOL_CLIENT_ID = 'mock-client-id';

type AmplifySessionStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Seed Amplify's local session storage with the fixture tokens.
 *
 * This function is self-contained on purpose: `mockAmplifySession` serialises it
 * with `toString()`, and `smoke/entry.tsx` calls the same source directly. It may
 * use only its parameters and browser globals (`btoa`, `JSON`, `Date`).
 */
export function seedAmplifySession(storage: AmplifySessionStorage, expiresIn = 86_400): void {
  const username = 'test-user';
  // A literal, not the module constant: serialising the function must not leave a
  // reference the injected script cannot resolve.
  const clientId = 'mock-client-id';
  const encode = (payload: Record<string, unknown>) => btoa(JSON.stringify(payload))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = (tokenUse: string) => `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    sub: 'test-user-id', 'cognito:username': username, token_use: tokenUse,
    exp: Math.floor(Date.now() / 1000) + expiresIn,
    iat: Math.floor(Date.now() / 1000),
  })}.fixture`;
  const prefix = `CognitoIdentityServiceProvider.${clientId}`;
  if (storage.getItem(`${prefix}.LastAuthUser`)) return;
  storage.setItem(`${prefix}.LastAuthUser`, username);
  storage.setItem(`${prefix}.${username}.accessToken`, token('access'));
  storage.setItem(`${prefix}.${username}.idToken`, token('id'));
  storage.setItem(`${prefix}.${username}.clockDrift`, '0');
}
