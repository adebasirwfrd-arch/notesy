import { BookA, Brain, Database, FileAudio, LayoutTemplate, Menu, MonitorUp, UserRound } from "lucide-react";
import { GeneralSettings } from "./GeneralSettings";
import { RecordingSettings } from "./RecordingSettings";
import { TranscriptionSettings } from "./TranscriptionSettings";
import { IntelligenceSettings } from "./IntelligenceSettings";
import { TemplateSettings } from "./TemplateSettings";
import { DictionarySettings } from "./DictionarySettings";
import { DataSettings } from "./DataSettings";

const SECTIONS = [
  { id: "general", label: "Umum", icon: UserRound, el: GeneralSettings },
  { id: "intelligence", label: "Intelligence", icon: Brain, el: IntelligenceSettings },
  { id: "recording", label: "Rekaman", icon: MonitorUp, el: RecordingSettings },
  { id: "transcription", label: "Transkripsi", icon: FileAudio, el: TranscriptionSettings },
  { id: "templates", label: "Template", icon: LayoutTemplate, el: TemplateSettings },
  { id: "dictionary", label: "Kamus", icon: BookA, el: DictionarySettings },
  { id: "data", label: "Data", icon: Database, el: DataSettings },
];

interface Props {
  section?: string;
  onNavigate: (p: string) => void;
  onToggleSidebar: () => void;
}

export function SettingsView({ section, onNavigate, onToggleSidebar }: Props) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const El = current.el;
  return (
    <div className="page settings">
      <header className="page-header">
        <button className="icon-btn only-mobile" onClick={onToggleSidebar} aria-label="Menu">
          <Menu size={20} />
        </button>
        <h2>Pengaturan</h2>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={s.id === current.id ? "active" : ""} onClick={() => onNavigate(`settings/${s.id}`)}>
              <s.icon size={16} /> {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <h3>{current.label}</h3>
          <El />
        </div>
      </div>
    </div>
  );
}
