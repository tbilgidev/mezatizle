import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { api } from "@/lib/api";
import { formatTimecode } from "@/lib/seek";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  recordingId: string;
  /** Seek target in milliseconds (timeline offset in muxed MP4). */
  offsetMs: number;
  open: boolean;
  onClose?: () => void;
  title?: string;
};

export function EvidencePlayer({
  recordingId,
  offsetMs,
  open,
  onClose,
  title = "Görüntü inceleme",
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const seekSec = Math.max(0, offsetMs / 1000);
  const src = api.mediaUrl(recordingId);

  useEffect(() => {
    if (!open) return;
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
    // Force reload when opening at a new offset
    v.load();
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("error", onErr);
    };
  }, [open, recordingId, seekSec]);

  if (!open) return null;

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

  return (
    <Card className="mb-4 border-mint/25" data-testid="evidence-player">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-1 text-sm text-fog">
            Kanıt zamanı{" "}
            <span className="font-semibold text-mint">{formatTimecode(seekSec)}</span>
            {" · "}
            muxed kayıt (ses + görüntü)
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
        <div className="overflow-hidden rounded-xl border border-line bg-ink">
          <video
            ref={videoRef}
            className="mx-auto max-h-[420px] w-full bg-black"
            controls
            playsInline
            preload="metadata"
            src={`${src}#t=${seekSec.toFixed(3)}`}
          />
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
          <span className="ml-auto font-mono text-sm text-fog">
            {formatTimecode(current)}
            {duration > 0 ? ` / ${formatTimecode(duration)}` : ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
