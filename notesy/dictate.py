import subprocess
import threading
import time

import numpy as np
import rumps
import sounddevice as sd
from pynput import keyboard

from . import config, transcribe
from .glossary import Glossary

HOTKEY = "<ctrl>+<alt>+<space>"
HOTKEY_LABEL = "⌃⌥Space"
LANGUAGES = {"Otomatis": None, "Indonesia": "id", "English": "en"}

IDLE, RECORDING, WORKING = "idle", "recording", "working"
TITLES = {IDLE: "◎", RECORDING: "● REC", WORKING: "…"}


def _paste(text: str) -> None:
    previous = subprocess.run(["pbpaste"], capture_output=True).stdout
    subprocess.run(["pbcopy"], input=text.encode())
    ctl = keyboard.Controller()
    with ctl.pressed(keyboard.Key.cmd):
        ctl.press("v")
        ctl.release("v")
    time.sleep(0.4)
    subprocess.run(["pbcopy"], input=previous)


class DictateApp(rumps.App):
    def __init__(self):
        super().__init__("Notesy", title=TITLES[IDLE], quit_button=None)
        self.state = IDLE
        self.language = None
        self.chunks: list[np.ndarray] = []
        self.stream: sd.InputStream | None = None
        self.glossary = Glossary.load()
        self.last_text = ""

        self.toggle_item = rumps.MenuItem(f"Mulai dikte  ({HOTKEY_LABEL})", callback=self.on_toggle)
        lang_menu = rumps.MenuItem("Bahasa")
        for label in LANGUAGES:
            item = rumps.MenuItem(label, callback=self.on_language)
            item.state = label == "Otomatis"
            lang_menu.add(item)
        self.lang_menu = lang_menu
        self.menu = [
            self.toggle_item,
            None,
            lang_menu,
            rumps.MenuItem("Tempel ulang hasil terakhir", callback=self.on_repaste),
            rumps.MenuItem("Buka kamus custom", callback=self.on_open_glossary),
            rumps.MenuItem("Muat ulang kamus", callback=self.on_reload_glossary),
            None,
            rumps.MenuItem("Keluar", callback=lambda _: rumps.quit_application()),
        ]

        self.hotkeys = keyboard.GlobalHotKeys({HOTKEY: self.toggle})
        self.hotkeys.start()
        rumps.Timer(self._refresh, 0.2).start()
        threading.Thread(target=self._warm_up, daemon=True).start()

    def _warm_up(self):
        self.state = WORKING
        try:
            transcribe.text_only(np.zeros(config.SAMPLE_RATE, np.float32), self.glossary)
        finally:
            self.state = IDLE

    def _refresh(self, _):
        self.title = TITLES[self.state]
        self.toggle_item.title = (
            f"Berhenti dan ketik  ({HOTKEY_LABEL})" if self.state == RECORDING
            else f"Mulai dikte  ({HOTKEY_LABEL})"
        )

    def toggle(self):
        if self.state == IDLE:
            self._start()
        elif self.state == RECORDING:
            self._stop()

    def on_toggle(self, _):
        self.toggle()

    def _start(self):
        self.chunks = []
        self.stream = sd.InputStream(
            samplerate=config.SAMPLE_RATE, channels=1, dtype="float32",
            callback=lambda data, *_: self.chunks.append(data[:, 0].copy()),
        )
        self.stream.start()
        self.state = RECORDING

    def _stop(self):
        self.stream.stop()
        self.stream.close()
        self.stream = None
        samples = np.concatenate(self.chunks) if self.chunks else np.zeros(0, np.float32)
        self.state = WORKING
        threading.Thread(target=self._finish, args=(samples,), daemon=True).start()

    def _finish(self, samples: np.ndarray):
        try:
            if len(samples) < config.SAMPLE_RATE * 0.3:
                return
            text = transcribe.text_only(samples, self.glossary, self.language)
            if text:
                self.last_text = text
                _paste(text + " ")
        except Exception as e:
            rumps.notification("Notesy", "Dikte gagal", str(e))
        finally:
            self.state = IDLE

    def on_language(self, sender):
        for item in self.lang_menu.values():
            item.state = item.title == sender.title
        self.language = LANGUAGES[sender.title]

    def on_repaste(self, _):
        if self.last_text:
            _paste(self.last_text + " ")

    def on_open_glossary(self, _):
        config.ensure_dirs()
        subprocess.run(["open", "-t", str(config.GLOSSARY)])

    def on_reload_glossary(self, _):
        self.glossary = Glossary.load()
        rumps.notification("Notesy", "Kamus dimuat ulang",
                           f"{len(self.glossary.vocabulary)} istilah aktif")


def run() -> None:
    from AppKit import NSApplication

    NSApplication.sharedApplication().setActivationPolicy_(1)
    DictateApp().run()
