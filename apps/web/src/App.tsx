import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./lib/api";
import { DashboardPage } from "./pages/DashboardPage";
import { RecordingsPage } from "./pages/RecordingsPage";
import { RecordingDetailPage } from "./pages/RecordingDetailPage";
import { SalesPage } from "./pages/SalesPage";
import { EvidencePage } from "./pages/EvidencePage";
import { SettingsPage } from "./pages/SettingsPage";

const nav = [
  { to: "/", label: "Panel", ico: "P", end: true },
  { to: "/recordings", label: "Kayıtlar", ico: "K" },
  { to: "/sales", label: "Satışlar", ico: "S" },
  { to: "/evidence", label: "Kanıt", ico: "İ" },
  { to: "/settings", label: "Ayarlar", ico: "A" },
] as const;

type FootStatus = {
  hasCookies: boolean;
  profileLabel: string;
  allowPaidApis: boolean;
};

function SidebarFoot() {
  const location = useLocation();
  const [foot, setFoot] = useState<FootStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ig, settings] = await Promise.all([
          api.igSession(),
          api.settings(),
        ]);
        if (cancelled) return;
        const profile = (settings.profile ?? {}) as Record<string, unknown>;
        setFoot({
          hasCookies: Boolean(ig.hasCookies) || ig.status === "yuklu",
          profileLabel: String(profile.profile ?? "LOCAL"),
          allowPaidApis: Boolean(profile.allowPaidApis),
        });
      } catch {
        if (!cancelled) setFoot(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const paid = foot?.allowPaidApis ? "Ücretli API açık" : "Ücretli API yok";
  const ig = foot?.hasCookies
    ? "IG oturum yüklü"
    : "Instagram girişi yok";
  const profile = `${foot?.profileLabel ?? "LOCAL"} profil`;

  return (
    <div className="sidebar-foot" aria-live="polite">
      {paid} · {ig} · {profile}
    </div>
  );
}

export function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <p className="brand">
            mezat<em>izle</em>
          </p>
          <p className="tagline">Canlı mezât zekâsı — yerelde, güvenli</p>
        </div>
        <nav className="nav">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={"end" in item ? item.end : false}>
              <span className="nav-ico">{item.ico}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <SidebarFoot />
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/recordings" element={<RecordingsPage />} />
          <Route path="/recordings/:id" element={<RecordingDetailPage />} />
          <Route path="/sales" element={<SalesPage />} />
          <Route path="/evidence" element={<EvidencePage />} />
          <Route path="/evidence/:id" element={<EvidencePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
