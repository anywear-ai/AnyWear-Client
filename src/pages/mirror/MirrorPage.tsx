import { useState, useCallback, useLayoutEffect, useRef } from 'react';
import MirrorErrorBoundary from '../../components/mirror/MirrorErrorBoundary';
import CreditDisplay from '../../components/mirror/CreditDisplay';
import BasePhotoSelector from '../../components/mirror/BasePhotoSelector';
import WearableItemMultiSelector from '../../components/mirror/WearableItemMultiSelector';
import OutfitPicker from '../../components/mirror/OutfitPicker';
import StylePromptInput from '../../components/mirror/StylePromptInput';
import TryOnButton from '../../components/mirror/TryOnButton';
import ResultArea from '../../components/mirror/ResultArea';
import VtoHistorySection from '../../components/mirror/VtoHistorySection';
import useVtoGeneration from '../../hooks/useVtoGeneration';
import useVtoRating from '../../hooks/useVtoRating';
import { useGetUsersMe } from '../../api/endpoints/users/users';
import { useGetVtoBasePhotos } from '../../api/endpoints/vto/vto';
import { resolveBasePhotoSelection } from '../../lib/basePhotoSelection';
import type { PostVtoGenerationsBody } from '../../api/model/postVtoGenerationsBody';

type SelectionMode = 'outfit' | 'items';

export default function MirrorPage() {
  const [mode, setMode] = useState<SelectionMode>('items');
  const [chosenBasePhotoId, setChosenBasePhotoId] = useState<string | null>(null);
  const [selectedOutfitId, setSelectedOutfitId] = useState<string | null>(null);
  const [selectedWearableItemIds, setSelectedWearableItemIds] = useState<string[]>([]);
  const [outfitName, setOutfitName] = useState('');
  const [prompt, setPrompt] = useState('');

  const { generate, result, isTerminal, errorMessage, isPolling, isStarting, vtoId } = useVtoGeneration();
  const { save: saveRating, failures: ratingFailures, echoResetTokens: ratingEchoResetTokens } = useVtoRating();
  const { data: user } = useGetUsersMe();
  // The same `['/vto/base-photos']` query the selector runs: one request and
  // two subscribers, so the preselect reads the list it already fetched.
  const { data: basePhotos, isLoading: isLoadingBasePhotos } = useGetVtoBasePhotos();

  // The user's intent is the only selection state. The effective selection is
  // derived from it and the list on every render, so a refetch cannot move it
  // and a deleted row cannot leave a phantom selection behind.
  const basePhotoSelection = resolveBasePhotoSelection(basePhotos, chosenBasePhotoId);
  const selectedBasePhotoId = basePhotoSelection.photoId;

  const handleSelectBasePhoto = useCallback((id: string | null) => {
    setChosenBasePhotoId(id);
  }, []);

  // The upload confirmation resolves after several awaits, so its adoption
  // decision must read the selection source that is current when it resolves,
  // not the one captured by the render that created the file-change handler.
  // This ref holds the last committed source: it is refreshed after every
  // commit, before the confirm response can be delivered, so a card clicked
  // while the upload runs stays in force instead of being overwritten.
  const selectionSourceRef = useRef(basePhotoSelection.source);
  useLayoutEffect(() => {
    selectionSourceRef.current = basePhotoSelection.source;
  });

  // A confirmed upload is adopted only when no photo the user chose during this
  // visit is in force at resolution time; it never replaces an explicit choice.
  const handleUploadedBasePhoto = useCallback((id: string) => {
    if (selectionSourceRef.current !== 'chosen') {
      setChosenBasePhotoId(id);
    }
  }, []);

  // `undefined` means no profile has arrived: the balance is unknown, never 0.
  const credits = user?.dailyCredits ?? undefined;

  const hasItems = mode === 'outfit' ? !!selectedOutfitId : selectedWearableItemIds.length > 0;
  const canGenerate = !!selectedBasePhotoId && hasItems && credits !== undefined && credits > 0 && !isStarting && !isPolling;

  const handleGenerate = useCallback(() => {
    if (!selectedBasePhotoId) return;

    if (mode === 'outfit' && selectedOutfitId) {
      generate({
        base_photo_id: selectedBasePhotoId,
        outfit_id: selectedOutfitId,
        prompt: prompt.trim() || undefined,
      });
    } else if (mode === 'items' && selectedWearableItemIds.length > 0) {
      generate({
        base_photo_id: selectedBasePhotoId,
        wearable_item_ids: selectedWearableItemIds,
        outfit_name: outfitName.trim() || undefined,
        prompt: prompt.trim() || undefined,
      });
    }
  }, [generate, selectedBasePhotoId, mode, selectedOutfitId, selectedWearableItemIds, outfitName, prompt]);

  // The history section builds the retry body from the failed row and the
  // page's current effective base photo; the page only runs it through the one
  // generation pipeline, so `vtoId`, `isStarting` and `isPolling` keep a single
  // owner and the history invalidation stays in one place.
  const handleRetryGeneration = useCallback(
    (body: PostVtoGenerationsBody) => generate(body),
    [generate],
  );

  const handleReuseOutfit = useCallback((ids: string[]) => {
    setMode('items');
    setSelectedWearableItemIds(ids);
    setSelectedOutfitId(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <MirrorErrorBoundary>
      <div className="space-y-6 sm:space-y-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-indigo-700">Your fitting room</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">The Mirror</h1>
            <p className="mt-1 text-sm text-gray-600">Choose a photo and pieces from your wardrobe.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Step 2</p>
                <h2 className="mt-1 text-lg font-semibold text-gray-900">Choose an outfit</h2>
              </div>
              <div className="flex rounded-lg bg-gray-100 p-0.5" role="group" aria-label="Outfit selection mode">
                <button
                  onClick={() => { setMode('outfit'); setSelectedWearableItemIds([]); }}
                  aria-pressed={mode === 'outfit'}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${mode === 'outfit' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Saved
                </button>
                <button
                  onClick={() => { setMode('items'); setSelectedOutfitId(null); }}
                  aria-pressed={mode === 'items'}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${mode === 'items' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Select Items
                </button>
              </div>
            </div>

            {mode === 'outfit' ? (
              <OutfitPicker
                selectedOutfitId={selectedOutfitId}
                onSelect={setSelectedOutfitId}
              />
            ) : (
              <WearableItemMultiSelector
                selectedIds={selectedWearableItemIds}
                onSelectionChange={setSelectedWearableItemIds}
                outfitName={outfitName}
                onOutfitNameChange={setOutfitName}
              />
            )}
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">Style Prompt <span className="text-sm font-normal text-gray-500">(optional)</span></h2>
            <StylePromptInput value={prompt} onChange={setPrompt} />
          </div>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Step 3</p>
                <h2 className="mt-1 text-lg font-semibold text-gray-900">Create your preview</h2>
              </div>
              <CreditDisplay />
            </div>
            <div className="space-y-3">
              <TryOnButton
                onGenerate={handleGenerate}
                disabled={!canGenerate}
                isLoading={isStarting || isPolling}
                credits={credits ?? null}
              />
              {!selectedBasePhotoId && !isLoadingBasePhotos && (
                <p className="text-xs text-gray-600 text-center">Select a base photo to start</p>
              )}
              {selectedBasePhotoId && !hasItems && (
                <p className="text-xs text-gray-600 text-center">
                  {mode === 'outfit' ? 'Select an outfit' : 'Select at least one wearable item'}
                </p>
              )}
              {credits === undefined && (
                <p className="text-xs text-gray-600 text-center">
                  Your credit balance is unavailable. Try-on is disabled until your profile loads.
                </p>
              )}
              {selectedBasePhotoId && hasItems && credits === 0 && (
                <p className="text-xs text-red-500 text-center">Out of daily credits. Credits reset at midnight.</p>
              )}
              {errorMessage && (
                <p role="alert" className="text-sm text-red-700 text-center">{errorMessage}</p>
              )}
            </div>
          </div>
        </div>

        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6" aria-labelledby="mirror-result-heading">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Step 4</p>
          <h2 id="mirror-result-heading" className="mb-4 mt-1 text-lg font-semibold text-gray-900">Your try-on result</h2>
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
          <h2 className="text-lg font-semibold text-gray-900 mb-4">History</h2>
          <VtoHistorySection
            onReuseOutfit={handleReuseOutfit}
            onRetryGeneration={handleRetryGeneration}
            basePhotoId={selectedBasePhotoId}
            credits={credits ?? null}
            isGenerating={isStarting || isPolling}
            settledStatus={isTerminal ? result : null}
          />
        </div>
      </div>
    </MirrorErrorBoundary>
  );
}
