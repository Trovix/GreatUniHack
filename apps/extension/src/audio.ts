export type AudioKind = 'explanation' | 'source' | 'answer';
export type AudioState = {key?: string; kind?: AudioKind; loading: boolean; playing: boolean; offset: number; duration: number; rate: number; error?: string};
export type AudioRequest = {key: string; kind: AudioKind; blob: (signal: AbortSignal) => Promise<Blob>; stopAt?: number};

/** One lazily created element owns source, adaptation and answer audio. Loading never implies autoplay. */
export class AudioOwner {
  private audio?: HTMLAudioElement;
  private state: AudioState = {loading: false, playing: false, offset: 0, duration: 0, rate: 1};
  private generation = 0;
  private abort?: AbortController;
  private url?: string;
  private stopAt?: number;
  private listeners = new Set<(state: AudioState) => void>();
  private ended: (state: AudioState) => void = () => {};
  private failed: (error: Error) => void = () => {};
  constructor(private factory: () => HTMLAudioElement = () => new Audio()) {}
  snapshot(): AudioState { return {...this.state}; }
  subscribe(listener: (state: AudioState) => void): () => void { this.listeners.add(listener); listener(this.snapshot()); return () => { this.listeners.delete(listener); }; }
  onEnded(callback: (state: AudioState) => void): void { this.ended = callback; }
  onError(callback: (error: Error) => void): void { this.failed = callback; }
  private update(value: Partial<AudioState>): void { this.state = {...this.state, ...value}; for (const listener of this.listeners) listener(this.snapshot()); }
  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = this.factory(); this.audio = audio; audio.preload = 'metadata';
    audio.onplay = () => { if (!this.state.loading && this.url) this.update({playing: true}); };
    audio.onpause = () => this.update({playing: false});
    audio.ontimeupdate = () => {
      if (this.state.loading || !this.url) return;
      if (this.stopAt !== undefined && audio.currentTime >= this.stopAt) { audio.pause(); audio.currentTime = this.stopAt; }
      this.update({offset: audio.currentTime});
    };
    audio.onended = () => {
      if (!this.url || this.state.loading) return;
      this.update({playing: false, offset: audio.currentTime}); this.ended(this.snapshot());
    };
    audio.onerror = () => {
      if (!this.url || this.state.loading) return;
      const error = new Error('This audio could not be decoded. The descriptive transcript remains available.');
      this.update({playing: false, error: error.message}); this.failed(error);
    };
    return audio;
  }
  /** Called only after a user playback action, or continuation of that explicitly started playback. */
  async start(request: AudioRequest, offset = 0): Promise<void> {
    if (!Number.isFinite(offset) || offset < 0) throw new Error('Choose a valid audio position.');
    const audio = this.element();
    if (this.url && !this.state.loading && this.state.key === request.key && this.state.kind === request.kind) {
      this.stopAt = request.stopAt; this.seek(offset); audio.playbackRate = this.state.rate;
      try { await audio.play(); this.update({playing: !audio.paused, error: undefined}); }
      catch { throw new Error('Playback was blocked. Press Play to try again.'); }
      return;
    }
    const generation = ++this.generation;
    this.abort?.abort(); audio.pause(); this.release();
    const controller = new AbortController(); this.abort = controller; this.stopAt = request.stopAt;
    this.update({key: request.key, kind: request.kind, loading: true, playing: false, offset, duration: 0, error: undefined});
    try {
      const blob = await request.blob(controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      if (!blob.size) throw new Error('The selected audio file is empty.');
      this.url = URL.createObjectURL(blob); audio.src = this.url; audio.playbackRate = this.state.rate;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); controller.signal.removeEventListener('abort', aborted); };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Audio metadata could not be read. The transcript remains available.')); };
        const aborted = () => { cleanup(); reject(new DOMException('Playback cancelled', 'AbortError')); };
        const timer = setTimeout(failed, 10_000);
        audio.addEventListener('loadedmetadata', loaded, {once: true}); audio.addEventListener('error', failed, {once: true}); controller.signal.addEventListener('abort', aborted, {once: true});
        if (controller.signal.aborted) aborted(); else audio.load();
      });
      if (generation !== this.generation || controller.signal.aborted) return;
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error('This audio has no readable duration.');
      audio.currentTime = Math.max(0, Math.min(offset, this.stopAt ?? audio.duration, audio.duration));
      this.update({loading: false, duration: audio.duration, offset: audio.currentTime});
      await audio.play();
      if (generation === this.generation) this.update({playing: !audio.paused});
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      audio.pause(); this.release();
      this.update({loading: false, playing: false, error: error instanceof Error ? error.message : 'Audio could not start.'});
      throw error;
    }
  }
  pause(): void {
    ++this.generation;
    if (this.state.loading) { this.abort?.abort(); this.release(); }
    this.audio?.pause();
    this.update({loading: false, playing: false, offset: this.url ? this.audio?.currentTime ?? this.state.offset : this.state.offset});
  }
  seek(offset: number): void {
    if (!this.audio || !this.url || !Number.isFinite(offset)) return;
    this.audio.currentTime = Math.max(0, Math.min(offset, this.stopAt ?? this.audio.duration, this.audio.duration));
    this.update({offset: this.audio.currentTime});
  }
  rate(value: number): void {
    if (!Number.isFinite(value)) return;
    const rate = Math.min(2, Math.max(.75, value));
    if (this.audio) this.audio.playbackRate = rate;
    this.update({rate});
  }
  stop(): void {
    ++this.generation; this.abort?.abort(); this.audio?.pause(); this.release();
    this.stopAt = undefined;
    this.update({key: undefined, kind: undefined, loading: false, playing: false, offset: 0, duration: 0, error: undefined});
  }
  private release(): void {
    if (this.audio) { this.audio.removeAttribute('src'); this.audio.load(); }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
  }
  dispose(): void { this.stop(); this.listeners.clear(); this.ended = () => {}; this.failed = () => {}; }
}
