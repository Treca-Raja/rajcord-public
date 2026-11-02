import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CallPreviewLifetime, type CallPreviewDependency } from './call-preview';
import { VoiceController, concreteDevices, type VoiceState } from './voice-controller';
import type { ApprovedVoiceSession } from './voice-session';

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
}>;
const CallContext = createContext<Call | null>(null);

export function useCall() {
  return useContext(CallContext);
}

export function CallProvider({
  session,
  children,
  preview,
}: {
  session: ApprovedVoiceSession | null;
  children: ReactNode;
  preview?: CallPreviewDependency;
}) {
  const [owned, setOwned] = useState<{ session: ApprovedVoiceSession; call: Call } | null>(null);
  // A dependency change applies to the next verified lifetime, never restarts a current call.
  const nextPreview = useRef(preview);
  nextPreview.current = preview;
  useEffect(() => {
    if (!session?.current) return;
    const controller = new VoiceController(session.request);
    const localPreview = new CallPreviewLifetime(nextPreview.current);
    const unsubscribeLease = controller.onLeaseInvalidated(() => localPreview.stop());
    let active = true;
    let devices: readonly VoiceDevice[] = Object.freeze([]);
    let discovery = 0;
    const pending = new Set<() => void>();
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
    const publish = () => {
      if (active && session.current) {
        localPreview.observeVoice(controller.state);
        const voice = Object.freeze({
          ...controller.state,
          participants: Object.freeze(
            controller.state.participants.map((participant) => Object.freeze({ ...participant })),
          ),
        });
        setOwned({ session, call: Object.freeze({ voice, devices, controls }) });
      }
    };
    controller.onChange = publish;
    const stop = () => {
      if (!active) return;
      active = false;
      devices = Object.freeze([]);
      discovery++;
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
