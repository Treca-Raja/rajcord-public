import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CallPreviewLifetime, type CallPreviewDependency } from './call-preview';
import { VoiceController, concreteDevices, type VoiceState } from './voice-controller';
import type { ApprovedVoiceSession } from './voice-session';
import type { ScreenRuntime } from './screen-runtime';
import type { ScreenApplication } from './screen-application';
import type { ScreenControls } from './screen-call';

export type VoiceControls = Pick<
  VoiceController,
  'selectInput' | 'selectOutput' | 'join' | 'leave' | 'mute' | 'deafen' | 'resumeAudio' | 'volume'
> & { devices(): Promise<void> };
export type VoiceDevice = Readonly<Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>>;
type VoiceSnapshot = Readonly<Omit<VoiceState, 'participants'>> & {
  participants: readonly Readonly<VoiceState['participants'][number]>[];
};
type Call = Readonly<{
  voice: VoiceSnapshot;
  devices: readonly VoiceDevice[];
  controls: VoiceControls;
  subscribeVoice(listener: (voice: VoiceSnapshot) => void): () => void;
  screens?: ScreenControls;
}>;
const CallContext = createContext<Call | null>(null);

export function useCall() {
  return useContext(CallContext);
}

export function CallProvider({
  session,
  children,
  preview,
  screens,
  screenApplication,
}: {
  session: ApprovedVoiceSession | null;
  children: ReactNode;
  preview?: CallPreviewDependency;
  screens?: ScreenRuntime;
  screenApplication?: ScreenApplication;
}) {
  const [owned, setOwned] = useState<{ session: ApprovedVoiceSession; call: Call } | null>(null);
  // A dependency change applies to the next verified lifetime, never restarts a current call.
  const nextPreview = useRef(preview);
  nextPreview.current = preview;
  const nextScreens = useRef(screens);
  nextScreens.current = screens;
  const nextApplication = useRef(screenApplication);
  nextApplication.current = screenApplication;
  useEffect(() => {
    if (!session?.current) return;
    const application = nextApplication.current;
    const screenAttachment = (nextScreens.current ?? application?.runtime)?.attachCall(session);
    const controller = new VoiceController(session.request, screenAttachment?.bindingDependency);
    screenAttachment?.connectVoice(controller);
    const screenCall = screenAttachment && application?.createCall(screenAttachment, controller);
    const screenControls = screenCall?.controls();
    const cleanScreens = (work: (() => void)[]) => {
      const errors: unknown[] = [];
      for (const cleanup of work) {
        try {
          cleanup();
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (errors.length)
        queueMicrotask(() =>
          globalThis.reportError(new AggregateError(errors, 'Screen cleanup failed.')),
        );
    };
    const localPreview = new CallPreviewLifetime(nextPreview.current);
    const unsubscribeLease = controller.onLeaseInvalidated(() => localPreview.stop());
    let active = true;
    let devices: readonly VoiceDevice[] = Object.freeze([]);
    let discovery = 0;
    const pending = new Set<() => void>();
    const voiceListeners = new Set<(voice: VoiceSnapshot) => void>();
    const check = () => {
      if (!active || !session.current) throw new Error('Voice session ended.');
    };
    const invoke = <T,>(work: () => Promise<T>): Promise<T> => {
      check();
      const raw = work();
      return new Promise<T>((resolve, reject) => {
        const cancel = () => reject(new Error('Voice session ended.'));
        pending.add(cancel);
        if (!active || !session.current) {
          pending.delete(cancel);
          cancel();
        }
        raw.then(
          (value) => {
            pending.delete(cancel);
            if (active && session.current) resolve(value);
            else cancel();
          },
          (error: unknown) => {
            pending.delete(cancel);
            reject(error);
          },
        );
      });
    };
    const controls: VoiceControls = {
      devices: () =>
        invoke(async () => {
          const revision = ++discovery;
          const found = await controller.devices();
          check();
          const catalog = Object.freeze(
            [...concreteDevices(found, 'audioinput'), ...concreteDevices(found, 'audiooutput')].map(
              ({ kind, deviceId, label }) => Object.freeze({ kind, deviceId, label }),
            ),
          );
          check();
          if (revision !== discovery) return;
          devices = catalog;
          publish();
        }),
      selectInput: (id) => invoke(() => controller.selectInput(id)),
      selectOutput: (id) => invoke(() => controller.selectOutput(id)),
      join: (id) => invoke(() => controller.join(id)),
      leave: () =>
        invoke(() => {
          localPreview.stop();
          cleanScreens([
            () => screenCall?.stopSource(),
            () => screenCall?.stopWatching(),
            () => screenAttachment?.stop(),
          ]);
          return controller.leave();
        }),
      mute: () => invoke(() => controller.mute()),
      deafen: () => invoke(() => controller.deafen()),
      resumeAudio: () => invoke(() => controller.resumeAudio()),
      volume: (id, value) => {
        check();
        controller.volume(id, value);
      },
    };
    const snapshot = (): VoiceSnapshot =>
      Object.freeze({
        ...controller.state,
        participants: Object.freeze(
          controller.state.participants.map((participant) => Object.freeze({ ...participant })),
        ),
      });
    const subscribeVoice = (listener: (voice: VoiceSnapshot) => void) => {
      if (!active || !session.current) return () => {};
      voiceListeners.add(listener);
      try {
        listener(snapshot());
      } catch (cause) {
        voiceListeners.delete(listener);
        throw cause;
      }
      return () => {
        voiceListeners.delete(listener);
      };
    };
    const publish = () => {
      if (active && session.current) {
        localPreview.observeVoice(controller.state);
        screenCall?.observeVoice(controller.state);
        const voice = snapshot();
        // Sound/lifecycle consumers must see transitions React may batch into one render.
        for (const listener of [...voiceListeners]) {
          try {
            listener(voice);
          } catch (cause) {
            queueMicrotask(() => globalThis.reportError(cause));
          }
        }
        setOwned({
          session,
          call: Object.freeze({
            voice,
            devices,
            controls,
            subscribeVoice,
            ...(screenControls ? { screens: screenControls } : {}),
          }),
        });
      }
    };
    controller.onChange = publish;
    const stop = () => {
      if (!active) return;
      active = false;
      voiceListeners.clear();
      devices = Object.freeze([]);
      discovery++;
      cleanScreens([() => screenCall?.dispose(), () => screenAttachment?.release()]);
      unsubscribeLease();
      try {
        localPreview.dispose();
      } finally {
        try {
          controller.dispose();
        } finally {
          pending.forEach((cancel) => cancel());
          pending.clear();
          setOwned((previous) => (previous?.session === session ? null : previous));
        }
      }
    };
    const unsubscribe = session.onEnd(stop);
    publish();
    return () => {
      unsubscribe();
      stop();
    };
  }, [session]);
  return (
    <CallContext.Provider
      value={session?.current && owned?.session === session ? owned.call : null}
    >
      {children}
    </CallContext.Provider>
  );
}
