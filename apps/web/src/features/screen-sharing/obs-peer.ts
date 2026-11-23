import { parseScreenDescription, parseScreenIce } from '@tricord/shared';
import type {
  DesktopScreenBridge,
  NativeScreenOperation,
  NativeScreenVideo,
  ObsEncoder,
  ScreenDescription,
} from '@tricord/shared';
import type { ScreenRtcPeer, ScreenRtcTransceiver } from './screen-peer';

// OBS composes the selected window or display onto a 1080p60 canvas independently of its preview.
export const obsVideoSource = Object.freeze({ width: 1920, height: 1080, frameRate: 60 });

export class ObsPeer extends EventTarget implements ScreenRtcPeer {
  connectionState: RTCPeerConnectionState = 'new';
  private transceiver?: ScreenRtcTransceiver;
  private audio?: ScreenRtcTransceiver;
  private description?: ScreenDescription;
  private video?: NativeScreenVideo;
  private offeredVideo?: NativeScreenVideo;
  private opening = false;
  private remote = false;
  private removeEvents;
  private readonly invoke: DesktopScreenBridge['nativeCommand'];

  constructor(
    bridge: Pick<DesktopScreenBridge, 'nativeCommand' | 'onNativeEvent'>,
    private configuration: RTCConfiguration,
    private tag: string,
    private linkId: string,
    private deadline: () => number,
    onEncoder?: (encoder: ObsEncoder) => void,
  ) {
    super();
    if (!bridge.nativeCommand || !bridge.onNativeEvent)
      throw new Error('Update Rajcord Desktop to share your screen with OBS.');
    this.invoke = bridge.nativeCommand;
    this.removeEvents = bridge.onNativeEvent((message) => {
      if (message.tag !== tag || message.linkId !== linkId || this.connectionState === 'closed')
        return;
      if ('encoder' in message) onEncoder?.(message.encoder);
      else if ('state' in message) {
        this.connectionState = message.state;
        this.dispatchEvent(new Event('connectionstatechange'));
      } else if (this.description) {
        const candidate = parseScreenIce({
          candidate: message.ice,
          sdpMLineIndex: message.index,
          sdpMid: this.description.mids[message.index],
          usernameFragment: this.description.ufrags[message.index],
        });
        this.dispatchEvent(
          new RTCPeerConnectionIceEvent('icecandidate', {
            candidate: new RTCIceCandidate(candidate),
          }),
        );
      }
    });
  }

  private command(command: NativeScreenOperation) {
    return this.invoke({ ...command, tag: this.tag, linkId: this.linkId });
  }

  addTransceiver(track: MediaStreamTrack, init: RTCRtpTransceiverInit) {
    if (
      track.kind === 'audio' &&
      this.transceiver &&
      !this.audio &&
      init.direction === 'sendonly'
    ) {
      this.audio = {
        direction: 'sendonly',
        sender: {
          track,
          getParameters: () => ({
            transactionId: '',
            codecs: [],
            headerExtensions: [],
            rtcp: {},
            encodings: [{}],
          }),
          setParameters: async () => {
            throw new Error('Native Opus audio uses fixed encoding settings.');
          },
        },
      };
      return this.audio;
    }
    if (track.kind !== 'video' || this.transceiver || init.direction !== 'sendonly')
      throw new Error('Invalid native screen transceiver.');
    let params: RTCRtpSendParameters = {
      transactionId: '',
      codecs: [],
      headerExtensions: [],
      rtcp: {},
      encodings: structuredClone(init.sendEncodings ?? [{}]),
    };
    this.transceiver = {
      direction: 'sendonly',
      sender: {
        track,
        getParameters: () => structuredClone(params),
        setParameters: async (next) => {
          const encoding = next.encodings[0];
          const scale = encoding?.scaleResolutionDownBy ?? 1;
          const video = {
            width: Math.max(160, Math.floor(obsVideoSource.width / scale / 2) * 2),
            height: Math.max(64, Math.floor(obsVideoSource.height / scale / 2) * 2),
            fps: Math.floor(encoding?.maxFramerate ?? 60),
            bitrate: encoding?.maxBitrate ?? 8000000,
          };
          if (this.remote && JSON.stringify(this.video) !== JSON.stringify(video))
            await this.command({ op: 'quality', video });
          this.video = video;
          params = structuredClone(next);
        },
      },
    };
    return this.transceiver;
  }

  getTransceivers() {
    return this.transceiver ? [this.transceiver, ...(this.audio ? [this.audio] : [])] : [];
  }

  getConfiguration() {
    return structuredClone(this.configuration);
  }

  setConfiguration(configuration: RTCConfiguration) {
    this.configuration = structuredClone(configuration);
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    if (!this.video || this.connectionState === 'closed')
      throw new Error('The native video limits or source are unavailable.');
    this.remote = false;
    this.description = undefined;
    this.opening = true;
    this.offeredVideo = this.video;
    const sdp = await this.command({
      op: options?.iceRestart ? 'restart' : 'open',
      deadline: this.deadline(),
      video: this.video,
    });
    this.description = parseScreenDescription(sdp, 'offer');
    return { type: 'offer', sdp };
  }

  async setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
    if (description?.type !== 'offer' || !description.sdp)
      throw new Error('Expected a native WebRTC offer.');
    await this.command({ op: 'local', sdp: description.sdp });
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.reject(new Error('The OBS helper only publishes screen media.'));
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (description.type !== 'answer' || !description.sdp)
      throw new Error('Expected a browser WebRTC answer.');
    await this.command({ op: 'answer', sdp: description.sdp });
    this.remote = true;
    if (this.video && JSON.stringify(this.offeredVideo) !== JSON.stringify(this.video))
      await this.command({ op: 'quality', video: this.video });
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit | null) {
    await this.command({ op: 'ice', candidate: parseScreenIce(candidate) });
  }

  async renew(deadline: number) {
    if (this.opening && this.connectionState !== 'closed')
      await this.command({ op: 'lease', deadline });
  }

  close() {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    this.removeEvents();
    if (this.opening)
      // The main process also expires the viewer independently of renderer execution.
      void this.command({ op: 'close' }).catch(() => {});
  }
}
