// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  coverPlaceholder,
  outfitActionLabel,
  outfitCoverState,
  outfitLookIsImageUnavailable,
  outfitWasNeverGenerated,
} from './outfitCover';

const NEVER_GENERATED = { latestGeneration: null, look: null };
const COMPLETED = { id: 'gen-1', status: 'Complete' };

describe('never generated', () => {
  it('is exactly latestGeneration null and look null', () => {
    expect(outfitWasNeverGenerated(NEVER_GENERATED)).toBe(true);
    expect(outfitWasNeverGenerated({ latestGeneration: undefined })).toBe(true);
    expect(outfitWasNeverGenerated({ latestGeneration: COMPLETED, look: null })).toBe(false);
    expect(outfitWasNeverGenerated({ latestGeneration: null, look: { generationId: 'gen-1', url: null } })).toBe(false);
  });

  it('paints the placeholder and Generate look', () => {
    expect(outfitWasNeverGenerated(NEVER_GENERATED)).toBe(true);
    expect(outfitCoverState(NEVER_GENERATED)).toBe('never-generated');
    expect(coverPlaceholder(outfitCoverState(NEVER_GENERATED))).toBe('No look yet');
    expect(outfitActionLabel(NEVER_GENERATED)).toBe('Generate look');
  });
});

describe('image unavailable', () => {
  it('is a look with a generation id and no url', () => {
    expect(outfitLookIsImageUnavailable({ latestGeneration: COMPLETED, look: { generationId: 'gen-1', url: null } })).toBe(true);
    expect(outfitLookIsImageUnavailable({ latestGeneration: COMPLETED, look: { generationId: 'gen-1', url: 'https://example.com/a.png' } })).toBe(false);
    expect(outfitLookIsImageUnavailable(NEVER_GENERATED)).toBe(false);
  });

  it('paints Image unavailable and New look', () => {
    const unsigned = { latestGeneration: COMPLETED, look: { generationId: 'gen-1', url: null } };
    expect(outfitCoverState(unsigned)).toBe('image-unavailable');
    expect(coverPlaceholder('image-unavailable')).toBe('Image unavailable');
    expect(outfitActionLabel(unsigned)).toBe('New look');
  });
});

describe('the two no-image states never collapse', () => {
  it('keeps a saved-without-look outfit out of the image-unavailable state', () => {
    expect(outfitCoverState(NEVER_GENERATED)).not.toBe('image-unavailable');
    expect(outfitLookIsImageUnavailable(NEVER_GENERATED)).toBe(false);
  });

  it('keeps a completed record with an unsigned url out of the never-generated state', () => {
    const unsigned = { latestGeneration: COMPLETED, look: { generationId: 'gen-1', url: null } };
    expect(outfitCoverState(unsigned)).not.toBe('never-generated');
    expect(outfitWasNeverGenerated(unsigned)).toBe(false);
  });
});

describe('the other three states', () => {
  it('paints a signed look first, even when the latest generation failed', () => {
    const failedWithLook = {
      latestGeneration: { id: 'gen-2', status: 'Failed' },
      look: { generationId: 'gen-1', url: 'https://example.com/a.png' },
    };
    expect(outfitCoverState(failedWithLook)).toBe('look');
    expect(outfitActionLabel(failedWithLook)).toBe('Retry');
    expect(coverPlaceholder('look')).toBeNull();
  });

  it('paints a running generation over both no-image states, with no action', () => {
    const running = { latestGeneration: { id: 'gen-2', status: 'Processing' }, look: null };
    expect(outfitCoverState(running)).toBe('generating');
    expect(coverPlaceholder('generating')).toBeNull();
  });

  it('paints a failed last generation without a look and offers Retry', () => {
    const failed = { latestGeneration: { id: 'gen-2', status: 'Failed' }, look: null };
    expect(outfitCoverState(failed)).toBe('failed');
    expect(coverPlaceholder('failed')).toBe('Last try-on failed');
    expect(outfitActionLabel(failed)).toBe('Retry');
  });
});
