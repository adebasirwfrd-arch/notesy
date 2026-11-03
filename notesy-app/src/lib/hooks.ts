import { useEffect, useRef, useState } from "react";
import { getBlob, getNote, listNotes, listSlides, subscribe } from "./db";
import { workerInterval } from "./ticker";
import { hasWebmHeader, repairHeaderlessWebm } from "./stt/webm";
import type { Note, Slide } from "./types";

export function useNotes() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => listNotes().then((n) => alive && setNotes(n));
    load();
    const off = subscribe("notes", load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return notes;
}

export function useNote(id: string | null) {
  const [note, setNote] = useState<Note | null | undefined>(undefined);
  useEffect(() => {
    if (!id) return setNote(null);
    let alive = true;
    const load = () => getNote(id).then((n) => alive && setNote(n ?? null));
    load();
    const off = subscribe(`note:${id}`, load);
    return () => {
      alive = false;
      off();
    };
  }, [id]);
  return note;
}

export function useSlides(noteId: string | null) {
  const [slides, setSlides] = useState<Slide[]>([]);
  useEffect(() => {
    if (!noteId) return setSlides([]);
    let alive = true;
    const load = () => listSlides(noteId).then((s) => alive && setSlides(s));
    load();
    const off = subscribe(`slides:${noteId}`, load);
    return () => {
      alive = false;
      off();
    };
  }, [noteId]);
  return slides;
}

/**
 * Object URL for recorded audio that browsers can play. Recordings that lost their first chunk get a rebuilt header;
 * their clusters keep the original timecodes, so player time is still meeting time (`startSec` is where audio begins).
 */
export function usePlayableAudio(key: string | null | undefined) {
  const [state, setState] = useState<{ url: string; startSec: number } | null>(null);
  useEffect(() => {
    if (!key) return setState(null);
    let created: string | null = null;
    let alive = true;
    void (async () => {
      const b = await getBlob(key);
      if (!alive || !b) return;
      const head = new Uint8Array(await b.slice(0, 4).arrayBuffer());
      let blob: Blob = b;
      let startSec = 0;
      if (!hasWebmHeader(head) && !b.type.includes("mp4")) {
        const repaired = repairHeaderlessWebm(new Uint8Array(await b.arrayBuffer()));
        if (repaired) {
          blob = new Blob([repaired.bytes as BlobPart], { type: "audio/webm" });
          startSec = repaired.startSec;
        }
      }
      if (!alive) return;
      created = URL.createObjectURL(blob);
      setState({ url: created, startSec });
    })();
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [key]);
  return state;
}

export function useBlobUrl(key: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return setUrl(null);
    let created: string | null = null;
    let alive = true;
    getBlob(key).then((b) => {
      if (!alive || !b) return;
      created = URL.createObjectURL(b);
      setUrl(created);
    });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [key]);
  return url;
}

const tickSubs = new Set<() => void>();
let stopTicker: (() => void) | null = null;

/** Shared ~8 Hz tick that keeps running when the tab is hidden (the floating bar still needs it). */
export function useTick(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const cb = () => ref.current();
    tickSubs.add(cb);
    if (!stopTicker) stopTicker = workerInterval(() => tickSubs.forEach((f) => f()), 120);
    return () => {
      tickSubs.delete(cb);
      if (!tickSubs.size && stopTicker) {
        stopTicker();
        stopTicker = null;
      }
    };
  }, []);
}

export const NARROW = "(max-width: 760px)";

export function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function useHashRoute(): [string[], (path: string) => void] {
  const parse = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (path: string) => (location.hash = `#/${path}`)];
}
