import type { PlaybackState } from '../../../shared/protocol';

export function initialState(): PlaybackState {
  return {
    current: null,
    playing: false,
    position: 0,
    updatedAt: Date.now(),
    version: 0,
    by: null,
    byName: null,
  };
}
