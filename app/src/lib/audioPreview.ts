/** One owner for pending play promises, native media events and cancellation. */
export class AudioPreview {
  private audio: HTMLAudioElement | null = null;
  private path = "";
  constructor(private changed: (path: string) => void, private create = (src: string) => new Audio(src)) {}
  stopPath(path: string) { if (this.path === path) this.stop(); }
  retain(paths: string[]) { if (this.path && !paths.includes(this.path)) this.stop(); }
  setVolume(value: number) { if (this.audio) this.audio.volume = value; }
  stop = () => {
    const old = this.audio;
    this.audio = null;
    this.path = "";
    if (old) { old.onended = null; old.onerror = null; old.pause(); old.removeAttribute("src"); old.load(); }
    this.changed("");
  };
  async toggle(path: string, src: string, volume: number, onError: () => void) {
    const same = this.path === path;
    this.stop();
    if (same) return;
    let audio: HTMLAudioElement;
    try { audio = this.create(src); } catch { onError(); return; }
    this.audio = audio;
    this.path = path;
    audio.volume = volume;
    const fail = () => { if (this.audio === audio) { this.stop(); onError(); } };
    audio.onended = () => { if (this.audio === audio) this.stop(); };
    audio.onerror = fail;
    try {
      await audio.play();
      if (this.audio === audio) this.changed(path);
    } catch { fail(); }
  }
}
