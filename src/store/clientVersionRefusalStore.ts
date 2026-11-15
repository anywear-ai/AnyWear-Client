import { create } from 'zustand';
import type { ClientVersionRefusal } from '../lib/client-version-refusal';

interface ClientVersionRefusalState {
  /** The refusal this document received, or null while nothing was refused. */
  refusal: ClientVersionRefusal | null;
  /**
   * Records a refusal. The first one wins: a later refusal is ignored, so the
   * versions the user first saw never change underneath them.
   */
  recordRefusal: (refusal: ClientVersionRefusal) => void;
}

/**
 * The terminal fact that this build is unusable, held for the life of the
 * document.
 *
 * Deliberately not `useAuthStore`: `logout()` and `clearLocalAuth()` write auth
 * fields, so a refusal stored there could be erased by a re-login, and
 * `AuthGate` subscribes to the whole auth store, so an unrelated write would
 * discard its in-flight bootstrap. In-memory rather than persisted is what makes
 * the state non-dismissible in both directions: a document reload starts empty,
 * and a build at or above the floor never receives a refusal.
 *
 * There is no clear path. The write is monotonic by design; only a new document
 * clears it.
 */
export const useClientVersionRefusalStore = create<ClientVersionRefusalState>((set) => ({
  refusal: null,
  recordRefusal: (refusal: ClientVersionRefusal) => {
    set((state) => (state.refusal === null ? { refusal } : state));
  },
}));

/** Whether this document has been refused, readable outside React. */
export function isClientVersionRefused(): boolean {
  return useClientVersionRefusalStore.getState().refusal !== null;
}
