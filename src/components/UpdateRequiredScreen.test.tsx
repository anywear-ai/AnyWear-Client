// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import UpdateRequiredScreen, { CLIENT_RELEASES_URL } from './UpdateRequiredScreen';
import { CLIENT_VERSION } from '../lib/client-version';
import { useClientVersionRefusalStore } from '../store/clientVersionRefusalStore';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240105.004) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

function latch(minimumClientVersion: number | null, receivedClientVersion: number | null, detailsReported = true) {
  useClientVersionRefusalStore.setState({
    refusal: { minimumClientVersion, receivedClientVersion, detailsReported },
  });
}

/**
 * Places the bundle in a shell, gives it that shell's user agent, and installs a
 * clipboard stub when the case needs one.
 */
function stubPlatform(
  shell: 'web' | 'android' | 'desktop',
  clipboard?: { writeText: (address: string) => Promise<void> },
) {
  vi.stubGlobal('isTauri', shell !== 'web');
  const userAgent = shell === 'android' ? ANDROID_UA : WINDOWS_UA;
  vi.stubGlobal('navigator', clipboard ? { userAgent, clipboard } : { userAgent });
}

beforeEach(() => {
  useClientVersionRefusalStore.setState({ refusal: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UpdateRequiredScreen', () => {
  it('states the required version and the version the Service received', () => {
    latch(9, 8);
    stubPlatform('web');

    render(<UpdateRequiredScreen />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('This app requires version 9.')).toBeInTheDocument();
    expect(screen.getByText('This build is version 8.')).toBeInTheDocument();
  });

  it('prints the compiled version and the no-usable-version sentence when the body reports null', () => {
    latch(9, null);
    stubPlatform('web');

    render(<UpdateRequiredScreen />);

    expect(screen.getByText('This app requires version 9.')).toBeInTheDocument();
    expect(screen.getByText(`This build is version ${CLIENT_VERSION}.`)).toBeInTheDocument();
    expect(screen.getByText('The Service did not receive a usable version from this build.')).toBeInTheDocument();
  });

  it('shows a reported zero rather than falling back to the compiled version', () => {
    latch(9, 0);
    stubPlatform('web');

    render(<UpdateRequiredScreen />);

    expect(screen.getByText('This build is version 0.')).toBeInTheDocument();
  });

  it('names no required version when the body carried none', () => {
    latch(null, null, false);
    stubPlatform('web');

    render(<UpdateRequiredScreen />);

    expect(screen.getByText(/requires a newer version than the one you have/)).toBeInTheDocument();
    expect(screen.queryByText(/requires version \d/)).toBeNull();
    expect(screen.getByText(`This build is version ${CLIENT_VERSION}.`)).toBeInTheDocument();
  });

  it('renders nothing before a refusal is latched', () => {
    stubPlatform('web');

    const { container } = render(<UpdateRequiredScreen />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('the web action', () => {
  it('is one Reload control that reloads the document exactly once', () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    latch(9, 8);
    stubPlatform('web');

    render(<UpdateRequiredScreen />);

    const controls = screen.getAllByRole('button');
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveTextContent('Reload');
    fireEvent.click(controls[0]);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('the Android and desktop action', () => {
  it('is the exact Releases address in a read-only field beside one copy control', () => {
    latch(9, 8);
    stubPlatform('android');

    render(<UpdateRequiredScreen />);

    const field = screen.getByRole('textbox') as HTMLInputElement;
    expect(field.value).toBe('https://github.com/anywear-ai/AnyWear-Client/releases');
    expect(field.value).toBe(CLIENT_RELEASES_URL);
    expect(field.readOnly).toBe(true);
    const controls = screen.getAllByRole('button');
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveTextContent('Copy');
    expect(screen.queryByText('No desktop build is published for this platform.')).toBeNull();
  });

  it('writes the exact string once through the Clipboard API', async () => {
    latch(9, 8);
    stubPlatform('android', { writeText: vi.fn().mockResolvedValue(undefined) });

    render(<UpdateRequiredScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CLIENT_RELEASES_URL);
    expect(await screen.findByText('Address copied.')).toBeInTheDocument();
  });

  it('selects the whole field and claims nothing when the Clipboard API is absent', () => {
    latch(9, 8);
    stubPlatform('android');

    render(<UpdateRequiredScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    const field = screen.getByRole('textbox') as HTMLInputElement;
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(CLIENT_RELEASES_URL.length);
    expect(screen.queryByText(/copied/i)).toBeNull();
    expect(screen.getByText(/Copy it with your device/)).toBeInTheDocument();
  });

  it('takes the same path when the Clipboard API rejects', async () => {
    latch(9, 8);
    stubPlatform('android', { writeText: vi.fn().mockRejectedValue(new Error('denied')) });

    render(<UpdateRequiredScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    // The rejection is handled in a microtask, so the fallback lands after the click.
    expect(await screen.findByText(/Copy it with your device/)).toBeInTheDocument();
    const field = screen.getByRole('textbox') as HTMLInputElement;
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(CLIENT_RELEASES_URL.length);
    expect(screen.queryByText(/copied/i)).toBeNull();
  });

  it('adds the no-desktop-build sentence for a desktop shell', () => {
    latch(9, 8);
    stubPlatform('desktop');

    render(<UpdateRequiredScreen />);

    expect(screen.getByText('No desktop build is published for this platform.')).toBeInTheDocument();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(CLIENT_RELEASES_URL);
  });
});

describe('what the screen never renders', () => {
  it.each(['web', 'android', 'desktop'] as const)('offers no wait, retry or navigation in the %s shell', (shell) => {
    latch(9, 8);
    stubPlatform(shell);

    render(<UpdateRequiredScreen />);

    expect(screen.queryByText(/retry/i)).toBeNull();
    expect(screen.queryByText(/try again/i)).toBeNull();
    expect(screen.queryByText(/please wait/i)).toBeNull();
    expect(screen.queryByText(/loading/i)).toBeNull();
    expect(screen.queryByText(/checking/i)).toBeNull();
    expect(screen.queryByText(/logout/i)).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector('[class*="animate-spin"]')).toBeNull();
    expect(document.querySelector('[class*="animate-pulse"]')).toBeNull();
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});
