/**
 * The platform fact behind the capture entries.
 *
 * One bundle serves the web build, the desktop (Tauri) client and the Android
 * app, and only the Android shell has a camera behind a `capture` hint: WebView2
 * on Windows and WKWebView on macOS open the same file picker for it, so a second
 * entry there promises a camera the platform cannot show. The runtime already
 * knows which shell it is in, so one module answers that for every photo surface
 * and nothing branches on width, orientation or pointer input.
 */

import { isTauri } from '@tauri-apps/api/core';

/**
 * True only inside the Android shell. `isTauri()` alone cannot tell Android from
 * a desktop WebView, and the Android WebView's user agent carries the `Android`
 * token; a phone browser fails the first test, so it keeps the web build's one
 * upload entry.
 */
export function resolveIsAndroidApp(isTauriApp: boolean, userAgent: string): boolean {
  return isTauriApp && /Android/i.test(userAgent);
}

/** True when this bundle runs inside the Android app; false everywhere else. */
export function isAndroidApp(): boolean {
  if (typeof navigator === 'undefined') return false;
  return resolveIsAndroidApp(isTauri(), navigator.userAgent);
}
