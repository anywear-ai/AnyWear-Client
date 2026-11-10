import { afterEach, describe, expect, it, vi } from 'vitest';

import { isAndroidApp, resolveIsAndroidApp } from './platform';

/** The Android WebView's identity: `Android` plus the device build. */
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240105.004) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36';
/** WebView2 on Windows: a Tauri shell with no Android token. */
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
/** WKWebView on macOS: the other desktop Tauri shell. */
const MACOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

describe('resolveIsAndroidApp', () => {
  it('is true in the Android app', () => {
    expect(resolveIsAndroidApp(true, ANDROID_UA)).toBe(true);
  });

  it('is false in a phone browser, where the Android token is not enough', () => {
    expect(resolveIsAndroidApp(false, ANDROID_UA)).toBe(false);
  });

  it('is false in the Windows desktop client', () => {
    expect(resolveIsAndroidApp(true, WINDOWS_UA)).toBe(false);
  });

  it('is false in the macOS desktop client', () => {
    expect(resolveIsAndroidApp(true, MACOS_UA)).toBe(false);
  });
});

describe('isAndroidApp', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when there is no navigator', () => {
    vi.stubGlobal('navigator', undefined);

    expect(isAndroidApp()).toBe(false);
  });

  it('is true in the Android app', () => {
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('navigator', { userAgent: ANDROID_UA });

    expect(isAndroidApp()).toBe(true);
  });

  it('is false in a phone browser with an Android user agent', () => {
    vi.stubGlobal('navigator', { userAgent: ANDROID_UA });

    expect(isAndroidApp()).toBe(false);
  });

  it('is false in the desktop client', () => {
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('navigator', { userAgent: WINDOWS_UA });

    expect(isAndroidApp()).toBe(false);
  });
});
