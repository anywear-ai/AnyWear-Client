import { useState, useCallback, useMemo, useLayoutEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import MirrorErrorBoundary from '../../components/mirror/MirrorErrorBoundary';
import CreditDisplay from '../../components/mirror/CreditDisplay';
import BasePhotoSelector from '../../components/mirror/BasePhotoSelector';
import StylePromptInput from '../../components/mirror/StylePromptInput';
import ResultArea from '../../components/mirror/ResultArea';
import OutfitLookupNotice from '../../components/mirror/OutfitLookupNotice';
import VtoHistorySection from '../../components/mirror/VtoHistorySection';
import RoomSwitcher from '../../components/fitting-room/RoomSwitcher';
import RoomWardrobeList from '../../components/fitting-room/RoomWardrobeList';
import ToTryOnList, { MAX_TICKED_ITEMS } from '../../components/fitting-room/ToTryOnList';
import TryItOnSwitch from '../../components/fitting-room/TryItOnSwitch';
import ComposeActionButton from '../../components/fitting-room/ComposeActionButton';
import RoomNameDialog from '../../components/fitting-room/RoomNameDialog';
import RoomDeleteDialog from '../../components/fitting-room/RoomDeleteDialog';
import useVtoGeneration from '../../hooks/useVtoGeneration';
import useVtoRating from '../../hooks/useVtoRating';
import { useGetUsersMe } from '../../api/endpoints/users/users';
import { useGetVtoBasePhotos } from '../../api/endpoints/vto/vto';
import { useGetOutfitsLookup, usePostOutfits } from '../../api/endpoints/outfits/outfits';
import {
  getGetFittingRoomsFittingRoomIdQueryKey,
  useDeleteFittingRoomsFittingRoomId,
  useDeleteFittingRoomsFittingRoomIdItemsWearableItemId,
  useGetFittingRooms,
  useGetFittingRoomsFittingRoomId,
  usePatchFittingRoomsFittingRoomId,
  usePostFittingRooms,
  usePostFittingRoomsFittingRoomIdItems,
} from '../../api/endpoints/fitting-rooms/fitting-rooms';
import { resolveBasePhotoSelection } from '../../lib/basePhotoSelection';
import { describeSelectionRefusal } from '../../lib/fittingRoomRefusal';
import { describeSavedOutfitNotice } from '../../lib/outfitCover';
import { getErrorMessage } from '../../lib/errors';
import { isClientVersionRefused } from '../../store/clientVersionRefusalStore';
import type { PostVtoGenerationsBody } from '../../api/model/postVtoGenerationsBody';

/** The sentence a sixth tick shows: refused on the Client, before any request. */
const TOO_MANY_SELECTED = `You can try on up to ${MAX_TICKED_ITEMS} at a time. Deselect one to add another.`;

/**
 * Issue 313 — the Fitting Room, the only place an outfit is composed.
 *
 * The page opens the caller's default room (`GET /fitting-rooms` creates it on the
 * first read), lists that room's `Wardrobe` and `To try on` areas, and composes one
 * outfit from the ticked subset: render it (default, 1 credit) or save it without a
 * look (no credit). The staged set is the room's server state; which of those rows
 * is ticked is this page's view state and is never persisted.
 *
 * Both write paths and the lookup share one refusal handler: the Service names the
 * refused ids in `details`, the page unticks exactly those, re-reads the room and
 * asks the user to try again. It never shrinks the request behind the user's back,
 * because a smaller set would compose a different outfit than the one selected.
 */
export default function FittingRoomPage() {
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [tickedIds, setTickedIds] = useState<string[]>([]);
  const [tryItOnNow, setTryItOnNow] = useState(true);
  const [chosenBasePhotoId, setChosenBasePhotoId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [isNameDialogOpen, setIsNameDialogOpen] = useState(false);
  const [nameDialogMode, setNameDialogMode] = useState<'create' | 'rename'>('create');
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const queryClient = useQueryClient();
  const { generate, result, isTerminal, errorMessage, isPolling, isStarting, vtoId } = useVtoGeneration();
  const { save: saveRating, failures: ratingFailures, echoResetTokens: ratingEchoResetTokens } = useVtoRating();
  const { data: user } = useGetUsersMe();
  // The same `['/vto/base-photos']` query the selector runs: one request and two
  // subscribers, so the preselect reads the list it already fetched.
  const { data: basePhotos, isLoading: isLoadingBasePhotos } = useGetVtoBasePhotos();

  // ── The open room ─────────────────────────────────────────────────────────
  // The list read is creating: a caller with no room gets a default one in this
  // same response, so the page never asks the user to create a room first.
  const { data: roomsResponse, isError: isRoomsError } = useGetFittingRooms();
  const rooms = useMemo(() => roomsResponse?.fittingRooms ?? [], [roomsResponse]);
  // The default room is first in the Service's order. A selection that no longer
  // exists (a deleted room) falls back to it without an effect writing state.
  const activeRoomId = selectedRoomId && rooms.some((room) => room.id === selectedRoomId)
    ? selectedRoomId
    : rooms[0]?.id ?? null;

  const roomQuery = useGetFittingRoomsFittingRoomId(activeRoomId ?? '', {
    query: { enabled: activeRoomId !== null, retry: false },
  });
  const room = activeRoomId ? roomQuery.data ?? null : null;
  const stagedItems = useMemo(() => room?.items ?? [], [room]);
  const refetchRoom = roomQuery.refetch;

  const { mutateAsync: stageItems, isPending: isStaging } = usePostFittingRoomsFittingRoomIdItems();
  const { mutateAsync: removeStagedItem, isPending: isRemoving } = useDeleteFittingRoomsFittingRoomIdItemsWearableItemId();
  const { mutateAsync: createRoom, isPending: isCreatingRoom } = usePostFittingRooms();
  const { mutateAsync: renameRoom, isPending: isRenamingRoom } = usePatchFittingRoomsFittingRoomId();
  const { mutateAsync: deleteRoom, isPending: isDeletingRoom } = useDeleteFittingRoomsFittingRoomId();
  const { mutateAsync: saveOutfit } = usePostOutfits();

  // Ticks are the user's intent; the effective selection is derived from it and
  // the room on every render, so a removed row cannot leave a phantom tick behind.
  const tickedInRoom = useMemo(
    () => tickedIds.filter((id) => stagedItems.some((item) => item.id === id)),
    [tickedIds, stagedItems],
  );
  const tickableSelectedCount = useMemo(
    () => stagedItems.filter((item) => item.archivedAt === null && tickedInRoom.includes(item.id)).length,
    [stagedItems, tickedInRoom],
  );

  // ── Base photo ────────────────────────────────────────────────────────────
  const basePhotoSelection = resolveBasePhotoSelection(basePhotos, chosenBasePhotoId);
  const selectedBasePhotoId = basePhotoSelection.photoId;

  const handleSelectBasePhoto = useCallback((id: string | null) => {
    setChosenBasePhotoId(id);
  }, []);

  // The upload confirmation resolves after several awaits, so its adoption
  // decision must read the selection source that is current when it resolves,
  // not the one captured by the render that created the file-change handler.
  const selectionSourceRef = useRef(basePhotoSelection.source);
  useLayoutEffect(() => {
    selectionSourceRef.current = basePhotoSelection.source;
  });

  const handleUploadedBasePhoto = useCallback((id: string) => {
    if (selectionSourceRef.current !== 'chosen') {
      setChosenBasePhotoId(id);
    }
  }, []);

  // `undefined` means no profile has arrived: the balance is unknown, never 0.
  const credits = user?.dailyCredits ?? undefined;

  /**
   * Issue 335 — the ticked set may already be a saved outfit.
   *
   * The lookup is read-only and charges nothing, so the page shows the existing
   * outfit before the primary button spends a credit, and a hit decides the
   * generation body: pressing the button appends a record to that outfit instead
   * of creating a second one for the same combination. It runs only on the render
   * path, because a saved outfit is not a decision `Save outfit` needs to make.
   */
  const lookupIds = useMemo(
    () => (tryItOnNow ? [...tickedInRoom].sort() : []),
    [tryItOnNow, tickedInRoom],
  );
  const lookupQuery = useGetOutfitsLookup(
    { wearable_item_ids: lookupIds.join(',') },
    { query: { enabled: lookupIds.length > 0, retry: false } },
  );
  const matchedOutfit = lookupIds.length > 0 ? lookupQuery.data?.outfit ?? null : null;
  const isLookingUpOutfit = lookupIds.length > 0 && lookupQuery.isLoading;
  /**
   * A lookup that is actually running for the current ticked set.
   *
   * Pressing the button in this window would send Mode B and charge a credit
   * without the matched-outfit confirmation ever rendering, which is the one thing
   * the pre-charge lookup exists to prevent. Both flags are read: `isLoading`
   * covers the first read, `isFetching` the moment a re-read of the same key is in
   * flight. With the switch off the lookup is disabled, so `Save outfit` is never
   * held by this.
   */
  const isLookupInFlight = tryItOnNow
    && lookupIds.length > 0
    && (lookupQuery.isLoading || lookupQuery.isFetching === true);
  const lookupError = lookupQuery.error;

  /**
   * The one refusal handler: untick exactly the named ids, re-read the room, and
   * state what happened. A refusal that names nothing keeps the Service's message.
   *
   * `GET /outfits/lookup` runs the same ownership and Storage-Box validation as the
   * write paths, so it can refuse first; the generate path below sends its error
   * through this handler too, which is what keeps one behaviour instead of two.
   */
  const handleRefusal = useCallback((error: unknown) => {
    if (isClientVersionRefused()) return;
    const { untickIds, message } = describeSelectionRefusal(error);
    if (untickIds.length > 0) {
      setTickedIds((current) => current.filter((id) => !untickIds.includes(id)));
      void refetchRoom();
    }
    setNotice(message);
  }, [refetchRoom]);

  // ── Ticks ─────────────────────────────────────────────────────────────────
  const toggleTicked = useCallback((itemId: string) => {
    const item = stagedItems.find((entry) => entry.id === itemId);
    if (!item || item.archivedAt !== null) return;
    setNotice(null);
    if (tickedInRoom.includes(itemId)) {
      setTickedIds(tickedInRoom.filter((id) => id !== itemId));
      return;
    }
    if (tickableSelectedCount >= MAX_TICKED_ITEMS) {
      // The sixth tick is refused here rather than by a request that would 400.
      setNotice(TOO_MANY_SELECTED);
      return;
    }
    setTickedIds([...tickedInRoom, itemId]);
  }, [stagedItems, tickedInRoom, tickableSelectedCount]);

  // ── Room actions ──────────────────────────────────────────────────────────
  const openCreateRoom = () => {
    setRoomActionError(null);
    setNameDialogMode('create');
    setIsNameDialogOpen(true);
  };

  const openRenameRoom = () => {
    setRoomActionError(null);
    setNameDialogMode('rename');
    setIsNameDialogOpen(true);
  };

  const submitRoomName = async (name: string) => {
    const trimmed = name.trim();
    setRoomActionError(null);
    try {
      if (nameDialogMode === 'create') {
        // A blank name is a valid create: the Service stores `Fitting Room`, so
        // the body simply omits it.
        const created = await createRoom({ data: trimmed ? { name: trimmed } : {} });
        setSelectedRoomId(created.id);
        setTickedIds([]);
      } else if (activeRoomId) {
        await renameRoom({ fittingRoomId: activeRoomId, data: { name: trimmed } });
      }
      setIsNameDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['/fitting-rooms'] as const });
      if (activeRoomId) await refetchRoom();
    } catch (error) {
      if (isClientVersionRefused()) return;
      setRoomActionError(getErrorMessage(error, 'The room could not be saved. Try again.'));
    }
  };

  const confirmDeleteRoom = async () => {
    if (!activeRoomId) return;
    setRoomActionError(null);
    try {
      await deleteRoom({ fittingRoomId: activeRoomId });
      // The deleted room is no longer a selection; the derived active room falls
      // back to the first surviving one. When the last room was deleted, this
      // list read is the one that creates a fresh default room.
      setSelectedRoomId(null);
      setTickedIds([]);
      setIsDeleteDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['/fitting-rooms'] as const });
    } catch (error) {
      if (isClientVersionRefused()) return;
      setRoomActionError(getErrorMessage(error, 'The room could not be deleted. Try again.'));
    }
  };

  // ── Staging ───────────────────────────────────────────────────────────────
  const handleAddToTryOn = async (itemId: string) => {
    if (!activeRoomId) return;
    setNotice(null);
    try {
      const updated = await stageItems({ fittingRoomId: activeRoomId, data: { wearable_item_ids: [itemId] } });
      queryClient.setQueryData(getGetFittingRoomsFittingRoomIdQueryKey(activeRoomId), updated);
      await queryClient.invalidateQueries({ queryKey: ['/fitting-rooms'] as const });
    } catch (error) {
      handleRefusal(error);
    }
  };

  const handleRemoveFromTryOn = async (itemId: string) => {
    if (!activeRoomId) return;
    setNotice(null);
    try {
      await removeStagedItem({ fittingRoomId: activeRoomId, wearableItemId: itemId });
      setTickedIds((current) => current.filter((id) => id !== itemId));
      await refetchRoom();
      await queryClient.invalidateQueries({ queryKey: ['/fitting-rooms'] as const });
    } catch (error) {
      handleRefusal(error);
    }
  };

  /** A history record's items join this room's staging area and are ticked. */
  const handleReuseOutfit = async (wearableItemIds: string[]) => {
    if (!activeRoomId || wearableItemIds.length === 0) return;
    setNotice(null);
    try {
      await stageItems({ fittingRoomId: activeRoomId, data: { wearable_item_ids: wearableItemIds } });
      setTickedIds(wearableItemIds);
      await refetchRoom();
      await queryClient.invalidateQueries({ queryKey: ['/fitting-rooms'] as const });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      handleRefusal(error);
    }
  };

  // ── Compose ───────────────────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!selectedBasePhotoId || tickedInRoom.length === 0) return;
    // Hold the click until the lookup settles: a hit has to reach the confirmation
    // and go out as Mode A, never as a Mode B that spends the credit first.
    if (lookupQuery.isFetching) return;
    // The lookup is the first request of this path, so its refusal is handled
    // here before anything is charged: the same untick, re-read and retry sentence
    // the write paths produce.
    if (lookupError) {
      handleRefusal(lookupError);
      return;
    }
    setNotice(null);
    try {
      // A hit appends a record to the existing outfit (Mode A); a miss lets the
      // Service find-or-create the set from the ids (Mode B). Neither sends an
      // outfit name: the Service derives one, which is the recorded contract.
      if (matchedOutfit) {
        await generate({
          base_photo_id: selectedBasePhotoId,
          outfit_id: matchedOutfit.id,
          prompt: prompt.trim() || undefined,
        });
      } else {
        await generate({
          base_photo_id: selectedBasePhotoId,
          wearable_item_ids: tickedInRoom,
          prompt: prompt.trim() || undefined,
        });
      }
    } catch (error) {
      handleRefusal(error);
    }
  }, [selectedBasePhotoId, tickedInRoom, lookupQuery.isFetching, lookupError, handleRefusal, matchedOutfit, generate, prompt]);

  const handleSaveOutfit = useCallback(async () => {
    if (tickedInRoom.length === 0) return;
    setNotice(null);
    setIsSaving(true);
    try {
      // The save path sends the member list and nothing else: no base photo, no
      // prompt, no name, no Idempotency-Key. `201` and `200` are both success —
      // `customInstance` resolves any 2xx to the body, so there is nothing to branch on.
      const saved = await saveOutfit({ data: { wearable_item_ids: tickedInRoom } });
      await queryClient.invalidateQueries({ queryKey: ['/outfits'] as const });
      // A `200` returns the outfit that already holds this set, and it may already
      // have a rendered look; the notice follows the look the response carries
      // rather than assuming the set is new.
      setNotice(describeSavedOutfitNotice(saved));
    } catch (error) {
      handleRefusal(error);
    } finally {
      setIsSaving(false);
    }
  }, [tickedInRoom, saveOutfit, queryClient, handleRefusal]);

  // The history section builds the retry body from the failed row and the page's
  // current effective base photo; the page only runs it through the one
  // generation pipeline, so `vtoId`, `isStarting` and `isPolling` keep a single
  // owner and the history invalidation stays in one place.
  const handleRetryGeneration = useCallback(
    (body: PostVtoGenerationsBody) => generate(body),
    [generate],
  );

  const hasTicks = tickedInRoom.length > 0;
  const isBusy = isStarting || isPolling || isSaving;
  // The lookup is part of the generate path, so the control is held while it is
  // in flight. `Save outfit` looks nothing up, so switching off releases it.
  const canCompose = hasTicks && !isBusy && !isLookupInFlight && (tryItOnNow ? !!selectedBasePhotoId : true);

  return (
    <MirrorErrorBoundary>
      <div className="space-y-6 sm:space-y-8">
        <div>
          <p className="text-sm font-medium text-indigo-700">Your fitting room</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">Fitting Room</h1>
          <p className="mt-1 text-sm text-gray-600">
            Pick pieces into To try on, then try them on with a base photo or save them as an outfit.
          </p>
        </div>

        <RoomSwitcher
          rooms={rooms}
          selectedRoomId={activeRoomId}
          onSelect={setSelectedRoomId}
          onCreate={openCreateRoom}
          onRename={openRenameRoom}
          onDelete={() => { setRoomActionError(null); setIsDeleteDialogOpen(true); }}
          isBusy={isCreatingRoom || isRenamingRoom || isDeletingRoom}
        />

        {isRoomsError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            Your fitting rooms could not be loaded. Reload the app to try again.
          </p>
        )}

        <section aria-labelledby="fitting-room-wardrobe-heading" className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 id="fitting-room-wardrobe-heading" className="text-lg font-semibold text-gray-900">Wardrobe</h2>
          <p className="mb-4 mt-1 text-sm text-gray-600">
            Every piece you own. Add the ones you want to compare to To try on — adding stages a piece, it does not try it on.
          </p>
          <RoomWardrobeList onAdd={handleAddToTryOn} isAdding={isStaging} />
        </section>

        <section aria-labelledby="fitting-room-to-try-on-heading" className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 id="fitting-room-to-try-on-heading" className="text-lg font-semibold text-gray-900">To try on</h2>
          <p className="mb-4 mt-1 text-sm text-gray-600">
            The pieces staged in this room. Select up to {MAX_TICKED_ITEMS} of them — the list itself can hold as many as you like.
          </p>
          <ToTryOnList
            items={stagedItems}
            selectedIds={tickedInRoom}
            onToggle={toggleTicked}
            onRemove={(itemId) => { void handleRemoveFromTryOn(itemId); }}
            isRemoving={isRemoving}
          />
        </section>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <div className="mb-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Step 1</p>
              <h2 className="mt-1 text-lg font-semibold text-gray-900">Choose a base photo</h2>
            </div>
            <BasePhotoSelector
              selectedPhotoId={selectedBasePhotoId}
              onSelect={handleSelectBasePhoto}
              onUploaded={handleUploadedBasePhoto}
            />
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">
              Style Prompt <span className="text-sm font-normal text-gray-500">(optional)</span>
            </h2>
            <StylePromptInput value={prompt} onChange={setPrompt} />
          </div>
        </div>

        <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Step 2</p>
              <h2 className="mt-1 text-lg font-semibold text-gray-900">Compose your outfit</h2>
            </div>
            <CreditDisplay />
          </div>
          <div className="space-y-3">
            <TryItOnSwitch checked={tryItOnNow} onChange={setTryItOnNow} disabled={isBusy} />
            {tryItOnNow && (
              <OutfitLookupNotice outfit={matchedOutfit} isLoading={isLookingUpOutfit} />
            )}
            <ComposeActionButton
              tryItOnNow={tryItOnNow}
              onClick={() => { void (tryItOnNow ? handleGenerate() : handleSaveOutfit()); }}
              disabled={!canCompose}
              isLoading={isBusy}
              credits={credits ?? null}
            />
            {!hasTicks && (
              <p className="text-center text-xs text-gray-600">Add pieces to To try on, then select at least one.</p>
            )}
            {hasTicks && tryItOnNow && !selectedBasePhotoId && !isLoadingBasePhotos && (
              <p className="text-center text-xs text-gray-600">Select a base photo to start</p>
            )}
            {credits === undefined && tryItOnNow && (
              <p className="text-center text-xs text-gray-600">
                Your credit balance is unavailable. Try-on is disabled until your profile loads.
              </p>
            )}
            {hasTicks && tryItOnNow && credits === 0 && (
              <p className="text-center text-xs text-red-500">Out of daily credits. Credits reset at midnight.</p>
            )}
            {notice && (
              <p role="status" className="rounded-lg bg-white/70 px-3 py-2 text-center text-sm text-gray-800">{notice}</p>
            )}
            {errorMessage && (
              <p role="alert" className="text-center text-sm text-red-700">{errorMessage}</p>
            )}
          </div>
        </div>

        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6" aria-labelledby="fitting-room-result-heading">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Step 3</p>
          <h2 id="fitting-room-result-heading" className="mb-4 mt-1 text-lg font-semibold text-gray-900">Your try-on result</h2>
          <ResultArea
            vtoId={vtoId}
            result={result}
            onRetry={handleGenerate}
            onRate={(rating) => saveRating(vtoId, rating)}
            ratingError={vtoId ? ratingFailures[vtoId] ?? null : null}
            ratingEchoResetToken={vtoId ? ratingEchoResetTokens[vtoId] ?? 0 : 0}
          />
        </section>

        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">History</h2>
          <VtoHistorySection
            onReuseOutfit={(ids) => { void handleReuseOutfit(ids); }}
            onRetryGeneration={handleRetryGeneration}
            basePhotoId={selectedBasePhotoId}
            credits={credits ?? null}
            isGenerating={isStarting || isPolling}
            settledStatus={isTerminal ? result : null}
          />
        </div>

        <RoomNameDialog
          key={`${nameDialogMode}-${activeRoomId ?? 'none'}-${isNameDialogOpen ? 'open' : 'closed'}`}
          isOpen={isNameDialogOpen}
          mode={nameDialogMode}
          initialName={nameDialogMode === 'rename' ? room?.name ?? '' : ''}
          isSubmitting={isCreatingRoom || isRenamingRoom}
          errorMessage={roomActionError}
          onSubmit={(name) => { void submitRoomName(name); }}
          onCancel={() => { setIsNameDialogOpen(false); setRoomActionError(null); }}
        />

        <RoomDeleteDialog
          isOpen={isDeleteDialogOpen}
          roomName={room?.name ?? null}
          isSubmitting={isDeletingRoom}
          errorMessage={roomActionError}
          onCancel={() => { setIsDeleteDialogOpen(false); setRoomActionError(null); }}
          onConfirm={() => { void confirmDeleteRoom(); }}
        />
      </div>
    </MirrorErrorBoundary>
  );
}
