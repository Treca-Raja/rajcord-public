#pragma once

#include <algorithm>
#include <cstdint>
#include <optional>

struct VideoFeedback {
  unsigned loss = 0; // RTCP fraction lost in units of 1/256.
  std::optional<unsigned> rtt_ms;
  unsigned remb = 0;
};

class VideoCongestion {
 public:
  enum class Format { full, medium, compact };

  static constexpr unsigned minimum = 650'000;
  static unsigned initial(unsigned ceiling) { return std::min(ceiling, 6'000'000u); }

  std::optional<unsigned> observe(unsigned current, unsigned ceiling, uint64_t now,
                                  VideoFeedback report, bool repair_pressure, bool recurring_repairs = false) {
    if (report.rtt_ms) {
      min_rtt = min_rtt ? std::min(*min_rtt, *report.rtt_ms) : report.rtt_ms;
    }
    const unsigned queue_ms = report.rtt_ms && min_rtt ? *report.rtt_ms - *min_rtt : 0;
    const bool congested = repair_pressure || report.loss >= 21 ||
        (queue_ms >= 85 && (report.loss >= 8 || queue_ms >= 140));
    unsigned next = std::min(current, ceiling);
    if (congested) {
      if (now >= next_decrease) {
        next = next * (report.loss >= 38 || queue_ms >= 140 ? 55 : 72) / 100;
        // A receiver estimate can accelerate backoff when independent feedback signals congestion.
        if (report.remb > minimum && report.remb < current)
          next = std::min(next, std::max(minimum, report.remb * 85 / 100));
        next_decrease = now + 650;
      }
      last_congestion = now;
    } else if (recurring_repairs && queue_ms >= 37) {
      // Repaired arrivals can make the latest loss report look clean while the link is still busy.
      if (now >= next_decrease && next > 1'000'000u) {
        next = next * 85 / 100;
        next_decrease = now + 900;
      }
      last_congestion = now;
    } else if (report.loss <= 10 && queue_ms <= 65 &&
               now >= last_congestion + 800 && now >= next_increase) {
      // Clean delivery supports a bounded probe above the sender-limited REMB estimate.
      const auto probe = report.loss <= 5 ? std::clamp(next / 4, 70'000u, 1'800'000u) :
                                           std::clamp(next / 12, 40'000u, 500'000u);
      next = std::min(ceiling, next + probe);
      next_increase = now + 650;
    }
    next = std::max(std::min(minimum, ceiling), next);
    return next == current ? std::nullopt : std::optional<unsigned>(next);
  }

  unsigned standing_rtt_ms() const { return min_rtt.value_or(0); }
  Format format() const { return current_format; }

  bool update_format(unsigned rate, unsigned ceiling, uint64_t now, bool queue_dropped) {
    if (queue_dropped) last_queue_drop = now;
    const bool pressure = (last_congestion && now - last_congestion <= 3000) ||
        (last_queue_drop && now - *last_queue_drop <= 3000);
    auto next = current_format;
    if (rate >= std::min(ceiling, 3'500'000u)) {
      next = Format::full;
    } else if (pressure && rate <= 1'450'000u && rate * 100 < ceiling * 85) {
      next = Format::compact;
    } else if ((current_format == Format::compact && rate >= 2'200'000u) ||
               (current_format == Format::full && pressure && rate <= 2'000'000u &&
                 rate * 100 < ceiling * 85)) {
      next = Format::medium;
    }
    if (next != pending_format || next == current_format) {
      pending_format = next;
      format_since = now;
      return false;
    }
    if (now - format_since < 1500) return false;
    current_format = next;
    return true;
  }

 private:
  std::optional<unsigned> min_rtt;
  std::optional<uint64_t> last_queue_drop;
  uint64_t next_decrease = 0, last_congestion = 0, next_increase = 0;
  uint64_t format_since = 0;
  Format current_format = Format::full, pending_format = Format::full;
};
