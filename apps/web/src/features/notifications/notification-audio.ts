export class NotificationAudio {
  private context: AudioContext | undefined;
  async unlock() {
    if (typeof AudioContext === 'undefined')
      throw new Error('Notification sound is unavailable in this browser.');
    this.context ??= new AudioContext();
    await this.context.resume();
    if (this.context.state !== 'running')
      throw new Error('Sound is blocked. Use “Enable / test sound” to allow audio.');
  }
  play(volume: number) {
    const context = this.context;
    if (!context || context.state !== 'running')
      throw new Error('Sound is paused by your browser. Use “Enable / test sound” to recover.');
    if (volume === 0) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 660;
    const end = context.currentTime + 0.15;
    gain.gain.setValueAtTime(Math.min(1, Math.max(0, volume)) * 0.15, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, end);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start();
    oscillator.stop(end);
  }
  close() {
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
}
