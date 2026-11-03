// The declared interface values Vite compiles into the Client bundle.
//
// `pnpm build` records these values in `dist/build-metadata.json`, and the Beta
// deploy chain refuses a dispatch or a live Beta interface that differs from
// them. The contract lives in one module so the build and the publication
// assertions cannot drift apart: the same variables, the same shapes and the
// same rejection messages are used on both sides.

/** Build-time variables mapped to the key recorded in build-metadata.json. */
export const buildInterface = {
  api_base_url: {
    variable: 'VITE_API_BASE_URL',
    pattern: /^https:\/\/[^\s]+$/,
    requirement: 'an absolute https URL with no whitespace',
  },
  cognito_user_pool_id: {
    variable: 'VITE_COGNITO_USER_POOL_ID',
    pattern: /^[a-z]{2}(?:-gov)?-[a-z]+-\d_[A-Za-z0-9]+$/,
    requirement: 'an AWS Cognito user pool id such as ap-east-1_AbCdEfGhI',
  },
  cognito_client_id: {
    variable: 'VITE_COGNITO_CLIENT_ID',
    pattern: /^[a-z0-9]{26}$/,
    requirement: 'a 26-character lowercase Cognito app client id',
  },
};

/** Whether `value` has the shape the declared interface requires for `key`. */
export function isValidInterfaceValue(key, value) {
  const contract = buildInterface[key];
  return contract !== undefined && typeof value === 'string' && contract.pattern.test(value);
}

/**
 * The interface values recorded for a build, read from the same environment
 * Vite compiles. A missing or malformed value throws: recording metadata for an
 * interface that was never built would defeat the comparison `deploy` makes.
 */
export function readBuildInterface(environment = process.env) {
  return Object.fromEntries(Object.entries(buildInterface).map(([key, { variable, pattern, requirement }]) => {
    const value = environment[variable];
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new Error(`${variable} must be ${requirement}`);
    }
    return [key, value];
  }));
}
