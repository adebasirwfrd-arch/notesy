// Forwards mono PCM from the audio thread in ~0.25 s blocks for live transcription.
const BLOCK = 4096;

class NotesyTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BLOCK);
    this.n = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const len = channels[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < channels.length; c++) s += channels[c][i];
      this.buf[this.n++] = s / channels.length;
      if (this.n === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("notesy-tap", NotesyTap);
