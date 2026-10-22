import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { api } from "@/lib/api";
import { formatTimecode } from "@/lib/seek";
import {
  PLAYBACK_RATES,
  playbackRateLabelTr,
  readStoredPlaybackRate,
  storePlaybackRate,
  type PlaybackRate,
} from "@/lib/playback-rate";
import {
  currentCommentIndex,
  latestActiveComment,
  normalizeReviewComments,
  type ReviewComment,
} from "@/lib/review-comments";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  recordingId: string;
  /** Seek target in milliseconds (timeline offset in muxed MP4). */
  offsetMs: number;
  open: boolean;
  onClose?: () => void;
  title?: string;
  /** When true, master MP4 was deleted by retention — show note, no player. */
  mediaPurged?: boolean;
  mediaPurgedNoteTr?: string | null;
};

export function EvidencePlayer({
  recordingId,
  offsetMs,
  open,
  onClose,
  title = "Görüntü inceleme",
  mediaPurged = false,
  mediaPurgedNoteTr = null,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rateRef = useRef<PlaybackRate>(readStoredPlaybackRate());
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [rate, setRate] = useState<PlaybackRate>(() => rateRef.current);
  const seekSec = Math.max(0, offsetMs / 1000);
  const src = api.mediaUrl(recordingId);
  const purgedNote =
    mediaPurgedNoteTr?.trim() ||
    "Video 1 hafta sonra silindi; analiz duruyor";

  const currentMs = current * 1000;
  const hudComment = useMemo(
    () => latestActiveComment(comments, currentMs),
    [comments, currentMs],
  );
  const activeIdx = useMemo(
    () => currentCommentIndex(comments, currentMs),
    [comments, currentMs],
  );

  useEffect(() => {
    if (!open || mediaPurged) return;
    setError(null);
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      setDuration(v.duration || 0);
      try {
        v.currentTime = seekSec;
      } catch {
        /* ignore until canplay */
      }
      v.playbackRate = rateRef.current;
    };
    const onTime = () => setCurrent(v.currentTime || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onErr = () =>
      setError("Video yüklenemedi. Kayıt dosyası eksik veya erişilemiyor olabilir.");
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("error", onErr);
    // Force reload when opening at a new offset (rate changes must not re-load)
    v.load();
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("error", onErr);
    };
  }, [open, recordingId, seekSec, mediaPurged]);

  useEffect(() => {
    if (!open || mediaPurged) {
      setComments([]);
      setCommentsError(null);
      return;
    }
    let alive = true;
    setCommentsLoading(true);
    setCommentsError(null);
    api
      .comments(recordingId)
      .then((d) => {
        if (!alive) return;
        setComments(
          normalizeReviewComments(
            (d.comments ?? []) as Array<Record<string, unknown>>,
          ),
        );
      })
      .catch((e: Error) => {
        if (!alive) return;
        setComments([]);
        setCommentsError(e.message || "Yorumlar yüklenemedi");
      })
      .finally(() => {
        if (alive) setCommentsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, recordingId, mediaPurged]);

  useEffect(() => {
    rateRef.current = rate;
    const v = videoRef.current;
    if (v) v.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    if (!open || activeIdx < 0) return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector(`[data-comment-idx="${activeIdx}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeIdx, open]);

  if (!open) return null;

  if (mediaPurged) {
    return (
      <Card className="mb-4 border-line" data-testid="evidence-player-purged">
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle>{title}</CardTitle>
            <p className="mt-1 text-sm text-fog" data-media-purged={recordingId}>
              {purgedNote}
            </p>
          </div>
          {onClose ? (
            <Button type="button" size="sm" variant="secondary" onClick={onClose}>
              Kapat
            </Button>
          ) : null}
        </CardHeader>
      </Card>
    );
  }

  function nudge(delta: number) {
    const v = videoRef.current;
    if (!v) return;
    const next = Math.max(0, Math.min((v.duration || Infinity) - 0.05, v.currentTime + delta));
    v.currentTime = next;
    setCurrent(next);
  }

  function jumpEvidence() {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seekSec;
    setCurrent(seekSec);
    void v.play().catch(() => undefined);
  }

  async function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) await v.play().catch(() => undefined);
    else v.pause();
  }

  function applyRate(next: PlaybackRate) {
    setRate(next);
    storePlaybackRate(next);
    const v = videoRef.current;
    if (v) v.playbackRate = next;
  }

  return (
    <Card className="mb-4 border-mint/25" data-testid="evidence-player">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-1 text-sm text-fog">
            Kanıt zamanı{" "}
            <span className="font-semibold text-mint">{formatTimecode(seekSec)}</span>
            {" · "}
            muxed kayıt (ses + görüntü) · yorumlar veritabanından
          </p>
        </div>
        {onClose ? (
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>
            Kapat
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-3 rounded-xl border border-rose/30 bg-rose/10 px-3 py-2 text-sm text-rose">
            {error}
          </p>
        )}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,280px)]">
          <div className="relative overflow-hidden rounded-xl border border-line bg-ink">
            <video
              ref={videoRef}
              className="mx-auto max-h-[420px] w-full bg-black"
              controls
              playsInline
              preload="metadata"
              src={`${src}#t=${seekSec.toFixed(3)}`}
            />
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-3 pb-3 pt-10"
              data-testid="comment-overlay"
              aria-live="polite"
            >
              {hudComment ? (
                <div className="max-w-[92%] rounded-lg border border-white/15 bg-black/55 px-3 py-2 text-sm text-paper shadow-sm backdrop-blur-[2px]">
                  <p className="font-mono text-[11px] text-mint-bright/90">
                    {formatTimecode(hudComment.offsetMs / 1000)}
                    {hudComment.author ? (
                      <>
                        {" · "}
                        <span className="font-semibold">@{hudComment.author}</span>
                      </>
                    ) : null}
                  </p>
                  <p className="mt-0.5 leading-snug">{hudComment.body}</p>
                </div>
              ) : (
                <p className="text-xs text-white/55">
                  {commentsLoading
                    ? "Yorumlar yükleniyor…"
                    : comments.length
                      ? "Bu anda aktif yorum yok"
                      : "Kayıtlı yorum yok"}
                </p>
              )}
            </div>
          </div>

          <div
            className="flex max-h-[420px] flex-col overflow-hidden rounded-xl border border-line bg-panel/60"
            data-testid="comment-side-panel"
          >
            <div className="border-b border-line px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-fog">
                Yorumlar
              </p>
              <p className="text-sm text-paper">
                {commentsLoading
                  ? "Yükleniyor…"
                  : `${comments.length} yorum · oynatma ile senkron`}
              </p>
            </div>
            {commentsError ? (
              <p className="px-3 py-2 text-sm text-rose">{commentsError}</p>
            ) : null}
            <ul ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              {!commentsLoading && !comments.length && !commentsError ? (
                <li className="px-2 py-3 text-sm text-fog">
                  Bu kayıt için zamanlı yorum yok.
                </li>
              ) : null}
              {comments.map((c, i) => {
                const isCurrent = i === activeIdx;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      data-comment-idx={i}
                      data-active={isCurrent ? "1" : "0"}
                      className={`w-full rounded-lg border px-2.5 py-2 text-left text-sm transition ${
                        isCurrent
                          ? "border-mint/40 bg-mint/10 text-paper"
                          : "border-transparent bg-transparent text-fog hover:border-line hover:bg-ink/40 hover:text-paper"
                      }`}
                      onClick={() => {
                        const v = videoRef.current;
                        if (!v) return;
                        const sec = c.offsetMs / 1000;
                        v.currentTime = sec;
                        setCurrent(sec);
                      }}
                    >
                      <span className="font-mono text-[11px] text-mint">
                        {formatTimecode(c.offsetMs / 1000)}
                      </span>
                      {c.author ? (
                        <span className="ml-1.5 font-semibold text-paper/90">
                          @{c.author}
                        </span>
                      ) : null}
                      <span className="mt-0.5 block line-clamp-3 leading-snug">
                        {c.body}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => void togglePlay()}>
            {playing ? (
              <>
                <Pause className="h-3.5 w-3.5" /> Duraklat
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" /> Oynat
              </>
            )}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => nudge(-5)}>
            <SkipBack className="h-3.5 w-3.5" /> −5 sn
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => nudge(5)}>
            +5 sn <SkipForward className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={jumpEvidence}>
            <RotateCcw className="h-3.5 w-3.5" /> Kanıta dön
          </Button>

          <div
            className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-ink/40 p-1"
            role="group"
            aria-label="Oynatma hızı"
            data-testid="playback-rate"
          >
            <span className="px-1.5 text-xs font-semibold text-fog">Hız</span>
            {PLAYBACK_RATES.map((r) => (
              <button
                key={r}
                type="button"
                data-rate={r}
                data-active={rate === r ? "1" : "0"}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  rate === r
                    ? "bg-mint/20 text-mint"
                    : "text-fog hover:bg-white/5 hover:text-paper"
                }`}
                onClick={() => applyRate(r)}
              >
                {playbackRateLabelTr(r)}
              </button>
            ))}
          </div>

          <span className="ml-auto font-mono text-sm text-fog">
            {formatTimecode(current)}
            {duration > 0 ? ` / ${formatTimecode(duration)}` : ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
