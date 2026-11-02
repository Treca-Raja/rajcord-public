import type { ScreenPreviewOwner } from './screen-preview';
import type { VoiceState } from './voice-controller';

// Trusted code injection only. No application factory or authorization adapter is supplied.
export type CallPreviewDependency = Readonly<{
  // Register idempotent cleanup immediately for resources allocated before returning an owner.
  create(own: (dispose: () => void) => void): ScreenPreviewOwner;
  onError(error: unknown): void;
}>;

export class CallPreviewLifetime {
  private preview?: ScreenPreviewOwner;
  private cleanups: (() => void)[] = [];
  private disposed = false;
  private voiceActive = false;

  constructor(private readonly dependency?: CallPreviewDependency) {
    if (!dependency) return;
    let constructing = true;
    try {
      this.preview = dependency.create((dispose) => {
        if (!constructing)
          throw new Error('Preview resources must be registered during construction.');
        this.cleanups.push(dispose);
      });
    } catch (error) {
      this.clean(this.cleanups.splice(0).reverse(), [error]);
    } finally {
      constructing = false;
    }
  }

  private clean(work: (() => void)[], errors: unknown[] = []) {
    for (const cleanup of work) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      const error = new AggregateError(
        errors,
        'Local call preview is unavailable or cleanup failed.',
      );
      try {
        this.dependency!.onError(error);
      } catch (reportingError) {
        globalThis.reportError(reportingError);
      }
    }
  }

  stop() {
    if (!this.disposed && this.preview) this.clean([() => this.preview!.stop()]);
  }

  observeVoice(state: Pick<VoiceState, 'status' | 'channelId'>) {
    if (this.disposed) return;
    const active = state.status !== 'idle' || state.channelId !== null;
    const ended = this.voiceActive && !active;
    this.voiceActive = active;
    // This is only a revocation hint. Public voice state cannot authorize a preview.
    if (ended) this.stop();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const preview = this.preview;
    this.preview = undefined;
    this.clean([
      ...(preview ? [() => preview.dispose()] : []),
      ...this.cleanups.splice(0).reverse(),
    ]);
  }
}
