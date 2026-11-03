/**
 * Rebuilds a playable WebM/Opus file from MediaRecorder output whose first chunk (EBML header, Tracks and the first
 * cluster) went missing. MediaRecorder writes clusters with absolute timecodes, so a synthetic header plus the data
 * from the first intact cluster onwards decodes normally.
 */

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];

function indexOf(data: Uint8Array, pattern: number[], from = 0) {
  outer: for (let i = from; i <= data.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (data[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

const size8 = (n: number) => {
  const out = [0x01, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 7; i >= 1 && n > 0; i--) {
    out[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return out;
};
const el = (id: number[], body: number[]) => [...id, ...size8(body.length), ...body];
const uint = (id: number[], v: number) => {
  const bytes: number[] = [];
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, bytes);
};
const str = (id: number[], s: string) => el(id, [...new TextEncoder().encode(s)]);
const float64 = (id: number[], v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, [...b]);
};

function header(track: number, channels: number) {
  const opusHead = [...new TextEncoder().encode("OpusHead"), 1, channels, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];
  const ebml = el(EBML_MAGIC, [
    ...uint([0x42, 0x86], 1),
    ...uint([0x42, 0xf7], 1),
    ...uint([0x42, 0xf2], 4),
    ...uint([0x42, 0xf3], 8),
    ...str([0x42, 0x82], "webm"),
    ...uint([0x42, 0x87], 4),
    ...uint([0x42, 0x85], 2),
  ]);
  const info = el([0x15, 0x49, 0xa9, 0x66], [...uint([0x2a, 0xd7, 0xb1], 1_000_000), ...str([0x4d, 0x80], "notesy"), ...str([0x57, 0x41], "notesy")]);
  const entry = el(
    [0xae],
    [
      ...uint([0xd7], track),
      ...uint([0x73, 0xc5], track),
      ...uint([0x83], 2),
      ...str([0x86], "A_OPUS"),
      ...el([0x63, 0xa2], opusHead),
      ...el([0xe1], [...float64([0xb5], 48000), ...uint([0x9f], channels)]),
    ],
  );
  const tracks = el([0x16, 0x54, 0xae, 0x6b], entry);
  const segmentUnknownSize = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  return new Uint8Array([...ebml, ...segmentUnknownSize, ...info, ...tracks]);
}

/** EBML variable-length integer at `pos`: returns value and byte length. */
function vint(data: Uint8Array, pos: number) {
  const first = data[pos];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  let value = first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + data[pos + i];
  return { value, len };
}

export const hasWebmHeader = (data: Uint8Array) => indexOf(data.subarray(0, 4), EBML_MAGIC) === 0;

/** Returns the repaired file and where in the recording its audio starts, or null when no cluster can be found. */
export function repairHeaderlessWebm(data: Uint8Array): { bytes: Uint8Array; startSec: number } | null {
  if (hasWebmHeader(data)) return null;
  const at = indexOf(data, CLUSTER);
  if (at < 0) return null;
  let pos = at + 4;
  pos += vint(data, pos).len;
  let startSec = 0;
  let track = 1;
  for (let guard = 0; guard < 4 && pos < data.length; guard++) {
    const id = data[pos];
    const size = vint(data, pos + 1);
    const body = pos + 1 + size.len;
    if (id === 0xe7) {
      let t = 0;
      for (let i = 0; i < size.value; i++) t = t * 256 + data[body + i];
      startSec = t / 1000;
    } else if (id === 0xa3) {
      track = vint(data, body).value;
      break;
    }
    pos = body + size.value;
  }
  const head = header(track, 2);
  const out = new Uint8Array(head.length + data.length - at);
  out.set(head, 0);
  out.set(data.subarray(at), head.length);
  return { bytes: out, startSec };
}
