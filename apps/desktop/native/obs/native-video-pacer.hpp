#pragma once

// Audio and RTCP bypass the video queue. Pace complete, already packetized access units.
class VideoPacer : public rtc::MediaHandler {
  struct Batch {
    rtc::message_vector packets;
    rtc::message_callback send;
    uint64_t enqueued;
    size_t next = 0;
  };
  struct Packet {
    rtc::message_ptr data;
    rtc::message_callback send;
    uint64_t enqueued;
  };
  struct RepairStamp {
    uint16_t sequence = 0;
    uint64_t sent = 0;
  };
  rtc::RtcpNackResponder history{512};
  std::mutex mutex;
  std::deque<Batch> queue;
  std::deque<Packet> repairs;
  std::array<RepairStamp, 512> last_repairs;
  size_t queued_bytes = 0;
  double credit = 0;
  double repair_credit = 0;
  uint64_t previous = 0;
  bool dropped = false;

 public:
  uint64_t bytes_sent = 0;
  uint64_t packets_sent = 0;
  uint64_t repairs_sent = 0;
  uint64_t dropped_batches = 0;
  unsigned max_age_ms = 0;

  void outgoing(rtc::message_vector& messages, const rtc::message_callback& send) override {
    if (messages.empty()) return;
    size_t bytes = 0;
    for (const auto& packet : messages) bytes += packet->size();
    std::lock_guard<std::mutex> lock(mutex);
    if (dropped || queued_bytes + bytes > 512 * 1024) {
      dropped = true;
      messages.clear();
      return;
    }
    queued_bytes += bytes;
    queue.push_back({std::move(messages), send, os_gettime_ns()});
    messages.clear();
  }

  void incoming(rtc::message_vector& messages, const rtc::message_callback& send) override {
    history.incoming(messages, [&](rtc::message_ptr packet) {
      const auto sequence = reinterpret_cast<const rtc::RtpHeader*>(packet->data())->seqNumber();
      const auto now = os_gettime_ns();
      std::lock_guard<std::mutex> lock(mutex);
      const auto& last = last_repairs[sequence % last_repairs.size()];
      if ((last.sent && last.sequence == sequence && now - last.sent < 80'000'000) ||
          repairs.size() >= 32 || std::any_of(repairs.begin(), repairs.end(),
          [&](const Packet& pending) { return pending.data == packet; })) return;
      repairs.push_back({std::move(packet), send, now});
    });
  }

  bool drain(unsigned bitrate) {
    std::vector<Packet> ready;
    rtc::message_vector sent_originals;
    const auto now = os_gettime_ns();
    {
      std::lock_guard<std::mutex> lock(mutex);
      const auto age = !queue.empty() && now > queue.front().enqueued
          ? static_cast<unsigned>((now - queue.front().enqueued) / 1'000'000) : 0;
      max_age_ms = std::max(max_age_ms, age);
      if (dropped || age >= 180) {
        dropped_batches += std::max<size_t>(1, queue.size());
        queue.clear();
        repairs.clear();
        queued_bytes = 0;
        credit = repair_credit = 0;
        previous = now;
        dropped = false;
        return true;
      }
      // CBR access units are bursty around IDRs. Reserve room for RTP overhead.
      const auto bytes_per_ms = (bitrate * 1.25 + 100'000) / 8000;
      const auto elapsed = previous && now >= previous ? (now - previous) / 1e6 : 0.;
      credit = std::min(bytes_per_ms * 24, credit + elapsed * bytes_per_ms);
      repair_credit = std::min(bytes_per_ms * 0.15 * 80, repair_credit + elapsed * bytes_per_ms * 0.15);
      previous = now;
      while (!repairs.empty()) {
        auto& packet = repairs.front();
        if (now < packet.enqueued || now - packet.enqueued < 80'000'000) {
          if (credit <= 0 || repair_credit <= 0) break;
          credit -= packet.data->size();
          repair_credit -= packet.data->size();
          const auto sequence = reinterpret_cast<const rtc::RtpHeader*>(packet.data->data())->seqNumber();
          last_repairs[sequence % last_repairs.size()] = {sequence, now};
          ready.push_back(std::move(packet));
          ++repairs_sent;
        }
        repairs.pop_front();
      }
      while (credit > 0 && !queue.empty()) {
        auto& batch = queue.front();
        auto& packet = batch.packets[batch.next++];
        credit -= packet->size();
        queued_bytes -= packet->size();
        sent_originals.push_back(packet);
        ready.push_back({std::move(packet), batch.send, batch.enqueued});
        if (batch.next == batch.packets.size()) queue.pop_front();
      }
    }
    // Store only packets that leave the queue. Repairs share the pacing budget with original video.
    history.outgoing(sent_originals, {});
    for (auto& packet : ready) {
      bytes_sent += packet.data->size();
      ++packets_sent;
      packet.send(std::move(packet.data));
    }
    return false;
  }
};
