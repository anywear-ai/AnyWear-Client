import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import type { SignedUploadPost } from './imageUpload';
import {
  CONFIRM_CHECK_WARDROBE_HINT,
  MAX_BATCH_BYTES,
  MAX_BATCH_PHOTOS,
  MAX_CONCURRENT_UPLOADS,
  createBatchPhotos,
  fileKey,
  planBatch,
  runBatch,
  type BatchPhoto,
  type BatchUploadDeps,
} from './batchUpload';

/**
 * The batch policy is framework-free: these tests drive it with plain objects and
 * injected dependencies, so no DOM, hook, network or Service is involved.
 */
function photoFile(name: string, size = 1024, lastModified = 1_700_000_000_000): File {
  return { name, size, lastModified, type: 'image/jpeg' } as unknown as File;
}

/** An Axios-shaped failure: the generated hooks reject with the response status. */
function httpError(status: number): Error & { response: { status: number } } {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Recording {
  steps: Array<{ name: string; status: string }>;
  latest: Map<string, BatchPhoto>;
  onChange: (photo: BatchPhoto) => void;
}

function recorder(): Recording {
  const steps: Array<{ name: string; status: string }> = [];
  const latest = new Map<string, BatchPhoto>();
  return {
    steps,
    latest,
    onChange(photo) {
      latest.set(photo.file.name, photo);
      steps.push({ name: photo.file.name, status: photo.status });
    },
  };
}

interface StubDeps extends BatchUploadDeps {
  prepare: MockedFunction<NonNullable<BatchUploadDeps['prepare']>>;
  reserve: MockedFunction<BatchUploadDeps['reserve']>;
  postBytes: MockedFunction<BatchUploadDeps['postBytes']>;
  confirm: MockedFunction<BatchUploadDeps['confirm']>;
}

function stubDeps(overrides: Partial<BatchUploadDeps> = {}): StubDeps {
  const deps = {
    prepare: vi.fn(async (file: File) => file),
    reserve: vi.fn(async (file: File) => ({
      reservationId: `res-${file.name}`,
      upload: { url: 'https://s3.example.com/upload', fields: { key: file.name } },
    })),
    postBytes: vi.fn(async () => undefined),
    confirm: vi.fn(async (reservationId: string) => ({
      itemId: `item-${reservationId}`,
      taggingStatus: 'processing',
    })),
    ...overrides,
  };
  return deps as unknown as StubDeps;
}

async function settle(photos: BatchPhoto[], deps: BatchUploadDeps): Promise<Recording> {
  const record = recorder();
  const run = runBatch(photos, deps, record.onChange);
  await run.settled;
  return record;
}

describe('planBatch', () => {
  it('keeps at most fifty photos in one action and reports the ones it did not add', () => {
    const files = Array.from({ length: 53 }, (_, index) => photoFile(`photo-${index}.png`));

    const plan = planBatch(files);

    expect(MAX_BATCH_PHOTOS).toBe(50);
    expect(plan.files.map((file) => file.name)).toEqual(
      files.slice(0, MAX_BATCH_PHOTOS).map((file) => file.name),
    );
    expect(plan.notAdded).toBe(3);
    expect(plan.message).toBe('50 of 53 selected — 3 were not added');
    expect(plan.duplicateMessage).toBeNull();
  });

  it('trims the fifty-first photo and reports the count', () => {
    const files = Array.from({ length: 51 }, (_, index) => photoFile(`extra-${index}.png`));

    const plan = planBatch(files);

    expect(plan.files).toHaveLength(50);
    expect(plan.files[49].name).toBe('extra-49.png');
    expect(plan.notAdded).toBe(1);
    expect(plan.message).toBe('50 of 51 selected — 1 was not added');
  });

  it('keeps the longest prefix inside the 300 MiB action bound', () => {
    const tenMiB = 10 * 1024 * 1024;
    const files = Array.from({ length: 31 }, (_, index) => photoFile(`big-${index}.png`, tenMiB));

    const plan = planBatch(files);

    expect(MAX_BATCH_BYTES).toBe(300 * 1024 * 1024);
    expect(plan.files).toHaveLength(30);
    expect(plan.notAdded).toBe(1);
    expect(plan.message).toBe('30 of 31 selected — 1 was not added');
  });

  it('collapses duplicates on name, size and lastModified so one file produces one item', () => {
    const first = photoFile('linen-shirt.png', 2048, 111);
    const again = photoFile('linen-shirt.png', 2048, 111);
    const differentSize = photoFile('linen-shirt.png', 2049, 111);

    const plan = planBatch([first, again, differentSize]);

    expect(fileKey(first)).toBe(fileKey(again));
    expect(plan.files).toEqual([first, differentSize]);
    expect(plan.duplicates).toBe(1);
    expect(plan.duplicateMessage).toBe('1 duplicate photo was skipped');
    expect(plan.notAdded).toBe(0);
    expect(plan.message).toBeNull();
  });
});

describe('createBatchPhotos', () => {
  it('fails a photo the per-photo rules refuse, before any request', async () => {
    const heic = { name: 'IMG_0001.HEIC', size: 1024, lastModified: 1, type: '' } as unknown as File;
    const oversize = photoFile('huge.jpg', 31 * 1024 * 1024);
    const notAnImage = { name: 'notes.txt', size: 10, lastModified: 1, type: 'text/plain' } as unknown as File;

    const photos = createBatchPhotos([heic, oversize, notAnImage]);

    expect(photos.map((photo) => photo.status)).toEqual(['failed', 'failed', 'failed']);
    expect(photos.every((photo) => photo.failureKind === 'precheck')).toBe(true);
    expect(photos[0].error).toContain('HEIC/HEIF');
    expect(photos[1].error).toBe('Image must be 30MB or smaller');
    expect(photos[2].error).toBe('Select an image file');

    const deps = stubDeps();
    const record = await settle(photos, deps);
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.postBytes).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(record.latest.get('IMG_0001.HEIC')?.status).toBe('failed');

    // Retry re-runs the same check and still sends no request.
    const retry = await settle([...record.latest.values()], deps);
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(retry.latest.get('huge.jpg')?.failureKind).toBe('precheck');
  });
});

describe('runBatch', () => {
  it('runs one photo\u2019s three calls in order and keeps up to three photos in flight', async () => {
    const files = Array.from({ length: 4 }, (_, index) => photoFile(`p-${index}.png`));
    const gates = files.map(() => deferred<void>());
    const order: string[] = [];
    const deps = stubDeps({
      reserve: vi.fn(async (file: File) => {
        const index = Number(file.name.replace('p-', '').replace('.png', ''));
        order.push(`reserve:${file.name}`);
        // A queued photo holds no reservation: the reserve call is what starts it.
        await gates[index].promise;
        return { reservationId: `res-${index}`, upload: { url: 'https://s3.example.com/upload', fields: {} } };
      }),
      postBytes: vi.fn(async (_upload: SignedUploadPost, file: File) => {
        order.push(`post:${file.name}`);
      }),
      confirm: vi.fn(async (reservationId: string) => {
        order.push(`confirm:${reservationId}`);
        return { itemId: `item-${reservationId}`, taggingStatus: 'processing' };
      }),
    });

    const photos = createBatchPhotos(files);
    const record = recorder();
    const run = runBatch(photos, deps, record.onChange);

    // Three slots start; the fourth photo is still queued and holds no reservation.
    // Preparation is asynchronous even when it succeeds, so the reservations are
    // observed once each started photo has finished preparing.
    expect(MAX_CONCURRENT_UPLOADS).toBe(3);
    await vi.waitFor(() => expect(deps.reserve).toHaveBeenCalledTimes(3));
    expect(deps.reserve.mock.calls.map(([file]) => (file as File).name)).toEqual([
      'p-0.png',
      'p-1.png',
      'p-2.png',
    ]);
    expect(photos[3].status).toBe('queued');
    expect(photos[3].reservationId).toBeUndefined();
    expect(deps.confirm).not.toHaveBeenCalled();

    gates[0].resolve();
    await vi.waitFor(() => expect(deps.reserve).toHaveBeenCalledTimes(4));
    expect(deps.reserve.mock.calls[3][0]).toMatchObject({ name: 'p-3.png' });

    gates.slice(1).forEach((gate) => gate.resolve());
    await run.settled;

    expect(order.filter((entry) => entry.endsWith('p-0.png') || entry === 'confirm:res-0')).toEqual([
      'reserve:p-0.png',
      'post:p-0.png',
      'confirm:res-0',
    ]);
    expect(record.latest.get('p-3.png')?.status).toBe('created');
    expect([...record.latest.values()].every((photo) => photo.status === 'created')).toBe(true);
  });

  it('runs three photos through three reservations, three posts and three confirmations', async () => {
    const files = [photoFile('one.png'), photoFile('two.png'), photoFile('three.png')];
    let inFlight = 0;
    let peakInFlight = 0;

    /** Counts a dependency call as one in-flight photo call and records the peak. */
    async function tracked<T>(value: T): Promise<T> {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value;
    }

    const deps = stubDeps({
      reserve: vi.fn(async (file: File) => tracked({
        reservationId: `res-${file.name}`,
        upload: { url: 'https://s3.example.com/upload', fields: {} },
      })),
      postBytes: vi.fn(async () => tracked(undefined)),
      confirm: vi.fn(async (reservationId: string) => tracked({
        itemId: `item-${reservationId}`,
        taggingStatus: 'processing',
      })),
    });

    const record = await settle(createBatchPhotos(files), deps);

    // One all-success round: three reservations, three S3 posts, three confirmations.
    expect(deps.reserve).toHaveBeenCalledTimes(3);
    expect(deps.postBytes).toHaveBeenCalledTimes(3);
    expect(deps.confirm).toHaveBeenCalledTimes(3);

    const created = files.map((file) => record.latest.get(file.name));
    expect(created.map((photo) => photo?.status)).toEqual(['created', 'created', 'created']);
    // Three items, never fewer: the confirmation ids are the three distinct reservations.
    const itemIds = created.map((photo) => photo?.itemId);
    expect(itemIds.every(Boolean)).toBe(true);
    expect(new Set(itemIds).size).toBe(3);
    // No more photos than the runner's slots were ever in flight together.
    expect(peakInFlight).toBeLessThanOrEqual(MAX_CONCURRENT_UPLOADS);
  });

  it('prepares each photo before reserving and reserves and posts the prepared file', async () => {
    const deps = stubDeps({
      prepare: vi.fn(async (file: File) => new File([file], `prepared-${file.name}`, { type: 'image/jpeg' })),
    });

    const record = await settle(createBatchPhotos([photoFile('a.png'), photoFile('b.png')]), deps);

    // One preparation per photo, and the reservation and the S3 body both carry
    // the prepared bytes rather than the original file.
    expect(deps.prepare).toHaveBeenCalledTimes(2);
    expect(deps.reserve.mock.calls.map(([file]) => file.name)).toEqual(['prepared-a.png', 'prepared-b.png']);
    expect(deps.postBytes.mock.calls.map(([, file]) => file.name)).toEqual(['prepared-a.png', 'prepared-b.png']);
    const statuses = record.steps.filter((step) => step.name === 'a.png').map((step) => step.status);
    expect(statuses[0]).toBe('preparing');
    expect(statuses).toContain('reserving');
    expect(record.latest.get('a.png')?.status).toBe('created');
  });

  it('fails a photo whose preparation throws without any request, then re-prepares it on Retry', async () => {
    const prepare = vi.fn()
      .mockRejectedValueOnce(new Error('Could not process this image'))
      .mockImplementation(async (file: File) => file);
    const deps = stubDeps({ prepare });

    const first = await settle(createBatchPhotos([photoFile('broken.jpg')]), deps);

    expect(first.latest.get('broken.jpg')).toMatchObject({
      status: 'failed',
      failureKind: 'prepare',
      error: 'Could not process this image',
    });
    // A decode failure reserves nothing: no request could describe bytes that do
    // not exist.
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.postBytes).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();

    const retry = await settle([first.latest.get('broken.jpg')!], deps);

    expect(retry.latest.get('broken.jpg')?.status).toBe('created');
    expect(prepare).toHaveBeenCalledTimes(2);
    // The retry re-pre-processes and then makes the normal three calls once.
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
  });

  it('fails one photo without aborting or blocking the others', async () => {
    const files = [photoFile('a.png'), photoFile('b.png'), photoFile('c.png')];
    const deps = stubDeps({
      reserve: vi.fn(async (file: File) => {
        if (file.name === 'b.png') throw httpError(500);
        return { reservationId: `res-${file.name}`, upload: { url: 'https://s3.example.com/upload', fields: {} } };
      }),
    });

    const record = await settle(createBatchPhotos(files), deps);

    expect(record.latest.get('a.png')?.status).toBe('created');
    expect(record.latest.get('c.png')?.status).toBe('created');
    expect(record.latest.get('b.png')).toMatchObject({
      status: 'failed',
      failureKind: 'reserve',
      error: 'Request failed with status code 500',
    });
    // A 5xx on the reserve gets the same single automatic retry as a lost connection.
    expect(deps.reserve.mock.calls.filter(([file]) => (file as File).name === 'b.png')).toHaveLength(2);
    expect(deps.confirm).toHaveBeenCalledTimes(2);
  });

  it('re-reserves and re-posts once on a 410 and still creates exactly one item', async () => {
    const deps = stubDeps({
      reserve: vi.fn(async () => {
        const call = deps.reserve.mock.calls.length;
        return { reservationId: `res-${call}`, upload: { url: 'https://s3.example.com/upload', fields: {} } };
      }),
      confirm: vi.fn()
        .mockRejectedValueOnce(httpError(410))
        .mockResolvedValueOnce({ itemId: 'item-1', taggingStatus: 'processing' }),
    });

    const record = await settle(createBatchPhotos([photoFile('coat.png')]), deps);

    expect(record.latest.get('coat.png')).toMatchObject({
      status: 'created',
      itemId: 'item-1',
      failureKind: undefined,
    });
    expect(deps.reserve).toHaveBeenCalledTimes(2);
    expect(deps.postBytes).toHaveBeenCalledTimes(2);
    expect(deps.confirm).toHaveBeenCalledTimes(2);
    // The second confirmation belongs to a fresh reservation, so only one item exists.
    expect(deps.confirm.mock.calls[0][0]).not.toBe(deps.confirm.mock.calls[1][0]);
  });

  it('fails a photo on a second 410 instead of duplicating it', async () => {
    const deps = stubDeps({
      reserve: vi.fn(async () => {
        const call = deps.reserve.mock.calls.length;
        return { reservationId: `res-${call}`, upload: { url: 'https://s3.example.com/upload', fields: {} } };
      }),
      confirm: vi.fn(async () => {
        throw httpError(410);
      }),
    });

    const record = await settle(createBatchPhotos([photoFile('coat.png')]), deps);

    expect(record.latest.get('coat.png')).toMatchObject({
      status: 'failed',
      failureKind: 'expired',
      error: 'Request failed with status code 410',
    });
    expect(deps.reserve).toHaveBeenCalledTimes(2);
    expect(deps.postBytes).toHaveBeenCalledTimes(2);
    expect(deps.confirm).toHaveBeenCalledTimes(2);
  });

  it.each([404, 409])(
    'starts a fresh reservation on Retry after a %i closed the first one',
    async (status) => {
      let confirmations = 0;
      const deps = stubDeps({
        reserve: vi.fn(async () => {
          const call = deps.reserve.mock.calls.length;
          return { reservationId: `res-${call}`, upload: { url: 'https://s3.example.com/upload', fields: {} } };
        }),
        confirm: vi.fn(async () => {
          confirmations += 1;
          if (confirmations === 1) throw httpError(status);
          return { itemId: 'item-9', taggingStatus: 'processing' };
        }),
      });

      const first = await settle(createBatchPhotos([photoFile('shirt.png')]), deps);
      expect(first.latest.get('shirt.png')).toMatchObject({
        status: 'failed',
        failureKind: 'terminal',
        reservationId: 'res-1',
      });

      const retry = await settle([first.latest.get('shirt.png')!], deps);

      expect(retry.latest.get('shirt.png')).toMatchObject({ status: 'created', itemId: 'item-9' });
      expect(deps.reserve).toHaveBeenCalledTimes(2);
      expect(deps.postBytes).toHaveBeenCalledTimes(2);
      expect(deps.confirm.mock.calls.map(([id]) => id)).toEqual(['res-1', 'res-2']);
    },
  );

  it('retries a 5xx confirmation once against the same reservation, which replays the committed item', async () => {
    const deps = stubDeps({
      confirm: vi.fn(async () => {
        if (deps.confirm.mock.calls.length === 1) throw httpError(503);
        return { itemId: 'item-7', taggingStatus: 'processing' };
      }),
    });

    const record = await settle(createBatchPhotos([photoFile('dress.png')]), deps);

    // One reservation, one item: the automatic retry re-confirms the same reservation,
    // and a confirmed reservation replays its committed item instead of writing a second.
    expect(record.latest.get('dress.png')).toMatchObject({
      status: 'created',
      itemId: 'item-7',
      taggingStatus: 'processing',
    });
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.postBytes).toHaveBeenCalledTimes(1);
    expect(deps.confirm.mock.calls.map(([id]) => id)).toEqual(['res-dress.png', 'res-dress.png']);
  });

  it('names the wardrobe when a confirmation answers 5xx twice', async () => {
    const deps = stubDeps({
      confirm: vi.fn(async () => {
        throw httpError(500);
      }),
    });

    const record = await settle(createBatchPhotos([photoFile('coat.png')]), deps);

    // Both the first attempt and its automatic retry were 5xx, so the item may
    // already be committed and the row says where to look.
    expect(record.latest.get('coat.png')).toMatchObject({
      status: 'failed',
      failureKind: 'confirm',
      reservationId: 'res-coat.png',
    });
    expect(record.latest.get('coat.png')?.error).toContain(CONFIRM_CHECK_WARDROBE_HINT);
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.confirm).toHaveBeenCalledTimes(2);
  });

  it('re-confirms the same reservation on Retry after a lost response', async () => {
    const deps = stubDeps({
      confirm: vi.fn(async () => {
        throw new Error('Network Error');
      }),
    });

    const first = await settle(createBatchPhotos([photoFile('dress.png')]), deps);
    expect(first.latest.get('dress.png')).toMatchObject({
      status: 'failed',
      failureKind: 'confirm',
      reservationId: 'res-dress.png',
    });

    // The item the first attempt may have committed replays instead of a second write.
    deps.confirm.mockImplementation(async () => ({ itemId: 'item-committed', taggingStatus: 'processing' }));
    const retry = await settle([first.latest.get('dress.png')!], deps);

    expect(retry.latest.get('dress.png')).toMatchObject({
      status: 'created',
      itemId: 'item-committed',
    });
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.postBytes).toHaveBeenCalledTimes(1);
    expect(deps.confirm.mock.calls.every(([id]) => id === 'res-dress.png')).toBe(true);
  });

  it('starts no photo that had not started when the run is cancelled', async () => {
    const files = Array.from({ length: 4 }, (_, index) => photoFile(`p-${index}.png`));
    const gates = files.map(() => deferred<void>());
    const deps = stubDeps({
      reserve: vi.fn(async (file: File) => {
        const index = Number(file.name.replace('p-', '').replace('.png', ''));
        await gates[index].promise;
        return { reservationId: `res-${index}`, upload: { url: 'https://s3.example.com/upload', fields: {} } };
      }),
    });

    const record = recorder();
    const run = runBatch(createBatchPhotos(files), deps, record.onChange);
    run.cancel();
    gates.forEach((gate) => gate.resolve());

    await run.settled;

    expect(run.cancelled).toBe(true);
    // Only the three photos already in flight ever reserved anything.
    expect(deps.reserve).toHaveBeenCalledTimes(MAX_CONCURRENT_UPLOADS);
    expect(record.latest.has('p-3.png')).toBe(false);
  });
});
