import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { statusTr } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export function RecordingDetailPage() {
  const { id = "" } = useParams();
  const [recording, setRecording] = useState<Record<string, unknown> | null>(null);
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
      <div className="mx-auto max-w-[1100px]">
        <LoadingState label="Kayıt detayı yükleniyor…" />
      </div>
    );
  }
  if (error && !recording) {
    return (
      <div className="mx-auto max-w-[1100px]">
        <ErrorState message={error} />
      </div>
    );
  }
  if (!recording) return null;

  return (
    <div className="mx-auto max-w-[1100px] animate-rise">
      <p className="mb-3">
        <Link
          to="/recordings"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-fog hover:text-mint"
        >
          <ArrowLeft className="h-4 w-4" />
          Kayıtlar
        </Link>
      </p>
      <PageHeader
        title={String(recording.original_filename)}
        lead={`@${String(recording.instagram_username)}`}
        actions={
          <>
            <Badge variant="warn">{statusTr(String(recording.status))}</Badge>
            <Link
              to={`/reports/${id}`}
              className="inline-flex h-10 items-center rounded-xl bg-mint px-4 text-sm font-semibold text-ink"
            >
              Raporu aç
            </Link>
          </>
        }
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>İş kuyruğu</CardTitle>
        </CardHeader>
        <CardContent>
          {!jobs.length ? (
            <EmptyState title="İş yok" />
          ) : (
            jobs.map((j) => (
              <div key={String(j.id)} className="mb-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <strong className="text-sm">{String(j.job_type)}</strong>
                  <Badge variant="muted">{statusTr(String(j.status))}</Badge>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <i
                    className="block h-full rounded-full bg-gradient-to-r from-mint to-signal"
                    style={{ width: `${Number(j.progress_percent || 0)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-fog">
                  {String(j.stage ?? "")}
                  {j.error_message ? ` — ${j.error_message}` : ""}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Transkript</CardTitle>
        </CardHeader>
        <CardContent>
          {!segments.length ? (
            <EmptyState title="Henüz segment yok" hint="ASR tamamlanınca dolar." />
          ) : (
            <div className="space-y-2">
              {segments.map((s) => (
                <p key={String(s.id)} className="text-sm">
                  <span className="mr-2 text-xs text-fog">
                    {Number(s.start_ms)}–{Number(s.end_ms)}ms
                  </span>
                  {String(s.text)}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mezât olayları</CardTitle>
        </CardHeader>
        <CardContent>
          {!events.length ? (
            <EmptyState title="Olay yok" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Tür</TH>
                  <TH>Offset</TH>
                  <TH>Güven</TH>
                </TR>
              </THead>
              <TBody>
                {events.map((e) => (
                  <TR key={String(e.id)}>
                    <TD>{String(e.event_type)}</TD>
                    <TD>{String(e.offset_ms ?? "—")}</TD>
                    <TD>
                      {e.confidence != null
                        ? Number(e.confidence).toFixed(2)
                        : "—"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
