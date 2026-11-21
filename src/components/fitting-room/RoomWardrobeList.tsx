import { useMemo, useState } from 'react';
import { useGetWardrobe, useGetWardrobeCategories } from '../../api/endpoints/wardrobe/wardrobe';
import CachedImage from '../CachedImage';
import { getPrimaryImageUrl } from '../../lib/image-utils';
import type { GetWardrobe200Item } from '../../api/model/getWardrobe200Item';
import type { GetWardrobeParams } from '../../api/model/getWardrobeParams';

/**
 * The only filter dimensions this list may send. The registry fixes the room's
 * `Wardrobe` area to `GET /wardrobe`'s existing `category`, `color` and `material`
 * parameters: no new dimension, no contract change, and never `archive_status`,
 * because a room lists the active wardrobe and the Storage Box lives elsewhere.
 */
type RoomWardrobeFilters = Pick<GetWardrobeParams, 'category' | 'color' | 'material'>;

interface RoomWardrobeListProps {
  /** Stages one wardrobe item in the current room — never a tick. */
  onAdd: (itemId: string) => void;
  /** The action is held while a staging request is out, so one click is one batch. */
  isAdding?: boolean;
}

function styleAttribute(item: GetWardrobe200Item, key: 'color' | 'material'): string | null {
  const attributes = item.styleAttributes;
  if (!attributes || typeof attributes !== 'object') return null;
  const value = (attributes as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function itemLabel(item: GetWardrobe200Item): string {
  return item.name || item.category || 'wardrobe item';
}

function distinct(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort((a, b) => a.localeCompare(b));
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700">
      {label}
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * Issue 313 — the room's `Wardrobe` area.
 *
 * It lists the caller's active wardrobe with `GET /wardrobe`, filtered only by
 * the three tag parameters the interface already has. The search box narrows the
 * list the page already fetched: it sends no request and adds no parameter. Each
 * card's one action stages the piece in `To try on`; ticking happens there, which
 * is what keeps "which pieces exist in the room" and "which pieces are being
 * tried" two separate facts.
 *
 * An archived piece is absent rather than marked: this is a picking surface, so
 * the Storage Box's own wording and restore path stay in the Wardrobe tab.
 */
export default function RoomWardrobeList({ onAdd, isAdding = false }: RoomWardrobeListProps) {
  const [category, setCategory] = useState('');
  const [color, setColor] = useState('');
  const [material, setMaterial] = useState('');
  const [search, setSearch] = useState('');

  // The object identity is memoised because the generated query key is derived
  // from it; only the three permitted parameters are ever present.
  const filters: RoomWardrobeFilters = useMemo(
    () => ({
      ...(category ? { category } : {}),
      ...(color ? { color } : {}),
      ...(material ? { material } : {}),
    }),
    [category, color, material],
  );

  const { data: wardrobeData, isLoading } = useGetWardrobe(filters);
  const { data: categoriesResponse } = useGetWardrobeCategories();

  const items = useMemo(
    () => (Array.isArray(wardrobeData) ? wardrobeData : []),
    [wardrobeData],
  );
  const categories = categoriesResponse?.categories ?? [];

  // The active list is already archived-free; this guard keeps a stale cached
  // response from painting a Storage Box piece on a picking surface. An archived
  // piece is absent here, not marked — the badge belongs to `To try on`.
  const activeItems = useMemo(
    () => items.filter((item) => (item.archivedAt ?? null) === null),
    [items],
  );

  // Options come from what has been read, so the selects never offer a value the
  // wardrobe cannot answer. The "All" entry always stays, so a narrowing is undoable.
  const colorOptions = useMemo(() => distinct(activeItems.map((item) => styleAttribute(item, 'color'))), [activeItems]);
  const materialOptions = useMemo(() => distinct(activeItems.map((item) => styleAttribute(item, 'material'))), [activeItems]);

  const visibleItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return activeItems.filter((item) => {
      if (!query) return true;
      return [item.name, item.category, styleAttribute(item, 'color'), styleAttribute(item, 'material')]
        .some((value) => typeof value === 'string' && value.toLowerCase().includes(query));
    });
  }, [activeItems, search]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label htmlFor="room-wardrobe-search" className="sr-only">Search wardrobe pieces</label>
        <input
          id="room-wardrobe-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search your wardrobe..."
          className="min-w-48 flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <FilterSelect
          id="room-wardrobe-color"
          label="Color"
          value={color}
          options={colorOptions}
          onChange={setColor}
        />
        <FilterSelect
          id="room-wardrobe-material"
          label="Material"
          value={material}
          options={materialOptions}
          onChange={setMaterial}
        />
      </div>

      {categories.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter wardrobe by category">
          <button
            type="button"
            onClick={() => setCategory('')}
            aria-pressed={category === ''}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              category === '' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2`}
          >
            All
          </button>
          {categories.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setCategory(entry)}
              aria-pressed={category === entry}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                category === entry ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2`}
            >
              {entry}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {[1, 2, 3, 4].map((index) => (
            <div key={index} className="aspect-[4/5] animate-pulse rounded-lg bg-gray-200" />
          ))}
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 p-6 text-center">
          <p className="text-sm text-gray-500">
            {activeItems.length === 0
              ? 'Your wardrobe is empty. Add pieces in the Wardrobe tab first.'
              : 'No pieces match this search or filter.'}
          </p>
        </div>
      ) : (
        <div data-testid="room-wardrobe-grid" className="grid max-h-96 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">
          {visibleItems.map((item) => {
            const imageUrl = getPrimaryImageUrl(item.images);
            const primaryImageId = item.images.find((image) => image.isPrimary)?.imageId
              ?? item.images[0]?.imageId;
            const itemColor = styleAttribute(item, 'color');
            const itemMaterial = styleAttribute(item, 'material');
            return (
              <article
                key={item.id}
                className="relative overflow-hidden rounded-xl border border-gray-200 bg-white"
              >
                <div className="aspect-[4/5] bg-gray-100">
                  {imageUrl && primaryImageId ? (
                    <CachedImage
                      src={imageUrl}
                      cacheKey={primaryImageId}
                      alt={itemLabel(item)}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-gray-400">No Image</div>
                  )}
                </div>
                <div className="p-2">
                  <p className="truncate text-xs font-medium text-gray-900">{itemLabel(item)}</p>
                  <p className="truncate text-xs text-gray-600">{[item.category, itemColor, itemMaterial].filter(Boolean).join(' • ')}</p>
                </div>
                <div className="border-t border-gray-100 p-2">
                  <button
                    type="button"
                    onClick={() => onAdd(item.id)}
                    disabled={isAdding}
                    aria-label={`Add ${itemLabel(item)} to try on`}
                    className="w-full rounded-md bg-indigo-50 px-2 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Add to try on
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
