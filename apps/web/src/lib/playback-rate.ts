/** Review-player playback rates (Turkish UI labels). */

export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

const STORAGE_KEY = "mezatizle.playbackRate";

export function playbackRateLabelTr(rate: number): string {
  if (rate === 1) return "1×";
  if (rate === 1.25) return "1,25×";
  if (rate === 1.5) return "1,5×";
  if (rate === 2) return "2×";
  return `${String(rate).replace(".", ",")}×`;
}

export function readStoredPlaybackRate(): PlaybackRate {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw != null ? Number(raw) : NaN;
    if ((PLAYBACK_RATES as readonly number[]).includes(n)) {
      return n as PlaybackRate;
    }
  } catch {
    /* private mode / SSR */
  }
  return 1;
}

export function storePlaybackRate(rate: PlaybackRate): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(rate));
  } catch {
    /* ignore */
  }
}
