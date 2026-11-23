#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <tlhelp32.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <winsvc.h>
#include <ks.h>
#include <ksmedia.h>
#include <psapi.h>

#include <atomic>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <cstddef>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <thread>
#include <type_traits>
#include <vector>

#include <glib.h>
#include <opus/opus.h>
#include <rtc/rtc.hpp>
#include <rtc/rtp.hpp>
#include <obs.h>
#include <obs-avc.h>
#include <util/platform.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <string_view>
#include <cstring>

namespace {
constexpr size_t max_line = 20000;
std::mutex output_mutex;
bool diagnostics = false;

#include "sender-common.hpp"
#include "process-loopback.hpp"
#include "obs-sender.hpp"
#include "native-opus.hpp"
#include "native-rtc.hpp"

void initialize_transport() {
  // The library's free-form logs can include endpoint addresses and signaling.
  rtc::InitLogger(rtc::LogLevel::None);
}

class Sender {
  std::unique_ptr<Source> source;
  std::unique_ptr<NativeOpus> opus;
  ProcessLoopback audio;
  std::map<std::string, std::unique_ptr<Peer>> peers;
  std::atomic<uint64_t> captured{0};
  FrameGaps capture_gaps;
  ObsCapture obs_capture;
  uint64_t clock_epoch = 0;
  uint64_t bitrate_check = 0;
  EncoderCadence encoder_cadence;
  std::string starting;
  uint64_t source_check = 0;
  uint64_t sample_time = 0;

  void start(const std::vector<std::string>& command) {
    require(!source, "Capture has already started.");
    source = std::make_unique<Source>(command);
    audio.bind(*source, command);
    if (diagnostics) wasapi_check("source-authorized", S_OK);
    obs_capture.start(source.get(), captured, capture_gaps);
    if (diagnostics) wasapi_check("obs-ready", S_OK);
    ObsEncoder::register_output();
    clock_epoch = os_gettime_ns();
    if (audio.enabled()) {
      opus = std::make_unique<NativeOpus>();
      audio.start([this](const float* pcm, unsigned frames, uint64_t pts, bool discontinuity) {
        opus->samples(pcm, frames, pts, discontinuity);
        return true;
      });
    }
    starting = command.at(0);
  }

  void open(const std::vector<std::string>& command) {
    const auto& id = command.at(2);
    auto peer = std::make_unique<Peer>(command, audio.enabled(), clock_epoch, encoder_cadence.limit());
    auto initial = peer->limits;
    initial.bitrate = static_cast<int>(VideoCongestion::initial(initial.bitrate));
    initial.fps = std::min(initial.fps, encoder_cadence.limit());
    peer->start_obs(initial);
    peers.emplace(id, std::move(peer));
  }

  void close(const std::string& id) { peers.erase(id); }

 public:
  ~Sender() {
    audio.stop();
    peers.clear();
  }

  void poll() {
    if (const auto reason = obs_capture.failure.load()) throw SourceFailure(reason);
    const auto now = GetTickCount64();
    if (source && now >= source_check) {
      source_check = now + 200;
      require(source->valid(), "The selected native screen source ended.");
      if (const auto failure = audio.failure(); !failure.empty()) throw SourceFailure(failure);
      require(audio.valid(), "The selected audio source ended. Choose the source again to restart sharing.");
    }
    if (!starting.empty() && captured > 0 && audio.ready()) {
      if (diagnostics) {
        wasapi_check("capture-ready", S_OK);
        PROCESS_MEMORY_COUNTERS memory{};
        if (K32GetProcessMemoryInfo(GetCurrentProcess(), &memory, sizeof(memory)))
          std::fprintf(stderr, "native_working_set_bytes=%llu\n",
                       static_cast<unsigned long long>(memory.WorkingSetSize));
      }
      emit("OK\t" + starting + "\t" + encode(obs_capture.game_capture ? "Game Capture" : "WGC"));
      starting.clear();
    }
    if (opus) {
      const auto timestamp = os_gettime_ns();
      for (const auto& packet : opus->drain())
        for (auto& [id, peer] : peers) peer->send_audio(packet, timestamp);
    }
    const bool bandwidth_tick = now >= bitrate_check;
    if (bandwidth_tick) {
      bitrate_check = now + 1000;
      uint64_t fresh = 0, late = 0, work = 0;
      for (const auto& [id, peer] : peers) {
        const auto [current, stale] = peer->take_encode_freshness();
        fresh += current;
        late += stale;
        work += peer->encoder_work();
      }
      encoder_cadence.observe(now, fresh, late, work);
      if (diagnostics)
        std::fprintf(stderr, "encoder_cadence_ms=%llu fps_limit=%d fresh=%llu stale=%llu\n",
                     static_cast<unsigned long long>(now), encoder_cadence.limit(),
                     static_cast<unsigned long long>(fresh), static_cast<unsigned long long>(late));
    }
    for (auto viewer = peers.begin(); viewer != peers.end();) {
      try {
        if (viewer->second->failed()) throw std::runtime_error("Media transport failed.");
        viewer->second->limit_encoder_fps(encoder_cadence.limit());
        viewer->second->tick(now, bandwidth_tick);
        ++viewer;
      } catch (const std::exception& error) {
        if (diagnostics) std::fprintf(stderr, "native viewer media: %s\n", error.what());
        const auto failed_id = viewer->first;
        viewer = peers.erase(viewer);
        emit("STATE\t" + failed_id + "\tfailed");
      }
    }
    if (source && diagnostics && now >= sample_time) {
      sample_time = now + 1000;
      PROCESS_MEMORY_COUNTERS memory{};
      DWORD handles = 0;
      FILETIME created{}, exited{}, kernel{}, user{};
      const auto process = GetCurrentProcess();
      if (K32GetProcessMemoryInfo(process, &memory, sizeof(memory)) &&
          GetProcessHandleCount(process, &handles) &&
          GetProcessTimes(process, &created, &exited, &kernel, &user)) {
        const auto ticks = [](FILETIME time) {
          return (uint64_t{time.dwHighDateTime} << 32) | time.dwLowDateTime;
        };
        std::fprintf(stderr, "resources_ms=%llu peers=%zu working_set_bytes=%zu handles=%lu cpu_us=%llu\n",
                     static_cast<unsigned long long>(now), peers.size(), memory.WorkingSetSize, handles,
                     static_cast<unsigned long long>((ticks(kernel) + ticks(user)) / 10));
      }
      const auto capture = capture_gaps.interval();
      std::fprintf(stderr, "capture_ms=%llu captured=%llu capture_p95_ms=%.2f capture_p99_ms=%.2f\n",
                   static_cast<unsigned long long>(now), static_cast<unsigned long long>(captured.load()),
                   capture.first, capture.second);
      if (obs_capture.capture_stats)
        std::fprintf(stderr, "wgc_ms=%llu arrivals=%llu rendered_updates=%llu texture_to_composition_us=%lld\n",
                     static_cast<unsigned long long>(now),
                     static_cast<unsigned long long>(obs_capture.wgc_arrivals.load()),
                     static_cast<unsigned long long>(obs_capture.wgc_render_updates.load()),
                     static_cast<long long>(obs_capture.texture_to_composition_us.load()));
      for (const auto& [id, peer] : peers) {
        const auto encode = peer->encode_gaps.interval();
        std::fprintf(stderr, "link=%s encoder=%s encoded=%llu encode_p95_ms=%.2f encode_p99_ms=%.2f\n",
                     id.c_str(), peer->obs.id,
                      static_cast<unsigned long long>(peer->encoded.load()),
                     encode.first, encode.second);
        std::fprintf(stderr, "obs_timing link=%s video_timeline_to_packet_us=%llu\n", id.c_str(),
                     static_cast<unsigned long long>(peer->obs.composition_to_packet_us.load()));
      }
    }
  }

  void execute(const std::vector<std::string>& command) {
    const auto& seq = command.at(0);
    const auto& op = command.at(1);
    if (op == "start") {
      start(command);
      return;
    }
    require(source && starting.empty(), "Native capture is unavailable.");
    const auto& id = command.at(2);
    std::string value;
    if (op == "open" || op == "restart") {
      if (op == "restart") close(id);
      else require(!peers.count(id), "Native viewer already exists.");
      try {
        open(command);
        value = peers.at(id)->offer();
      } catch (...) {
        close(id);
        throw;
      }
    } else if (op == "close") {
      close(id);
    } else {
      const auto found = peers.find(id);
      require(found != peers.end(), "Native viewer ended.");
      auto& peer = *found->second;
      if (op == "local") {
        peer.accept_local(decode(command.at(3)));
      } else if (op == "answer") {
        peer.answer(decode(command.at(3)));
      } else if (op == "ice") {
        peer.add_candidate(std::stoul(command.at(3)), decode(command.at(4)));
      } else if (op == "quality") {
        peer.quality(Video(command));
      } else {
        throw std::runtime_error("Unknown OBS helper command.");
      }
    }
    emit("OK\t" + seq + "\t" + value);
  }
};
}  // namespace

#include "sender-main.hpp"
