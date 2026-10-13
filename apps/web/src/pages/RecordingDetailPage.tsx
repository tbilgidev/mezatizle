import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { EmptyState, ErrorState, LoadingState } from "../components/States";

export function RecordingDetailPage() {
  const { id = "" } = useParams();
  const [recording, setRecording] = useState<Record<string, unknown> | null>(
    null,
  );
  const [jobs, setJobs] = useState<Array<Record<string, unknown>>>([]);
  const [segments, setSegments] = useState<Array<Record<string, unknown>>>([]);
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [rec, tr, ev] = await Promise.all([
          api.recording(id),
          api.transcript(id),
          api.events(id),
        ]);
        if (!alive) return;
        setRecording(rec.recording);
        setJobs(rec.jobs);
        setSegments(tr.segments);
        setEvents(ev.events);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  if (loading && !recording) {
    return (
      <div className="page">
        <LoadingState label="Kayıt detayı yükleniyor…" />
      </div>
    );
  }
  if (error && !recording) {
    return (
      <div className="page">
        <ErrorState message={error} />
      </div>
    );
  }
  if (!recording) return null;

  return (
    <div className="page">
      <p>
        <Link to="/recordings">← Kayıtlar</Link>
      </p>
      <div className="page-head">
        <div>
          <h1>{String(recording.original_filename)}</h1>
          <p className="lead">
            @{String(recording.instagram_username)} ·{" "}
            <span className="badge warn">{String(recording.status)}</span>
          </p>
        </div>
      </div>

      <div className="panel">
        <h2>İş kuyruğu</h2>
        {!jobs.length ? (
          <EmptyState title="İş yok" />
        ) : (
          jobs.map((j) => (
            <div key={String(j.id)} style={{ marginBottom: "0.9rem" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{String(j.job_type)}</strong>
                <span className="badge">{String(j.status)}</span>
              </div>
              <div className="progress">
                <i style={{ width: `${Number(j.progress_percent || 0)}%` }} />
              </div>
              <p className="muted" style={{ marginBottom: 0 }}>
                {String(j.stage ?? "")}
                {j.error_message ? ` — ${j.error_message}` : ""}
              </p>
            </div>
          ))
        )}
      </div>

      <div className="panel">
        <h2>Transkript</h2>
        {!segments.length ? (
          <EmptyState title="Henüz segment yok" hint="ASR tamamlanınca dolar." />
        ) : (
          segments.map((s) => (
            <p key={String(s.id)}>
              <span className="muted">
                {Number(s.start_ms)}–{Number(s.end_ms)}ms
              </span>{" "}
              {String(s.text)}
            </p>
          ))
        )}
      </div>

      <div className="panel">
        <h2>Mezât olayları</h2>
        {!events.length ? (
          <EmptyState title="Olay yok" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Tür</th>
                <th>Offset</th>
                <th>Güven</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={String(e.id)}>
                  <td>{String(e.event_type)}</td>
                  <td>{String(e.offset_ms ?? "—")}</td>
                  <td>
                    {e.confidence != null
                      ? Number(e.confidence).toFixed(2)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
