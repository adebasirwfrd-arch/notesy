import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { NoteView } from "./components/NoteView";
import { SettingsView } from "./components/settings/SettingsView";
import { Home } from "./components/Home";
import { Toasts } from "./components/Toasts";
import { PipBar } from "./components/PipBar";
import { GpuTest } from "./components/GpuTest";
import { NARROW, useHashRoute, useMediaQuery } from "./lib/hooks";
import { useLiveSession } from "./lib/session";

export function App() {
  const [route, go] = useHashRoute();
  const live = useLiveSession();
  const narrow = useMediaQuery(NARROW);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, id] = route;

  useEffect(() => {
    if (live && view !== "note") go(`note/${live.noteId}`);
  }, [live?.noteId]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [view, id, narrow]);

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`}>
      <Sidebar activeId={view === "note" ? id : undefined} onNavigate={go} onClose={() => setSidebarOpen(false)} />
      {narrow && sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
      <main className="main">
        {view === "gputest" ? (
          <GpuTest />
        ) : view === "note" && id ? (
          <NoteView key={id} noteId={id} onNavigate={go} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        ) : view === "settings" ? (
          <SettingsView section={id} onNavigate={go} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        ) : (
          <Home onNavigate={go} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        )}
      </main>
      <PipBar />
      <Toasts />
    </div>
  );
}
