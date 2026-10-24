import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
  ClipboardList,
  FileBarChart2,
  LayoutDashboard,
  Settings2,
  ShieldCheck,
  Video,
} from "lucide-react";
import { api } from "./lib/api";
import { cn } from "./lib/utils";
import { DashboardPage } from "./pages/DashboardPage";
import { RecordingsPage } from "./pages/RecordingsPage";
import { RecordingDetailPage } from "./pages/RecordingDetailPage";
import { ReportsPage } from "./pages/ReportsPage";
import { ReportDetailPage } from "./pages/ReportDetailPage";
import { EvidencePage } from "./pages/EvidencePage";
import { SettingsPage } from "./pages/SettingsPage";

const nav = [
  { to: "/", label: "Panel", icon: LayoutDashboard, end: true },
  { to: "/recordings", label: "Kayıtlar", icon: Video },
  { to: "/reports", label: "Raporlar", icon: FileBarChart2 },
  { to: "/evidence", label: "Kanıt", icon: ShieldCheck },
  { to: "/settings", label: "Ayarlar", icon: Settings2 },
] as const;

type FootStatus = {
  hasCookies: boolean;
  profileLabel: string;
  allowPaidApis: boolean;
  autoFollowLabel: string;
  watching: string;
  healthOk: boolean;
  healthAlertTr: string | null;
};

function SidebarFoot() {
  const location = useLocation();
  const [foot, setFoot] = useState<FootStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ig, settings, af] = await Promise.all([
          api.igSession(),
          api.settings(),
          api.autoFollowLive(),
        ]);
        if (cancelled) return;
        const profile = (settings.profile ?? {}) as Record<string, unknown>;
        const watching =
          af.currentlyWatching?.length > 0
            ? af.currentlyWatching.map((w) => `@${w.username}`).join(", ")
            : "izlenen yok";
        const healthAlertTr =
          typeof af.healthAlertTr === "string" ? af.healthAlertTr : null;
        const healthOk = af.healthOk !== false && !healthAlertTr;
        setFoot({
          hasCookies: Boolean(ig.hasCookies) || ig.status === "yuklu",
          profileLabel: String(profile.profile ?? "LOCAL"),
          allowPaidApis: Boolean(profile.allowPaidApis),
          autoFollowLabel: af.enabled
            ? "Takip canlı: açık"
            : "Takip canlı: kapalı",
          watching,
          healthOk,
          healthAlertTr,
        });
      } catch {
        if (!cancelled) {
          setFoot({
            hasCookies: false,
            profileLabel: "LOCAL",
            allowPaidApis: false,
            autoFollowLabel: "Takip canlı: —",
            watching: "izlenen yok",
            healthOk: false,
            healthAlertTr:
              "API yanıt vermiyor — takip canlı / kayıt durumu bilinmiyor.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const paid = foot?.allowPaidApis ? "Ücretli API açık" : "Ücretli API yok";
  const ig = foot?.hasCookies ? "IG oturum yüklü" : "Instagram girişi yok";
  const profile = `${foot?.profileLabel ?? "LOCAL"} profil`;
  const af = foot?.autoFollowLabel ?? "Takip canlı: —";
  const watching = foot?.watching ?? "izlenen yok";
  const alert = foot?.healthAlertTr;
  const alertClass = alert
    ? "mt-auto rounded-2xl border border-signal/50 bg-signal/10 px-3.5 py-3 text-[0.82rem] leading-relaxed text-paper"
    : "mt-auto rounded-2xl border border-line bg-mint/5 px-3.5 py-3 text-[0.82rem] leading-relaxed text-fog";

  return (
    <div className={alertClass} aria-live="polite">
      <div
        className={`mb-1.5 flex items-center gap-2 ${alert ? "text-signal" : "text-mint"}`}
      >
        <ClipboardList className="h-3.5 w-3.5" aria-hidden />
        <span className="font-semibold text-paper/90">
          {alert ? "Durum — UYARI" : "Durum"}
        </span>
      </div>
      {alert ? (
        <div className="mb-2 font-medium text-signal">{alert}</div>
      ) : null}
      <div>
        {paid} · {ig} · {profile}
      </div>
      <div className="mt-1.5 text-paper/80">
        {af} · {watching}
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative z-[1] grid min-h-screen grid-cols-1 md:grid-cols-[268px_1fr]">
      <aside className="sticky top-0 z-10 flex h-auto flex-col gap-5 border-b border-line bg-panel/75 px-5 py-5 backdrop-blur-xl md:h-screen md:border-b-0 md:border-r md:px-5 md:py-7">
        <div className="animate-brand">
          <p className="font-display text-[clamp(1.85rem,2.4vw,2.3rem)] font-extrabold tracking-[-0.04em] leading-none text-paper">
            mezat
            <em className="relative not-italic text-mint">
              izle
              <span
                className="absolute inset-x-0 bottom-[0.08em] h-[0.16em] rounded-full bg-gradient-to-r from-signal/80 to-transparent opacity-70"
                aria-hidden
              />
            </em>
          </p>
          <p className="mt-2 max-w-[22ch] text-[0.9rem] text-fog">
            Canlı mezât zekâsı — yerelde, güvenli
          </p>
        </div>

        <nav className="flex flex-row flex-wrap gap-1.5 md:flex-col md:gap-1">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={"end" in item ? item.end : false}
                className={({ isActive }) =>
                  cn(
                    "group flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-fog transition-all duration-200 hover:translate-x-0.5 hover:bg-mint/10 hover:text-paper",
                    isActive &&
                      "bg-gradient-to-br from-mint/15 to-signal/10 text-paper shadow-[inset_0_0_0_1px_rgba(45,212,191,0.18)]",
                  )
                }
              >
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-mint/10 text-mint transition-colors group-hover:bg-mint/15">
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                </span>
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="hidden md:block">
          <SidebarFoot />
        </div>
      </aside>

      <main className="px-[clamp(1.1rem,3vw,2.4rem)] pb-14 pt-[clamp(1.1rem,2.5vw,2.2rem)]">
        {children}
      </main>
    </div>
  );
}

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/recordings" element={<RecordingsPage />} />
        <Route path="/recordings/:id" element={<RecordingDetailPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/reports/:recordingId" element={<ReportDetailPage />} />
        <Route path="/sales" element={<Navigate to="/reports" replace />} />
        <Route path="/sales/*" element={<Navigate to="/reports" replace />} />
        <Route path="/evidence" element={<EvidencePage />} />
        <Route path="/evidence/:id" element={<EvidencePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </Shell>
  );
}
