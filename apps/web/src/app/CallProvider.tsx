import { CallContext, type Call } from '../shared/call';
import type { VoiceControls, VoiceDevice, VoiceSnapshot } from '../features/voice/contracts';
export { useCall } from '../shared/call';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { joinDevices } from '../features/voice/composition';
import { CallPreviewLifetime, type CallPreviewDependency } from './call-preview';
import { VoiceController, concreteDevices } from '../features/voice/composition';
import type { ApprovedVoiceSession } from '../features/voice/contracts';
import type { ScreenRuntime, ScreenApplication } from '../features/screen-sharing/contracts';

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
  const [permissionReset, setPermissionReset] = useState<{ session: ApprovedVoiceSession } | null>(
    null,
  );
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
    if (permissionReset?.session === session)
      controller.update({
        devicesStatus: 'permission-needed',
        devicesError: 'Microphone permission reset. Allow microphone access to set up voice again.',
      });
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
    let deviceSource = controller.state.devices;
    let devices: readonly VoiceDevice[] = Object.freeze([]);
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
    const preferenceKey = 'rajcord.voice.devices';
    if (permissionReset?.session === session) localStorage.removeItem(preferenceKey);
    const saved = localStorage.getItem(preferenceKey);
    if (saved) {
      try {
        const value: unknown = JSON.parse(saved);
        if (
          value &&
          typeof value === 'object' &&
          'input' in value &&
          'output' in value &&
          typeof value.input === 'string' &&
          typeof value.output === 'string'
        )
          controller.update({ input: value.input, output: value.output });
      } catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        localStorage.removeItem(preferenceKey);
      }
    }
    const saveDevices = () =>
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({
          input: controller.state.input,
          output: controller.state.output,
        }),
      );
    const discover = async () => {
      await controller.devices();
      check();
      if (controller.state.devicesStatus !== 'ready')
        throw new Error(controller.state.devicesError || 'Audio device discovery failed.');
      return controller.state.devices;
    };
    let joining = false;
    let joinGeneration = 0;
    const leaveCall = () => {
      localPreview.stop();
      cleanScreens([
        () => screenCall?.stopSource(),
        () => screenCall?.stopWatching(),
        () => screenAttachment?.stop(),
      ]);
      return controller.leave();
    };
    const controls: VoiceControls = {
      refreshDevices: () => invoke(() => controller.refreshDevices()),
      setOutputVolume: (value) => invoke(() => controller.setOutputVolume(value)),
      devices: () => invoke(() => controller.devices()),
      selectInput: (id) =>
        invoke(async () => {
          await controller.selectInput(id);
          check();
          saveDevices();
        }),
      selectOutput: (id) =>
        invoke(async () => {
          await controller.selectOutput(id);
          check();
          saveDevices();
        }),
      join: (id) => invoke(() => controller.join(id)),
      joinChannel: (id) =>
        invoke(async () => {
          if (joining) throw new Error('A voice channel change is already in progress.');
          if (controller.state.channelId === id && controller.state.status !== 'idle') return;
          joining = true;
          const attempt = ++joinGeneration;
          const checkJoin = () => {
            check();
            if (attempt !== joinGeneration) throw new Error('Voice channel change cancelled.');
          };
          try {
            const selected = joinDevices(await discover(), controller.state);
            checkJoin();
            if (controller.state.status !== 'idle') await leaveCall();
            checkJoin();
            await controller.selectInput(selected.input);
            checkJoin();
            await controller.selectOutput(selected.output);
            checkJoin();
            saveDevices();
            await controller.join(id);
            checkJoin();
            if (controller.state.channelId !== id || controller.state.status === 'idle')
              throw new Error(controller.state.error || 'Could not join the voice channel.');
          } finally {
            joining = false;
          }
        }),
      leave: () =>
        invoke(() => {
          joinGeneration++;
          cleanScreens([() => screenCall?.controls().close()]);
          return leaveCall();
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
        devices,
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
        if (deviceSource !== controller.state.devices) {
          deviceSource = controller.state.devices;
          devices = Object.freeze(
            [
              ...concreteDevices(deviceSource, 'audioinput'),
              ...concreteDevices(deviceSource, 'audiooutput'),
            ].map(({ kind, deviceId, label }) => Object.freeze({ kind, deviceId, label })),
          );
        }
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
            devices: voice.devices,
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
    const unsubscribePermission = window.tricordDesktop?.onMicrophonePermissionReset?.(() => {
      if (!active || !session.current) return;
      stop();
      setPermissionReset({ session });
    });
    publish();
    return () => {
      unsubscribe();
      unsubscribePermission?.();
      stop();
    };
  }, [session, permissionReset]);
  return (
    <CallContext.Provider
      value={session?.current && owned?.session === session ? owned.call : null}
    >
      {children}
    </CallContext.Provider>
  );
}
