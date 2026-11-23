#pragma once

bool env_enabled(const char* name) {
  const auto* value = std::getenv(name);
  return value && std::string_view(value) == "1";
}

class FrameGaps {
  using Clock = std::chrono::steady_clock;
  std::mutex mutex;
  Clock::time_point previous{};
  // Quarter-millisecond bins up to 1 s. Track the longest gap in the overflow bin.
  std::array<unsigned, 4001> bins{};
  unsigned count = 0;
  double maximum = 0;

 public:
  void frame() {
    if (!diagnostics) return;
    auto now = Clock::now();
    std::lock_guard<std::mutex> lock(mutex);
    if (previous != Clock::time_point{}) {
      double ms = std::chrono::duration<double, std::milli>(now - previous).count();
      ++bins[std::min(bins.size() - 1, static_cast<size_t>(std::ceil(ms * 4)))];
      maximum = std::max(maximum, ms);
      ++count;
    }
    previous = now;
  }

  std::pair<double, double> interval() {
    std::lock_guard<std::mutex> lock(mutex);
    auto percentile = [&](double fraction) {
      if (!count) return 0.;
      const auto target = static_cast<unsigned>(std::ceil(fraction * count));
      unsigned accumulated = 0;
      for (size_t i = 0; i + 1 < bins.size(); ++i) {
        accumulated += bins[i];
        if (accumulated >= target) return i * .25;
      }
      return maximum;
    };
    auto result = std::make_pair(percentile(.95), percentile(.99));
    bins.fill(0);
    count = 0;
    maximum = 0;
    return result;
  }
};

void emit(const std::string& line) {
  std::lock_guard<std::mutex> lock(output_mutex);
  if (std::fprintf(stdout, "%s\n", line.c_str()) < 0 || std::fflush(stdout) != 0)
    ExitProcess(1);
}

std::string encode(const char* value) {
  auto encoded = g_base64_encode(reinterpret_cast<const guchar*>(value), strlen(value));
  std::string result(encoded);
  g_free(encoded);
  return result;
}

std::string decode(const std::string& value) {
  gsize len = 0;
  auto decoded = g_base64_decode(value.c_str(), &len);
  std::string result(reinterpret_cast<char*>(decoded), len);
  g_free(decoded);
  return result;
}

std::vector<std::string> fields(const std::string& line) {
  std::istringstream stream(line);
  std::vector<std::string> result;
  for (std::string field; std::getline(stream, field, '\t');) result.push_back(field);
  return result;
}

void require(bool condition, const char* reason) {
  if (!condition) throw std::runtime_error(reason);
}
struct SourceFailure : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct Source {
  HWND window = nullptr;
  DWORD pid = 0;
  DWORD thread = 0;
  std::unique_ptr<void, decltype(&CloseHandle)> process{nullptr, CloseHandle};
  HMONITOR monitor = nullptr;
  RECT bounds{};

  explicit Source(const std::vector<std::string>& command) {
    if (command.at(2) == "window") {
      require((command.size() == 7 && command.at(4) == "identity") ||
                  (command.size() == 8 && command.at(4) == "app"),
              "The selected window needs a verified process identity.");
      window = reinterpret_cast<HWND>(std::stoull(command.at(3)));
      thread = GetWindowThreadProcessId(window, &pid);
      require(thread && pid && pid == std::stoull(command.at(5)),
              "The selected window owner changed.");
      process.reset(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
      FILETIME created{}, exited{}, kernel{}, user{};
      require(process && GetProcessTimes(process.get(), &created, &exited, &kernel, &user),
              "The selected window owner is unavailable.");
      ULARGE_INTEGER ticks;
      ticks.LowPart = created.dwLowDateTime;
      ticks.HighPart = created.dwHighDateTime;
      require(ticks.QuadPart + 504911232000000000ULL == std::stoull(command.at(6)),
              "The selected window owner was replaced.");
      require(window && thread && pid && valid(), "The selected window is no longer available.");
    } else {
      require(command.at(2) == "monitor", "Invalid screen source.");
      bounds = {std::stol(command.at(3)), std::stol(command.at(4)),
                std::stol(command.at(5)), std::stol(command.at(6))};
      monitor = MonitorFromRect(&bounds, MONITOR_DEFAULTTONULL);
      require(monitor && valid(), "The selected monitor could not be matched exactly.");
    }
  }

  bool valid() const {
    if (window) {
      DWORD current = 0;
      return process && WaitForSingleObject(process.get(), 0) == WAIT_TIMEOUT &&
             IsWindow(window) && GetWindowThreadProcessId(window, &current) == thread &&
             current == pid;
    }
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    return GetMonitorInfoW(monitor, &info) && EqualRect(&bounds, &info.rcMonitor);
  }

};

struct Video {
  int width;
  int height;
  int fps;
  int bitrate;

  explicit Video(const std::vector<std::string>& command)
      : width(std::stoi(command.at(3))), height(std::stoi(command.at(4))),
        fps(std::stoi(command.at(5))), bitrate(std::stoi(command.at(6))) {
    require(width >= 160 && width <= 4096 && width % 2 == 0 &&
                height >= 64 && height <= 1080 && height % 2 == 0 &&
                fps >= 1 && fps <= 60 && bitrate >= 100000 && bitrate <= 20000000,
            "Invalid native video limits.");
  }

};

