#pragma once

class NativeOpus {
 public:
  static constexpr unsigned rate = 48000;
  static constexpr unsigned channels = 2;
  static constexpr unsigned frame_count = rate / 50;
  static constexpr uint64_t frame_ns = 20'000'000;
  struct Packet {
    std::array<std::byte, 1275> payload{};
    size_t size = 0;
    uint64_t time = 0;
  };

  NativeOpus() {
    int status = OPUS_OK;
    encoder.reset(opus_encoder_create(rate, channels, OPUS_APPLICATION_AUDIO, &status));
    require(encoder && status == OPUS_OK &&
                opus_encoder_ctl(encoder.get(), OPUS_SET_BITRATE(96000)) == OPUS_OK &&
                opus_encoder_ctl(encoder.get(), OPUS_SET_INBAND_FEC(1)) == OPUS_OK &&
                opus_encoder_ctl(encoder.get(), OPUS_SET_PACKET_LOSS_PERC(5)) == OPUS_OK,
            "Could not initialize the native Opus encoder.");
  }

  void samples(const float* pcm, unsigned count, uint64_t time, bool discontinuity) {
    if (discontinuity || !next_time || time > next_time + frame_ns) {
      buffered = 0;
      next_time = time;
      require(opus_encoder_ctl(encoder.get(), OPUS_RESET_STATE) == OPUS_OK,
              "Could not reset the native Opus encoder.");
    }
    if (diagnostics && (!last_sample || time >= last_sample + 1'000'000'000)) {
      std::fprintf(stderr, "timing audio/pcm samples=%u\n", count);
      last_sample = time;
    }
    for (unsigned consumed = 0; consumed < count;) {
      const auto copied = std::min(count - consumed, frame_count - buffered);
      auto* dest = frame.data() + buffered * channels;
      if (pcm) std::copy_n(pcm + consumed * channels, copied * channels, dest);
      else std::fill_n(dest, copied * channels, 0.f);
      buffered += copied;
      consumed += copied;
      if (buffered != frame_count) continue;
      Packet packet;
      const int size = opus_encode_float(encoder.get(), frame.data(), frame_count,
                                         reinterpret_cast<unsigned char*>(packet.payload.data()),
                                         static_cast<opus_int32>(packet.payload.size()));
      require(size > 0, "The native Opus encoder stopped producing packets.");
      packet.size = static_cast<size_t>(size);
      packet.time = next_time;
      next_time += frame_ns;
      buffered = 0;
      std::lock_guard<std::mutex> lock(mutex);
      if (queue.size() == 4) queue.pop_front();
      queue.push_back(std::move(packet));
    }
  }

  std::deque<Packet> drain() {
    std::deque<Packet> packets;
    std::lock_guard<std::mutex> lock(mutex);
    packets.swap(queue);
    return packets;
  }

 private:
  std::unique_ptr<OpusEncoder, decltype(&opus_encoder_destroy)> encoder{nullptr, opus_encoder_destroy};
  std::array<float, frame_count * channels> frame{};
  unsigned buffered = 0;
  uint64_t next_time = 0, last_sample = 0;
  std::mutex mutex;
  std::deque<Packet> queue;
};
