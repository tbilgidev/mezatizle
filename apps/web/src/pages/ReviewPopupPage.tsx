import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { formatTimecode } from "@/lib/seek";
import { EvidencePlayer } from "@/components/EvidencePlayer";
import { ErrorState, LoadingState } from "@/components/States";

/**
 * Dedicated popup window: muxed A/V + synchronized comment HUD.
 * Query: recordingId, offsetMs, optional saleId.
 */
export function ReviewPopupPage() {
  const [params] = useSearchParams();
  const recordingId = (params.get("recordingId") ?? "").trim();
  const saleId = (params.get("saleId") ?? "").trim() || null;
  const offsetRaw = params.get("offsetMs") ?? params.get("t") ?? "0";
  const offsetMs = Math.max(0, Math.round(Number(offsetRaw) || 0));

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mediaPurged, setMediaPurged] = useState(false);
  const [mediaPurgedNoteTr, setMediaPurgedNoteTr] = useState<string | null>(
    null,
  );
  const [seller, setSeller] = useState<string | null>(null);

  useEffect(() => {
    document.title = seller
      ? `Kanıt · @${seller} · mezatizle`
      : "Kanıt videosu · mezatizle";
  }, [seller]);

  useEffect(() => {
    if (!recordingId) {
      setError("recordingId eksik — popup URL’sini rapordan açın.");
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .recording(recordingId)
      .then((d) => {
        if (!alive) return;
        const rec =
          d?.recording && typeof d.recording === "object"
            ? (d.recording as Record<string, unknown>)
            : {};
        const purged =
          rec.mediaPurged === true ||
          (rec.media_purged_at != null &&
            String(rec.media_purged_at).trim() !== "");
        setMediaPurged(purged);
        setMediaPurgedNoteTr(
          rec.mediaPurgedNoteTr != null
            ? String(rec.mediaPurgedNoteTr)
            : null,
        );
        const u =
          rec.instagramUsername ??
          rec.instagram_username ??
          rec.sellerUsername ??
          rec.seller_username;
        setSeller(u != null ? String(u).replace(/^@/, "") : null);
      })
      .catch((e: Error) => {
        if (!alive) return;
        // Still allow player — media route may work even if meta fails.
        setError(e.message || "Kayıt meta yüklenemedi");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [recordingId]);

  const title = useMemo(() => {
    const bits = ["Kanıt videosu"];
    if (seller) bits.push(`@${seller}`);
    bits.push(formatTimecode(offsetMs / 1000));
    if (saleId) bits.push(`satış ${saleId.slice(0, 8)}…`);
    return bits.join(" · ");
  }, [seller, offsetMs, saleId]);

  if (!recordingId) {
    return (
      <div className="min-h-screen bg-ink p-6">
        <ErrorState message="recordingId eksik — popup URL’sini rapordan açın." />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-ink p-6">
        <LoadingState label="Kanıt videosu hazırlanıyor…" />
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-ink px-3 py-3 sm:px-4 sm:py-4"
      data-review-popup="1"
      data-recording-id={recordingId}
      data-sale-id={saleId ?? undefined}
      data-offset-ms={offsetMs}
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-display text-lg font-bold tracking-tight text-paper">
            mezat<em className="not-italic text-mint">izle</em>
            <span className="ml-2 text-sm font-semibold text-fog">
              kanıt penceresi
            </span>
          </p>
          <p className="text-sm text-fog">
            Analiz sekmesini açık tutun — bu pencereyi yanına yerleştirin.
          </p>
        </div>
        <button
          type="button"
          className="rounded-xl border border-line bg-white/5 px-3 py-1.5 text-sm font-semibold text-fog hover:text-paper"
          onClick={() => window.close()}
        >
          Pencereyi kapat
        </button>
      </header>

      {error ? (
        <p className="mb-3 rounded-xl border border-signal/40 bg-signal/10 px-3 py-2 text-sm text-signal">
          {error} — video yine de denenecek.
        </p>
      ) : null}

      <EvidencePlayer
        recordingId={recordingId}
        offsetMs={offsetMs}
        open
        title={title}
        mediaPurged={mediaPurged}
        mediaPurgedNoteTr={mediaPurgedNoteTr}
      />
    </div>
  );
}
