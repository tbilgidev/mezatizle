import { NavLink, Route, Routes } from "react-router-dom";
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
        <div className="sidebar-foot">
          Ücretli API yok · Instagram girişi yok · LOCAL profil
        </div>
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
