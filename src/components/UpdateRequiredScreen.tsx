import { useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { CLIENT_VERSION } from '../lib/client-version';
import { isAndroidApp } from '../lib/platform';
import { useClientVersionRefusalStore } from '../store/clientVersionRefusalStore';

/**
 * The one published address a refused Android or desktop build can use. It is
 * the Releases page, never `releases/latest` or a tag deep-link: while every
 * published release is a prerelease, `/latest` names no build, and a tag stales
 * on the next release. The page answers 200 and carries the newest `client-v*`
 * APK, which is the only distribution channel the Android app has.
 */
export const CLIENT_RELEASES_URL = 'https://github.com/anywear-ai/AnyWear-Client/releases';

type CopyHint = 'idle' | 'copied' | 'manual';

/**
 * The blocking screen shown in place of the whole shell when the Service refuses
 * this build.
 *
 * It is terminal for the document: it offers exactly one platform-appropriate
 * way to a newer build and no way to dismiss the state. Nothing here offers a
 * retry, a wait or a pending state, because none of them can change the build.
 */
export default function UpdateRequiredScreen() {
  const refusal = useClientVersionRefusalStore((state) => state.refusal);
  const addressField = useRef<HTMLInputElement>(null);
  const [copyHint, setCopyHint] = useState<CopyHint>('idle');

  if (!refusal) return null;

  // `??` and never `||`: a reported `0` is a legitimate version.
  const buildVersion = refusal.receivedClientVersion ?? CLIENT_VERSION;
  const requiredVersion = refusal.minimumClientVersion;

  const inTauri = isTauri();
  const androidApp = inTauri && isAndroidApp();
  const desktopApp = inTauri && !androidApp;

  /** The platform's own selection is the copy route when the Clipboard API cannot run. */
  const selectAddress = () => {
    const field = addressField.current;
    setCopyHint('manual');
    if (!field) return;
    field.focus();
    field.select();
  };

  const copyAddress = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      selectAddress();
      return;
    }
    clipboard.writeText(CLIENT_RELEASES_URL).then(
      () => setCopyHint('copied'),
      () => selectAddress(),
    );
  };

  const copyInstruction = copyHint === 'copied'
    ? 'Address copied.'
    : copyHint === 'manual'
      ? 'The address is selected. Copy it with your device and open the newest release.'
      : androidApp
        ? 'Touch and hold the address to copy it, then install the newest release.'
        : 'Select the address to copy it, then open the newest release in a browser.';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-100 px-4">
      <div
        role="alert"
        className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm"
      >
        <h1 className="text-xl font-semibold text-gray-900">Update required</h1>
        <p className="mt-3 text-sm text-gray-700">
          {requiredVersion === null
            ? 'This app requires a newer version than the one you have, and the Service did not say which.'
            : `This app requires version ${requiredVersion}.`}
        </p>
        <p className="mt-1 text-sm text-gray-700">{`This build is version ${buildVersion}.`}</p>
        {refusal.detailsReported && refusal.receivedClientVersion === null ? (
          <p className="mt-1 text-sm text-gray-700">
            The Service did not receive a usable version from this build.
          </p>
        ) : null}

        {!inTauri ? (
          <div className="mt-6">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              Reload
            </button>
          </div>
        ) : (
          <div className="mt-6 text-left">
            {desktopApp ? (
              <p className="mb-3 text-sm text-gray-700">
                No desktop build is published for this platform.
              </p>
            ) : null}
            <label htmlFor="client-version-releases" className="block text-sm font-medium text-gray-900">
              Releases page address
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="client-version-releases"
                ref={addressField}
                type="text"
                readOnly
                value={CLIENT_RELEASES_URL}
                className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={copyAddress}
                className="inline-flex shrink-0 items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
              >
                Copy
              </button>
            </div>
            <p className="mt-2 text-sm text-gray-600">{copyInstruction}</p>
          </div>
        )}
      </div>
    </div>
  );
}
