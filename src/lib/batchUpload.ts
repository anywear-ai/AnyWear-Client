import { getErrorMessage, getHttpStatus } from './errors';
import { validateImageFile, type SignedUploadPost } from './imageUpload';

/**
 * The batch policy of the wardrobe's Add Item action.
 *
 * The Client drives the unchanged per-photo endpoints once per photo: reserve
 * (`POST /wardrobe/upload-url`), post the bytes through the signed S3 policy,
 * then confirm (`POST /wardrobe/upload`). This module holds the whole policy —
 * the action bounds, the duplicate collapse, the per-photo state machine, the
 * failure rules and the three-slot runner — so it can be unit-tested without a
 * DOM, a React hook or a network.
 *
 * Each photo's reservation is created immediately before that photo's own
 * upload. A photo waiting in the queue therefore holds no reservation, and the
 * Service's 15-minute confirmation window covers one photo rather than the batch.
 */

/** Every photo one action accepts. */
export const MAX_BATCH_PHOTOS = 10;
/** Every photo's bytes, summed, that one action accepts. */
export const MAX_BATCH_BYTES = 60 * 1024 * 1024;
/** Photos whose three calls may be in flight at once; one photo's calls are sequential. */
export const MAX_CONCURRENT_UPLOADS = 3;

export type BatchPhotoStatus =
  | 'queued'
  | 'reserving'
  | 'uploading'
  | 'confirming'
  | 'created'
  | 'failed';

/**
 * What a failed photo's Retry should do with its reservation.
 *
 * `precheck` never made a request, so Retry re-runs the local rules and sends
 * nothing. `confirm` failed on a 5xx or on the network, so the reservation may
 * have committed and Retry re-confirms the same one, which replays the committed
 * item instead of writing a second. Everything else (`reserve`, `upload`,
 * `expired`, `terminal`) holds no usable reservation, so Retry starts a fresh
 * one and uploads the photo again.
 */
export type BatchFailureKind =
  | 'precheck'
  | 'reserve'
  | 'upload'
  | 'expired'
  | 'terminal'
  | 'confirm';

export interface BatchPhoto {
  id: string;
  file: File;
  status: BatchPhotoStatus;
  /** The item this photo became, once confirmed. */
  itemId?: string;
  /** The item's tagging status known at its confirmation. */
  taggingStatus?: string;
  /** The cause shown on a failed row. */
  error?: string;
  failureKind?: BatchFailureKind;
  /** The reservation this photo currently holds, if any. */
  reservationId?: string;
}

/** One photo's selection outcome, before anything is sent. */
export interface BatchSelection {
  /** The photos the action keeps, in selection order. */
  files: File[];
  /** Files that repeated an earlier selection and produced one row between them. */
  duplicates: number;
  /** Photos past the action's photo or byte bound; no request is made for them. */
  notAdded: number;
  /** The bound message, or null when the whole selection fits. */
  message: string | null;
  /** The duplicate message, or null when nothing was collapsed. */
  duplicateMessage: string | null;
}

export interface BatchReservation {
  reservationId: string;
  upload: SignedUploadPost;
}

export interface BatchConfirmation {
  itemId: string;
  taggingStatus: string;
}

/** Injected so the runner can be driven without the generated hooks. */
export interface BatchUploadDeps {
  reserve: (file: File) => Promise<BatchReservation>;
  postBytes: (upload: SignedUploadPost, file: File) => Promise<void>;
  confirm: (reservationId: string) => Promise<BatchConfirmation>;
}

export interface BatchRun {
  /** Resolves once every photo that started has settled. */
  settled: Promise<void>;
  /** True once the caller asked the run to stop starting new photos. */
  cancelled: boolean;
  /** Stops photos that have not started; in-flight photos settle. */
  cancel: () => void;
}

/** The identity one file is collapsed on: the same photo selected twice is one row. */
export function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/**
 * Collapse duplicates, then keep the longest prefix inside both action bounds.
 *
 * The bounds are Client feedback, not a control: a caller that ignored them
 * would make exactly the calls it can already make one at a time today.
 */
export function planBatch(files: File[]): BatchSelection {
  const seen = new Set<string>();
  const unique: File[] = [];
  let duplicates = 0;

  for (const file of files) {
    const key = fileKey(file);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(file);
  }

  const kept: File[] = [];
  let bytes = 0;
  for (const file of unique) {
    if (kept.length >= MAX_BATCH_PHOTOS) break;
    if (bytes + file.size > MAX_BATCH_BYTES) break;
    kept.push(file);
    bytes += file.size;
  }

  const notAdded = unique.length - kept.length;
  return {
    files: kept,
    duplicates,
    notAdded,
    message: notAdded > 0
      ? `${kept.length} of ${unique.length} selected — ${notAdded} ${notAdded === 1 ? 'was' : 'were'} not added`
      : null,
    duplicateMessage: duplicates > 0
      ? `${duplicates} duplicate ${duplicates === 1 ? 'photo was' : 'photos were'} skipped`
      : null,
  };
}

let photoSequence = 0;

/** One queued row per photo, with a per-photo rule violation failed before any request. */
export function createBatchPhotos(files: File[]): BatchPhoto[] {
  return files.map((file) => {
    photoSequence += 1;
    const id = `photo-${photoSequence}`;
    try {
      validateImageFile(file);
      return { id, file, status: 'queued' };
    } catch (error) {
      // HEIC/HEIF, a non-image and a file over 10 MiB never reach a request: the
      // existing single-photo rule fails the row with its own message.
      return {
        id,
        file,
        status: 'failed',
        error: getErrorMessage(error, 'Unknown error'),
        failureKind: 'precheck',
      };
    }
  });
}

/**
 * Run up to `MAX_CONCURRENT_UPLOADS` photos at once, each photo's three calls in
 * sequence. A photo that fails is published as failed and never aborts or blocks
 * another; `onChange` receives one snapshot per state transition.
 */
export function runBatch(
  photos: BatchPhoto[],
  deps: BatchUploadDeps,
  onChange: (photo: BatchPhoto) => void,
): BatchRun {
  const queue = photos.filter((photo) => photo.status !== 'created');
  let cursor = 0;
  let active = 0;
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const run: BatchRun = {
    settled,
    cancelled: false,
    cancel() {
      run.cancelled = true;
      pump();
    },
  };

  function pump(): void {
    if (run.cancelled) {
      if (active === 0) settle();
      return;
    }
    while (active < MAX_CONCURRENT_UPLOADS && cursor < queue.length) {
      const photo = queue[cursor];
      cursor += 1;
      active += 1;
      void runPhoto(photo, deps, onChange)
        .catch(() => undefined)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
    if (active === 0 && cursor >= queue.length) settle();
  }

  pump();
  return run;
}

async function runPhoto(
  photo: BatchPhoto,
  deps: BatchUploadDeps,
  publish: (photo: BatchPhoto) => void,
): Promise<void> {
  if (photo.status === 'failed' && photo.failureKind === 'precheck') {
    return recheckPhoto(photo, deps, publish);
  }
  if (photo.status === 'failed' && photo.failureKind === 'confirm' && photo.reservationId) {
    return retryConfirmation(photo, deps, publish);
  }
  return uploadPhoto(photo, deps, publish);
}

/** Retry of a photo the local rules refused: the rules run again and nothing is sent. */
function recheckPhoto(
  photo: BatchPhoto,
  deps: BatchUploadDeps,
  publish: (photo: BatchPhoto) => void,
): Promise<void> | void {
  try {
    validateImageFile(photo.file);
  } catch (error) {
    return publishFailed(photo, 'precheck', error, publish);
  }
  return uploadPhoto(photo, deps, publish);
}

/** Reserve, post and confirm one photo, reserving again once if its window closed. */
async function uploadPhoto(
  photo: BatchPhoto,
  deps: BatchUploadDeps,
  publish: (photo: BatchPhoto) => void,
): Promise<void> {
  let current: BatchPhoto = {
    ...photo,
    status: 'reserving',
    itemId: undefined,
    taggingStatus: undefined,
    error: undefined,
    failureKind: undefined,
    reservationId: undefined,
  };
  publish(current);

  // The second round exists only for a 410: the first confirmation never
  // committed, so re-reserving and confirming once more still creates one item.
  for (let round = 0; round < 2; round += 1) {
    let reservation: BatchReservation;
    try {
      reservation = await withTransientRetry(() => deps.reserve(current.file));
    } catch (error) {
      return publishFailed(current, 'reserve', error, publish);
    }
    if (!reservation?.reservationId || !reservation.upload?.url) {
      return publishFailed(current, 'reserve', new Error('Failed to reserve the upload'), publish);
    }

    current = { ...current, status: 'uploading', reservationId: reservation.reservationId };
    publish(current);

    try {
      await withTransientRetry(() => deps.postBytes(reservation.upload, current.file));
    } catch (error) {
      return publishFailed(current, 'upload', error, publish);
    }

    current = { ...current, status: 'confirming' };
    publish(current);

    try {
      const confirmation = await withTransientRetry(() => deps.confirm(reservation.reservationId));
      return publishCreated(current, confirmation, publish);
    } catch (error) {
      const kind = confirmFailureKind(error);
      if (kind === 'expired' && round === 0) {
        current = { ...current, reservationId: undefined };
        continue;
      }
      return publishFailed(current, kind, error, publish);
    }
  }
}

/** Retry of a confirmation that failed on a 5xx or on the network: same reservation. */
async function retryConfirmation(
  photo: BatchPhoto,
  deps: BatchUploadDeps,
  publish: (photo: BatchPhoto) => void,
): Promise<void> {
  const reservationId = photo.reservationId;
  const current: BatchPhoto = {
    ...photo,
    status: 'confirming',
    error: undefined,
    failureKind: undefined,
  };
  publish(current);
  if (!reservationId) return;

  try {
    const confirmation = await withTransientRetry(() => deps.confirm(reservationId));
    return publishCreated(current, confirmation, publish);
  } catch (error) {
    return publishFailed(current, confirmFailureKind(error), error, publish);
  }
}

function publishCreated(
  photo: BatchPhoto,
  confirmation: BatchConfirmation,
  publish: (photo: BatchPhoto) => void,
): void {
  publish({
    ...photo,
    status: 'created',
    itemId: confirmation.itemId,
    taggingStatus: confirmation.taggingStatus,
  });
}

function publishFailed(
  photo: BatchPhoto,
  failureKind: BatchFailureKind,
  error: unknown,
  publish: (photo: BatchPhoto) => void,
): void {
  // The reservation identity stays on the row: a `confirm` failure is retried
  // against it, and every other kind starts a fresh one on Retry.
  publish({
    ...photo,
    status: 'failed',
    error: getErrorMessage(error, 'Unknown error'),
    failureKind,
  });
}

/** One automatic retry for a 5xx or a lost connection; a refusal is not retried. */
async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTransient(error)) throw error;
    return operation();
  }
}

function isTransient(error: unknown): boolean {
  const status = httpStatusOf(error);
  return status === undefined || status >= 500;
}

/**
 * 410 means the reservation's window closed: the photo can be reserved again.
 * Any other 4xx (`404` unknown reservation, `409` the stored object disagrees)
 * has closed that reservation for good, so Retry starts a fresh one.
 */
function confirmFailureKind(error: unknown): BatchFailureKind {
  const status = httpStatusOf(error);
  if (status === 410) return 'expired';
  if (status !== undefined && status >= 400 && status < 500) return 'terminal';
  return 'confirm';
}

/**
 * The HTTP status a failure carries.
 *
 * The generated hooks throw Axios errors, which name the status on the response.
 * The Client's own signed-POST helper (`imageUpload.ts`) throws a plain `Error`
 * that names it in its message; reading it back here classifies a rejected body
 * without changing that module or its existing message.
 */
function httpStatusOf(error: unknown): number | undefined {
  const status = getHttpStatus(error);
  if (status !== undefined) return status;
  const message = error instanceof Error ? error.message : '';
  const match = /HTTP (\d{3})/.exec(message);
  return match ? Number(match[1]) : undefined;
}
