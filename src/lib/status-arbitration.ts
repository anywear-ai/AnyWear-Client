/**
 * The one status rule, applied at every cache-write boundary.
 *
 * A status is applied only when its version — `state_version` in a wardrobe
 * frame compared against the cached item's `taggingStateVersion`, and
 * `state_version` for a VTO generation — is strictly newer than the version
 * already held for that resource. An equal version may replace `images` only
 * (the Service re-signs a URL without changing state), never status fields. An
 * older version is ignored. A terminal status at a higher version is kept,
 * because a higher-version non-terminal status is a new lifecycle (a re-tag),
 * not a stale overwrite.
 *
 * The module is intentionally pure and dependency-free so the rule can be
 * unit-tested without React, TanStack Query or the generated API types, and so
 * every channel that writes status into a cache calls the same comparison.
 */

/** How an incoming status version compares with the version already held. */
export type StatusDecision = 'newer' | 'equal' | 'older';

/** A status version as the Service reports it (`state_version` / `taggingStateVersion`). */
export type StatusVersion = number;

/**
 * Compares an incoming version against the version already held for a resource.
 *
 * No held version means nothing has been written yet, so the first status always
 * applies. Equality is not "newer": it may replace images only.
 */
export function decideStatusVersion(
  incoming: StatusVersion,
  held: StatusVersion | null | undefined,
): StatusDecision {
  if (held === null || held === undefined) return 'newer';
  if (incoming > held) return 'newer';
  if (incoming === held) return 'equal';
  return 'older';
}

/** The status-bearing members of one wardrobe frame (`TaggingStatusResponse`). */
export interface WardrobeStatusFrame<TImage> {
  item_id: string;
  tagging_status: string;
  state_version: StatusVersion;
  style_attributes?: unknown | null;
  weather_tags?: unknown | null;
  error_message: string | null;
  images: TImage[];
}

/** The members of a cached wardrobe list item that a frame owns. */
export interface WardrobeStatusItem<TImage> {
  taggingStatus: string;
  taggingStateVersion: StatusVersion;
  styleAttributes?: unknown | null;
  weatherTags?: unknown | null;
  taggingErrorMessage: string | null;
  images: TImage[];
}

/**
 * Applies one wardrobe frame to one cached list item through the version rule.
 *
 * Returns the item unchanged when the frame is older, a copy with only `images`
 * replaced when the versions are equal, and a copy whose frame-owned fields are
 * replaced when the frame is newer. Every other member — `category`, `name`,
 * `taggingErrorCode` and the timestamps — stays from the last list read.
 */
export function mergeWardrobeStatus<TImage, TItem extends WardrobeStatusItem<TImage>>(
  held: TItem,
  frame: WardrobeStatusFrame<TImage>,
): TItem {
  switch (decideStatusVersion(frame.state_version, held.taggingStateVersion)) {
    case 'older':
      return held;
    case 'equal':
      return { ...held, images: frame.images };
    case 'newer':
      return {
        ...held,
        taggingStatus: frame.tagging_status,
        taggingStateVersion: frame.state_version,
        styleAttributes: frame.style_attributes ?? null,
        weatherTags: frame.weather_tags ?? null,
        taggingErrorMessage: frame.error_message,
        images: frame.images,
      };
  }
}

/** The identity and version a cached wardrobe list item is merged on. */
export interface WardrobeListedItem {
  id: string;
  taggingStateVersion: StatusVersion;
}

/**
 * Merges one full `GET /wardrobe` response into the list already held.
 *
 * A list read that resolves after a newer frame is stale for every item whose
 * cached version is newer, so that item is kept and only the rest of the
 * response is taken. An item missing from the response is dropped: the list is
 * the authority on membership, and a filtered list only ever holds its own
 * filter's items. A listed item at the cached version or newer is the full
 * record — it refreshes the fields a frame never carries.
 */
export function mergeWardrobeListResponse<TItem extends WardrobeListedItem>(
  held: readonly TItem[] | undefined,
  fetched: readonly TItem[],
): TItem[] {
  const heldById = new Map((held ?? []).map((item) => [item.id, item]));
  return fetched.map((item) => {
    const cached = heldById.get(item.id);
    if (!cached) return item;
    return decideStatusVersion(item.taggingStateVersion, cached.taggingStateVersion) === 'older'
      ? cached
      : item;
  });
}

/** The version and image members of a VTO status response the rule owns. */
export interface VtoStatusSnapshot {
  state_version: StatusVersion;
  imageId: string | null;
  url: string | null;
}

/**
 * Applies one VTO status — a poll result or a stream frame — to the cached one.
 *
 * The poll and the stream are two channels for the same resource, so both pass
 * through here: a poll that started before a newer terminal frame and resolves
 * after it returns the cached terminal status instead of replacing it. An equal
 * version may replace the image identity and its signed URL only.
 */
export function mergeVtoStatus<TStatus extends VtoStatusSnapshot>(
  held: TStatus | undefined,
  incoming: TStatus,
): TStatus {
  const decision = decideStatusVersion(incoming.state_version, held?.state_version);
  if (held === undefined || decision === 'newer') return incoming;
  if (decision === 'older') return held;
  return { ...held, imageId: incoming.imageId, url: incoming.url };
}
