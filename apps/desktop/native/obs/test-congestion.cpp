#include "congestion.hpp"
#include <cassert>
#include <cstdio>

int main() {
  VideoCongestion viewer;
  constexpr unsigned ceiling = 12'000'000;
  assert(VideoCongestion::initial(ceiling) == 6'000'000);
  assert(VideoCongestion::initial(1'000'000) == 1'000'000);
  assert(!viewer.observe(ceiling, ceiling, 1000, {0, 28, 13'000'000}, false));
  const auto reduced = viewer.observe(ceiling, ceiling, 2000, {48, 200, 2'000'000}, false);
  assert(reduced == 1'700'000u);
  assert(!viewer.observe(*reduced, ceiling, 2100, {48, 200, 2'000'000}, false));
  assert(!viewer.observe(*reduced, ceiling, 2200, {0, 28, 1'000'000}, false));
  assert(!viewer.observe(*reduced, ceiling, 5000, {11, 60, 1'000'000}, false));

  unsigned rate = *reduced;
  for (uint64_t now = 6000; now <= 28000; now += 1000)
    rate = viewer.observe(rate, ceiling, now, {0, 28, 1'000'000}, false).value_or(rate);
  assert(rate == ceiling);
  assert(viewer.observe(rate, 3'000'000, 29000, {}, false) == 3'000'000u);
  assert(viewer.observe(3'000'000, ceiling, 30000, {}, true) == 2'160'000u);
  assert(viewer.observe(1'000'000, 500'000, 31000, {64, 200, 400'000}, false) == 500'000u);
  assert(viewer.standing_rtt_ms() == 28);

  VideoCongestion other;
  assert(!other.observe(ceiling, ceiling, 30000, {0, 29, 15'000'000}, false));
  assert(other.standing_rtt_ms() == 29);
  VideoCongestion format_viewer;
  assert(!format_viewer.update_format(900'000, ceiling, 32000, false));
  assert(!format_viewer.update_format(900'000, ceiling, 32500, true));
  assert(!format_viewer.update_format(900'000, ceiling, 33500, true));
  using Format = VideoCongestion::Format;
  assert(format_viewer.update_format(900'000, ceiling, 34000, false) &&
         format_viewer.format() == Format::compact);
  assert(other.format() == Format::full);
  assert(!format_viewer.update_format(2'000'000, ceiling, 34500, false));
  assert(!format_viewer.update_format(4'000'000, ceiling, 35000, false));
  assert(format_viewer.update_format(4'000'000, ceiling, 36500, false) &&
         format_viewer.format() == Format::full);
  assert(!format_viewer.update_format(500'000, 500'000, 37000, true));
  assert(other.observe(1'200'000, ceiling, 31000, {9, 67, 1'000'000}, false) == 1'300'000u);
  VideoCongestion sustained;
  assert(sustained.observe(2'000'000, ceiling, 40000, {33, 30, 0}, false) == 1'440'000u);
  assert(!sustained.update_format(1'440'000, ceiling, 40000, false));
  assert(sustained.update_format(1'440'000, ceiling, 41500, false));
  assert(sustained.format() == Format::compact);
  assert(!sustained.update_format(2'300'000, ceiling, 42000, false));
  assert(sustained.update_format(2'300'000, ceiling, 43500, false));
  assert(sustained.format() == Format::medium);
  assert(sustained.observe(1'400'000, ceiling, 44000, {0, 80, 0}, false, true) == 1'190'000u);
  assert(!sustained.observe(950'000, ceiling, 45000, {4, 79, 0}, false, true));
  assert(sustained.observe(950'000, ceiling, 46000, {0, 30, 0}, false) == 1'187'500u);
  std::puts("PASS congestion backoff, rate recovery, limits and independent peers.");
}
