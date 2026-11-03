import argparse
import subprocess
import sys
from pathlib import Path

from . import config

AGENT_LABEL = "so.notesy.dictate"
AGENT_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{AGENT_LABEL}.plist"


def cmd_setup(a):
    from . import setup

    setup.run(skip_whisper=a.skip_whisper)


def cmd_enroll(a):
    from . import audio, diarize

    if a.file:
        samples = audio.load(a.file)
    else:
        print(f"Bicara secara natural selama {a.seconds} detik setelah tanda ini... MULAI")
        samples = audio.record(a.seconds)
        print("Selesai merekam.")
    if len(samples) < config.SAMPLE_RATE * 3:
        sys.exit("Sampel terlalu pendek; butuh minimal 3 detik suara.")
    n = diarize.save_voiceprint(a.name, diarize.embed(samples))
    print(f"Voiceprint '{a.name}' tersimpan ({n} sampel). Tambah sampel lagi untuk akurasi lebih tinggi.")


def cmd_speakers(a):
    from . import diarize

    if a.delete:
        print("Dihapus." if diarize.delete_voiceprint(a.delete) else "Tidak ditemukan.")
        return
    prints = diarize.load_voiceprints()
    if not prints:
        print("Belum ada voiceprint. Gunakan: notesy enroll \"Nama\"")
    for name in sorted(prints):
        print(f"- {name}")


def cmd_process(a):
    from . import anarlog, pipeline

    path = Path(a.audio).expanduser() if a.audio else None
    if a.meeting and not path:
        path = anarlog.find_recording(a.meeting)
        if not path:
            sys.exit("Rekaman rapat tidak ditemukan lewat Anarlog. Berikan path audio secara langsung.")
    if not path or not path.exists():
        sys.exit("File audio tidak ditemukan.")
    title = a.title
    if a.meeting and not title:
        title = (anarlog.get_meeting(a.meeting).get("title") or None)
    md, js = pipeline.process(path, title=title, num_speakers=a.speakers, language=a.language)
    print(f"\nCatatan : {md}\nData    : {js}")
    if a.meeting and a.propose:
        anarlog.propose_memo(a.meeting, md)
        print("Usulan memo dikirim ke Anarlog. Terima atau tolak di aplikasi desktop.")
    if a.open:
        subprocess.run(["open", str(md)])


def cmd_name(a):
    from . import pipeline

    md = pipeline.rename_speaker(Path(a.notes).expanduser(), a.label, a.name)
    print(f"Catatan diperbarui: {md}")


def cmd_meetings(a):
    from . import anarlog

    for m in anarlog.list_meetings(a.query):
        print(f"{m.get('id')}  {m.get('started_at') or m.get('created_at') or ''}  {m.get('title') or ''}")


def cmd_dictate(a):
    from . import dictate

    dictate.run()


def cmd_glossary(a):
    config.ensure_dirs()
    if a.add:
        import yaml

        data = yaml.safe_load(config.GLOSSARY.read_text()) or {}
        key = "people" if a.person else "terms"
        entry = a.add if a.person else {"term": a.add, "aliases": a.alias or []}
        if not data.get(key):
            data[key] = []
        data[key].append(entry)
        config.GLOSSARY.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
        print(f"Ditambahkan ke {key}: {a.add}")
    else:
        print(config.GLOSSARY)
        subprocess.run(["open", "-t", str(config.GLOSSARY)])


def cmd_autostart(a):
    if a.state == "off":
        subprocess.run(["launchctl", "unload", str(AGENT_PLIST)], capture_output=True)
        AGENT_PLIST.unlink(missing_ok=True)
        print("Autostart dimatikan.")
        return
    exe = Path(sys.argv[0]).resolve()
    log = config.HOME / "dictate.log"
    AGENT_PLIST.parent.mkdir(parents=True, exist_ok=True)
    AGENT_PLIST.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>{exe}</string><string>dictate</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string><key>HF_HUB_OFFLINE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict></plist>
""")
    subprocess.run(["launchctl", "unload", str(AGENT_PLIST)], capture_output=True)
    subprocess.run(["launchctl", "load", str(AGENT_PLIST)], check=True)
    print(f"Dikte Notesy aktif dan akan otomatis jalan saat login. Log: {log}")


def main() -> None:
    p = argparse.ArgumentParser(prog="notesy", description="Pendamping lokal untuk Anarlog")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("setup", help="Unduh model dan kamus offline")
    s.add_argument("--skip-whisper", action="store_true")
    s.set_defaults(func=cmd_setup)

    s = sub.add_parser("enroll", help="Daftarkan voiceprint seseorang")
    s.add_argument("name")
    s.add_argument("--file", help="Rekaman suara orang tersebut (hanya dia yang bicara)")
    s.add_argument("--seconds", type=int, default=20)
    s.set_defaults(func=cmd_enroll)

    s = sub.add_parser("speakers", help="Lihat atau hapus voiceprint")
    s.add_argument("--delete", metavar="NAMA")
    s.set_defaults(func=cmd_speakers)

    s = sub.add_parser("process", help="Buat catatan cerdas dari rekaman")
    s.add_argument("audio", nargs="?")
    s.add_argument("--meeting", help="ID rapat Anarlog")
    s.add_argument("--title")
    s.add_argument("--speakers", type=int, help="Jumlah pembicara jika sudah diketahui")
    s.add_argument("--language", help="id, en, ... (default: deteksi otomatis)")
    s.add_argument("--propose", action="store_true", help="Kirim catatan sebagai usulan memo ke Anarlog")
    s.add_argument("--open", action="store_true")
    s.set_defaults(func=cmd_process)

    s = sub.add_parser("name", help="Beri nama pembicara dan pelajari suaranya")
    s.add_argument("notes", help="File .json hasil notesy process")
    s.add_argument("label", help='Contoh: "Pembicara 1"')
    s.add_argument("name")
    s.set_defaults(func=cmd_name)

    s = sub.add_parser("meetings", help="Daftar rapat di Anarlog")
    s.add_argument("query", nargs="?")
    s.set_defaults(func=cmd_meetings)

    s = sub.add_parser("dictate", help="Jalankan aplikasi dikte di menu bar")
    s.set_defaults(func=cmd_dictate)

    s = sub.add_parser("glossary", help="Buka atau tambah kamus custom")
    s.add_argument("--add")
    s.add_argument("--alias", action="append", help="Ejaan salah yang sering muncul")
    s.add_argument("--person", action="store_true")
    s.set_defaults(func=cmd_glossary)

    s = sub.add_parser("autostart", help="Jalankan dikte otomatis saat login")
    s.add_argument("state", choices=["on", "off"])
    s.set_defaults(func=cmd_autostart)

    a = p.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
