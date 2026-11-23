#pragma once
#include "congestion.hpp"
#include "native-video-pacer.hpp"

struct PeerFeedback {
  std::atomic<unsigned> remb{0}, loss{0}, jitter_ms{0};
  std::atomic<uint64_t> report_count{0}, nack_count{0}, keyframe_count{0};
  std::atomic<bool> closed{false}, connected{false}, send_failed{false};
  std::mutex mutex;
  std::array<std::pair<uint32_t, uint64_t>, 8> sender_reports{};
  size_t next_sender_report = 0;
  std::optional<uint32_t> last_sequence;
  int last_lost = 0;
  uint64_t expected_packets = 0;
  int64_t missing_packets = 0;
  std::optional<VideoFeedback> pending_report;
  uint64_t remb_seen = 0;

  void estimate(unsigned rate) {
    std::lock_guard<std::mutex> lock(mutex);
    remb = rate;
    remb_seen = GetTickCount64();
  }

  void sent_report(uint32_t stamp) {
    std::lock_guard<std::mutex> lock(mutex);
    sender_reports[next_sender_report++ % sender_reports.size()] = {stamp, GetTickCount64()};
  }

  void received_report(const rtc::RtcpReportBlock& block) {
    std::lock_guard<std::mutex> lock(mutex);
    const auto sequence = block.extendedHighestSeqNo();
    if (last_sequence && static_cast<int32_t>(sequence - *last_sequence) <= 0) return;
    const auto raw_lost = static_cast<int>(block.getPacketsLostCount());
    const int cumulative_lost = raw_lost >= 0x800000 ? raw_lost - 0x1000000 : raw_lost;
    if (last_sequence) {
      expected_packets += sequence - *last_sequence;
      missing_packets += cumulative_lost - last_lost;
    }
    last_sequence = sequence;
    last_lost = cumulative_lost;
    ++report_count;
    const auto now = GetTickCount64();
    VideoFeedback sample;
    sample.loss = expected_packets ? static_cast<unsigned>(
        std::clamp(missing_packets * 256 / static_cast<int64_t>(expected_packets), int64_t{0}, int64_t{255})) :
        block.getFractionLost();
    jitter_ms = block.jitter() / 90;
    // Use the complete compact NTP stamp. The pinned accessor shifts away its high 16 bits.
    const auto stamp = ntohl(block._lastReport);
    const auto receiver_delay = (uint64_t(block.delaySinceSR()) * 1000) >> 16;
    for (const auto& [sent_stamp, sent] : sender_reports) {
      if (stamp && stamp == sent_stamp && now >= sent && now - sent <= 5000) {
        sample.rtt_ms = static_cast<unsigned>(now - sent - std::min(now - sent, receiver_delay));
        break;
      }
    }
    if (remb_seen && now - remb_seen < 2500) sample.remb = remb.load();
    if (pending_report && !sample.rtt_ms) sample.rtt_ms = pending_report->rtt_ms;
    pending_report = sample;
  }

  std::optional<VideoFeedback> take() {
    std::lock_guard<std::mutex> lock(mutex);
    if (pending_report) loss = pending_report->loss;
    expected_packets = 0;
    missing_packets = 0;
    return std::exchange(pending_report, std::nullopt);
  }
};

// The wire formats and retransmit cache live in libdatachannel. Only the
// encoder's per-viewer response to receiver feedback is Rajcord-specific.
class ReceiverFeedback : public rtc::MediaHandler {
  std::shared_ptr<PeerFeedback> feedback;
  uint32_t ssrc;

 public:
  ReceiverFeedback(std::shared_ptr<PeerFeedback> state, uint32_t source)
      : feedback(std::move(state)), ssrc(source) {}

  void incoming(rtc::message_vector& messages, const rtc::message_callback&) override {
    for (const auto& message : messages) {
      if (message->type != rtc::Message::Control) continue;
      for (size_t offset = 0; offset + sizeof(rtc::RtcpHeader) <= message->size();) {
        const auto* bytes = message->data() + offset;
        const auto& header = *reinterpret_cast<const rtc::RtcpHeader*>(bytes);
        const auto size = header.lengthInBytes();
        if (header.version() != 2 || size < sizeof(header) || size > message->size() - offset) break;
        const auto reports = header.reportCount();
        if (header.payloadType() == 201 && size >= rtc::RtcpRr::SizeWithReportBlocks(reports)) {
          const auto& report = *reinterpret_cast<const rtc::RtcpRr*>(bytes);
          for (int i = 0; i < reports; ++i) {
            const auto* block = report.getReportBlock(i);
            if (block && block->getSSRC() == ssrc) feedback->received_report(*block);
          }
        } else if (header.payloadType() == 205 && reports == 1 && size >= sizeof(rtc::RtcpFbHeader)) {
          const auto& nack = *reinterpret_cast<const rtc::RtcpFbHeader*>(bytes);
          if (nack.mediaSourceSSRC() == ssrc) ++feedback->nack_count;
        } else if (header.payloadType() == 206 && reports == 4 && size >= rtc::RtcpFir::Size()) {
          const auto& fir = *reinterpret_cast<const rtc::RtcpFir*>(bytes);
          if (ntohl(fir.parts[0].ssrc) == ssrc) {
            ++feedback->keyframe_count;
          }
        }
        offset += size;
      }
    }
  }
};

// Map the sender report to the capture clock used for both media tracks.
class CaptureReporter : public rtc::MediaHandler {
  rtc::RtcpSrReporter upstream;

 public:
  explicit CaptureReporter(const std::shared_ptr<rtc::RtpPacketizationConfig>& config)
      : upstream(config) {}
  uint64_t capture_time = 0;
  std::shared_ptr<PeerFeedback> feedback;

  void outgoing(rtc::message_vector& messages, const rtc::message_callback& send) override {
    upstream.outgoing(messages, [&](rtc::message_ptr report) {
      if (report->size() >= rtc::RtcpSr::Size(0) && capture_time) {
        const auto now = os_gettime_ns();
        const auto wall = std::chrono::system_clock::now().time_since_epoch();
        const auto age = now >= capture_time ? now - capture_time : 0;
        const auto time = std::chrono::duration<double>(wall).count() -
                          std::chrono::duration<double>(std::chrono::nanoseconds(age)).count();
        auto& sender = *reinterpret_cast<rtc::RtcpSr*>(report->data());
        const auto ntp = static_cast<uint64_t>((time + 2208988800.) * 4294967296.);
        sender.setNtpTimestamp(ntp);
        if (feedback) feedback->sent_report(static_cast<uint32_t>(ntp >> 16));
      }
      send(std::move(report));
    });
  }
};

struct MediaTrack {
  std::shared_ptr<rtc::Track> track;
  std::shared_ptr<rtc::RtpPacketizationConfig> config;
  std::shared_ptr<CaptureReporter> report;

  template <typename Packetizer, typename Description>
  void setup(rtc::PeerConnection& peer, Description description, std::shared_ptr<Packetizer> packetizer,
             unsigned history) {
    track = peer.addTrack(std::move(description));
    report = std::make_shared<CaptureReporter>(config);
    packetizer->addToChain(report);
    if (history) packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>(history));
    track->setMediaHandler(packetizer);
  }

  void send(const std::byte* bytes, size_t size, uint64_t time, uint64_t epoch) const {
    constexpr uint64_t second = 1'000'000'000;
    const auto elapsed = std::max(time, epoch) - epoch;
    const auto ticks = elapsed / second * config->clockRate +
                       elapsed % second * config->clockRate / second;
    report->capture_time = time;
    track->sendFrame(bytes, size, rtc::FrameInfo(config->startTimestamp + static_cast<uint32_t>(ticks)));
  }
};

class Peer {
  static constexpr int video_pt = 96, audio_pt = 111;
  std::shared_ptr<PeerFeedback> feedback = std::make_shared<PeerFeedback>();
  std::unique_ptr<rtc::PeerConnection> connection;
  MediaTrack video, audio;
  std::string offered_sdp;
  uint64_t epoch;
  std::atomic<bool> waiting_for_idr{true};
  unsigned applied = 0;
  VideoCongestion congestion;
  std::shared_ptr<VideoPacer> pacer = std::make_shared<VideoPacer>();
  unsigned last_rtt = 0;
  uint64_t feedback_window = 0, prior_nacks = 0, prior_packets = 0, prior_queue_drops = 0;
  uint64_t encoder_ready_by = 0;
  int encoder_fps_limit;
  std::atomic<uint64_t> fresh_frames{0}, stale_frames{0};
  bool local = false, answered = false, first_audio = true;

 public:
  const std::string id;
  Video limits;
  std::atomic<uint64_t> encoded{0};
  std::atomic<uint64_t> encoded_bytes{0};
  FrameGaps encode_gaps;
  ObsEncoder obs;

  Peer(const std::vector<std::string>& command, bool audio_enabled, uint64_t clock, int fps_limit)
      : epoch(clock), encoder_fps_limit(fps_limit), id(command.at(2)), limits(command) {
    rtc::Configuration settings;
    settings.disableAutoNegotiation = true;
    settings.disableAutoGathering = true;
    const bool force_relay = env_enabled("RAJCORD_NATIVE_TEST_RELAY") && command.size() > 7;
    if (force_relay) {
      require(command.size() == 8, "The relay fixture requires one loopback TURN server.");
      settings.iceTransportPolicy = rtc::TransportPolicy::Relay;
      settings.bindAddress = "127.0.0.1";
    }
    for (size_t i = 7; i < command.size(); ++i) {
      auto server = [&] {
        try {
          return rtc::IceServer(decode(command.at(i)));
        } catch (const std::invalid_argument&) {
          throw std::runtime_error("Invalid native ICE endpoint.");
        }
      }();
      if (force_relay)
        require(server.type == rtc::IceServer::Type::Turn && server.hostname == "127.0.0.1" &&
                    server.relayType != rtc::IceServer::RelayType::TurnTls,
                "The relay fixture accepts only loopback TURN sockets.");
      // Electron terminates and verifies TURN/TLS before giving us the loopback TCP endpoint.
      require(server.relayType != rtc::IceServer::RelayType::TurnTls,
              "Secure TURN requires the certificate-verified desktop tunnel.");
      settings.iceServers.push_back(std::move(server));
    }
    connection = std::make_unique<rtc::PeerConnection>(settings);
    connection->onLocalCandidate([link = id, state = feedback](const rtc::Candidate& candidate) {
      if (!state->closed)
        emit("ICE\t" + link + "\t" + (candidate.mid() == "audio" ? "1" : "0") +
             "\t" + encode(candidate.candidate().c_str()));
    });
    connection->onStateChange([link = id, state = feedback](rtc::PeerConnection::State status) {
      if (state->closed) return;
      using State = rtc::PeerConnection::State;
      state->connected = status == State::Connected;
      switch (status) {
        case State::Connecting: emit("STATE\t" + link + "\tconnecting"); break;
        case State::Connected: emit("STATE\t" + link + "\tconnected"); break;
        case State::Disconnected: emit("STATE\t" + link + "\tdisconnected"); break;
        case State::Failed: emit("STATE\t" + link + "\tfailed"); break;
        default: break;
      }
    });
    if (diagnostics)
      connection->onIceStateChange([link = id](rtc::PeerConnection::IceState status) {
        std::fprintf(stderr, "ice link=%s state=%d\n", link.c_str(), static_cast<int>(status));
      });

    const auto ssrc = g_random_int_range(1, G_MAXINT32 - 1);
    rtc::Description::Video picture("video");
    picture.addH264Codec(video_pt);
    auto* profile = picture.rtpMap(video_pt);
    profile->addFeedback("nack");
    profile->addFeedback("nack pli");
    profile->addFeedback("ccm fir");
    profile->addFeedback("goog-remb");
    picture.addSSRC(ssrc, id, id, id + "-video");
    video.config = std::make_shared<rtc::RtpPacketizationConfig>(ssrc, id, video_pt, 90000);
    auto h264 = std::make_shared<rtc::H264RtpPacketizer>(
        rtc::H264RtpPacketizer::Separator::StartSequence, video.config);
    video.setup(*connection, picture, h264, 0);
    video.report->feedback = feedback;
    h264->addToChain(std::make_shared<rtc::PliHandler>([state = feedback] {
      ++state->keyframe_count;
    }));
    h264->addToChain(std::make_shared<rtc::RembHandler>([state = feedback](unsigned rate) { state->estimate(rate); }));
    h264->addToChain(std::make_shared<ReceiverFeedback>(feedback, ssrc));
    h264->addToChain(pacer);
    if (audio_enabled) {
      rtc::Description::Audio sound("audio");
      sound.addOpusCodec(audio_pt);
      sound.rtpMap(audio_pt)->addFeedback("nack");
      sound.addSSRC(ssrc + 1, id, id, id + "-audio");
      audio.config = std::make_shared<rtc::RtpPacketizationConfig>(ssrc + 1, id, audio_pt, 48000);
      audio.setup(*connection, sound, std::make_shared<rtc::OpusRtpPacketizer>(audio.config), 64);
    }
  }

  ~Peer() {
    feedback->closed = true;
    obs.stop();
    if (connection) connection->close();
  }

  std::string offer() {
    require(offered_sdp.empty(), "Native WebRTC link already offered.");
    connection->setLocalDescription(rtc::Description::Type::Offer);
    const auto description = connection->localDescription();
    require(description.has_value(), "Could not generate a native WebRTC offer.");
    offered_sdp = std::string(*description);
    return encode(offered_sdp.c_str());
  }

  void accept_local(const std::string& sdp) {
    require(!local && !offered_sdp.empty() && sdp == offered_sdp, "Native offer changed.");
    local = true;
    connection->gatherLocalCandidates();
  }

  void answer(const std::string& sdp) {
    require(local && !answered, "Unexpected native WebRTC answer.");
    auto description = rtc::Description(sdp, rtc::Description::Type::Answer);
    if (diagnostics) {
      const auto candidates = description.candidates();
      const auto names = std::count_if(candidates.begin(), candidates.end(), [](const rtc::Candidate& candidate) {
        return candidate.candidate().find(".local ") != std::string::npos;
      });
      std::fprintf(stderr, "ice link=%s remote_candidates=%zu mdns_candidates=%zu\n",
                   id.c_str(), candidates.size(), static_cast<size_t>(names));
    }
    connection->setRemoteDescription(std::move(description));
    answered = true;
  }

  void add_candidate(unsigned index, const std::string& candidate) {
    require(answered && (index == 0 || (index == 1 && audio.track)), "Invalid native ICE candidate.");
    if (!candidate.empty())
      connection->addRemoteCandidate(rtc::Candidate(candidate, index ? "audio" : "video"));
  }

  void start_obs(Video settings, const char* exact = nullptr, bool wait_for_packet = true) {
    const auto send_packet = [this](const encoder_packet& packet, const uint8_t* headers, size_t size, uint64_t age) {
      ++encoded;
      encoded_bytes += packet.size + size;
      encode_gaps.frame();
      if (age > 250'000'000) {
        ++stale_frames;
        return;
      }
      ++fresh_frames;
      if (!feedback->connected || !video.track->isOpen()) return;
      if (packet.keyframe) waiting_for_idr = false;
      if (waiting_for_idr) return;
      try {
        const auto time = static_cast<uint64_t>(packet.sys_dts_usec) * 1000;
        const auto* end = packet.data + packet.size;
        const auto* kept = packet.data;
        rtc::binary access_unit;
        const auto append = [&](const uint8_t* first, const uint8_t* last) {
          access_unit.insert(access_unit.end(), reinterpret_cast<const std::byte*>(first),
                             reinterpret_cast<const std::byte*>(last));
        };
        if (size) append(headers, headers + size);
        // Keep encoder rate control and discard its padding before RTP packetization.
        for (auto* nal = obs_avc_find_startcode(kept, end); nal < end;) {
          auto* header = nal;
          while (header < end && !*(header++)) {}
          if (header == end) break;
          const auto* next = obs_avc_find_startcode(header, end);
          if ((*header & 0x1f) == OBS_NAL_FILLER) {
            append(kept, nal);
            kept = next;
          }
          nal = next;
        }
        if (kept == packet.data && !size) {
          video.send(reinterpret_cast<const std::byte*>(packet.data), packet.size, time, epoch);
        } else {
          append(kept, end);
          if (!access_unit.empty()) video.send(access_unit.data(), access_unit.size(), time, epoch);
        }
      } catch (const std::exception&) {
        if (feedback->connected && video.track->isOpen()) feedback->send_failed = true;
      }
    };
    waiting_for_idr = true;
    const auto start = [&](const char* name) {
      return obs.start(name, settings, send_packet, wait_for_packet);
    };
    bool started = false;
    if (std::string_view(obs_choice) == "auto") {
      if (!exact) exact = selected_obs_encoder;
      if (exact) started = start(exact);
      const bool amd = std::string_view(obs_vendor) == "amf";
      for (const auto choice : {amd ? "amf" : "nvenc", amd ? "nvenc" : "amf", "x264"}) {
        if (started) break;
        const auto name = obs_encoder_name(choice);
        if (!exact || std::string_view(exact) != name) started = start(name);
      }
    } else started = start(obs_encoder_name(obs_choice));
    require(started, "OBS could not allocate an H.264 encoder for this viewer. Check publisher encoder capacity.");
    encoder_ready_by = wait_for_packet ? 0 : GetTickCount64() + 1200;
    applied = static_cast<unsigned>(settings.bitrate);
    if (!selected_obs_encoder) selected_obs_encoder = obs.id;
    emit("ENCODER\t" + id + "\t" + obs.id);
  }

  Video delivery_video(Video settings) const {
    if (congestion.format() != VideoCongestion::Format::full) {
      const auto height = congestion.format() == VideoCongestion::Format::compact ? 480. : 720.;
      const auto scale = std::min({1., height * 16. / 9. / settings.width, height / settings.height});
      settings.width = std::max(2, static_cast<int>(settings.width * scale) & ~1);
      settings.height = std::max(2, static_cast<int>(settings.height * scale) & ~1);
      settings.fps = std::min(settings.fps, 30);
    }
    settings.bitrate = std::min(settings.bitrate, static_cast<int>(applied));
    return settings;
  }

  Video active_video(Video settings) const {
    auto active = delivery_video(settings);
    active.fps = std::min(active.fps, encoder_fps_limit);
    return active;
  }

  uint64_t encoder_work() const {
    const auto video = delivery_video(limits);
    return uint64_t(video.width) * video.height * video.fps;
  }

  std::pair<uint64_t, uint64_t> take_encode_freshness() {
    return {fresh_frames.exchange(0), stale_frames.exchange(0)};
  }

  void limit_encoder_fps(int fps) {
    if (fps == encoder_fps_limit) return;
    const auto previous = active_video(limits);
    encoder_fps_limit = fps;
    change_format(previous, active_video(limits), false);
  }

  void change_format(const Video& previous, const Video& next, bool wait_for_packet = true) {
    if (next.width != previous.width || next.height != previous.height || next.fps != previous.fps)
      start_obs(next, obs.id, wait_for_packet);
  }

  void quality(const Video& settings) {
    change_format(active_video(limits), active_video(settings));
    limits = settings;
  }

  void tick(uint64_t now, bool bandwidth_tick) {
    if (!obs.encoder) return;
    if (encoder_ready_by) {
      if (obs.packets) encoder_ready_by = 0;
      else require(now < encoder_ready_by, "The OBS encoder did not resume after a format change.");
    }
    const auto ceiling = static_cast<unsigned>(limits.bitrate);
    if (feedback->connected && pacer->drain(std::min(applied, ceiling))) waiting_for_idr = true;
    if (now >= feedback_window || applied > ceiling) {
      feedback_window = now + 500;
      auto report = feedback->take();
      const auto nacks = feedback->nack_count.load();
      const auto packets = pacer->packets_sent;
      bool repair_pressure = false, recurring_repairs = false;
      if (report) {
        if (report->rtt_ms) last_rtt = *report->rtt_ms;
        // Corroborate repairs with delay growth. Reordering and locally discarded frames
        // also cause NACKs and should not drive a standalone bitrate reduction.
        const auto recently_sent = packets - prior_packets;
        const auto recently_nacked = nacks - prior_nacks;
        recurring_repairs = recently_sent >= 24 && recently_nacked * 8 >= recently_sent;
        repair_pressure = report->rtt_ms && *report->rtt_ms >= congestion.standing_rtt_ms() + 75 &&
            recently_sent >= 32 && recently_nacked * 16 >= recently_sent;
      }
      prior_nacks = nacks;
      prior_packets = packets;
      if (report || applied > ceiling) {
        if (const auto next = congestion.observe(applied, ceiling, now,
            report.value_or(VideoFeedback{6, std::nullopt, 0}), repair_pressure, recurring_repairs)) {
          obs.bitrate(*next / 1000);
          applied = *next;
        }
      }
      const auto previous_format = active_video(limits);
      const auto queue_drops = pacer->dropped_batches;
      if (congestion.update_format(applied, ceiling, now, queue_drops > prior_queue_drops))
        change_format(previous_format, active_video(limits), false);
      prior_queue_drops = queue_drops;
    }
    if (diagnostics && bandwidth_tick) {
      std::fprintf(stderr,
          "congestion link=%s bitrate=%u remb=%u loss=%u jitter_ms=%u rtt_ms=%u standing_rtt_ms=%u reports=%llu nack=%llu keyframes=%llu encoded_bytes=%llu sent_bytes=%llu queue_ms=%u discarded=%llu repairs=%llu\n",
          id.c_str(), applied, feedback->remb.load(), feedback->loss.load(), feedback->jitter_ms.load(), last_rtt,
          congestion.standing_rtt_ms(), static_cast<unsigned long long>(feedback->report_count.load()),
          static_cast<unsigned long long>(feedback->nack_count.load()),
          static_cast<unsigned long long>(feedback->keyframe_count.load()),
          static_cast<unsigned long long>(encoded_bytes.load()),
          static_cast<unsigned long long>(pacer->bytes_sent), pacer->max_age_ms,
          static_cast<unsigned long long>(pacer->dropped_batches),
          static_cast<unsigned long long>(pacer->repairs_sent));
      pacer->max_age_ms = 0;
    }
  }

  void send_audio(const NativeOpus::Packet& packet, uint64_t now) {
    if (!audio.track || !feedback->connected || !audio.track->isOpen() ||
        now < packet.time || now - packet.time >= 60'000'000) return;
    try {
      audio.send(packet.payload.data(), packet.size, packet.time, epoch);
      if (diagnostics && first_audio)
        std::fprintf(stderr, "timing audio/rtp link=%s age=%.3f\n", id.c_str(), (now - packet.time) / 1e6);
      first_audio = false;
    } catch (const std::exception&) {
      if (feedback->connected && audio.track->isOpen()) feedback->send_failed = true;
    }
  }

  bool failed() const { return feedback->send_failed; }
};
