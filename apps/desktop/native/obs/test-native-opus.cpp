#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <opus/opus.h>

namespace {
constexpr bool diagnostics = false;
void require(bool condition, const char* reason) {
  if (!condition) throw std::runtime_error(reason);
}

#include "native-opus.hpp"
}

int main() {
  try {
    NativeOpus source;
    constexpr auto origin = 1'000'000'000ULL;
    std::array<float, NativeOpus::frame_count * NativeOpus::channels> pcm{};
    int status = OPUS_OK;
    std::unique_ptr<OpusDecoder, decltype(&opus_decoder_destroy)> decoder(
        opus_decoder_create(NativeOpus::rate, NativeOpus::channels, &status), opus_decoder_destroy);
    require(decoder && status == OPUS_OK, "Could not initialize the Opus decoder.");
    constexpr double radians = 6.283185307179586 / NativeOpus::rate;
    double expected = 0, excluded = 0;
    for (unsigned frame = 0; frame < 12; ++frame) {
      const auto time = origin + frame * NativeOpus::frame_ns;
      for (unsigned i = 0; i < NativeOpus::frame_count; ++i) {
        const auto sample = static_cast<float>(.3 * std::sin(radians * 440 * (frame * NativeOpus::frame_count + i)));
        pcm[i * 2] = sample;
        pcm[i * 2 + 1] = sample;
      }
      source.samples(pcm.data(), NativeOpus::frame_count / 2, time, frame == 0);
      require(source.drain().empty(), "Opus emitted a partial frame.");
      source.samples(pcm.data() + NativeOpus::frame_count, NativeOpus::frame_count / 2,
                     time + NativeOpus::frame_ns / 2, false);
      const auto packets = source.drain();
      require(packets.size() == 1 && packets.front().time == time, "Opus lost the PCM timestamp.");
      const auto& packet = packets.front();
      const auto decoded = opus_decode_float(
          decoder.get(), reinterpret_cast<const unsigned char*>(packet.payload.data()),
          static_cast<opus_int32>(packet.size), pcm.data(), NativeOpus::frame_count, 0);
      require(decoded == NativeOpus::frame_count, "Opus did not decode a 20 ms frame.");
      if (frame < 3) continue;
      for (int i = 0; i < decoded; ++i) {
        const auto sample = pcm[i * 2];
        const auto index = frame * NativeOpus::frame_count + i;
        expected += sample * std::sin(radians * 440 * index);
        excluded += sample * std::sin(radians * 1247 * index);
      }
    }
    require(std::abs(expected) > 100 * std::max(1., std::abs(excluded)), "Decoded PCM lost the source tone.");
    source.samples(nullptr, 480, origin + 12 * NativeOpus::frame_ns, false);
    source.samples(nullptr, 960, origin + 20 * NativeOpus::frame_ns, true);
    const auto restarted = source.drain();
    require(restarted.size() == 1 && restarted.front().time == origin + 20 * NativeOpus::frame_ns,
            "Opus replayed PCM from before a discontinuity.");
    std::puts("PASS native Opus stereo, 48 kHz, 20 ms, source tone and discontinuity.");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
