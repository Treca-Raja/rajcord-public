#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <ks.h>
#include <ksmedia.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>
#include <vector>

namespace {
constexpr bool diagnostics = true;

void require(bool valid, const char* description) {
  if (!valid) throw std::runtime_error(description);
}

uint64_t os_gettime_ns() {
  LARGE_INTEGER frequency{}, counter{};
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&counter);
  constexpr uint64_t second = 1'000'000'000;
  return (counter.QuadPart / frequency.QuadPart) * second +
      (counter.QuadPart % frequency.QuadPart) * second / frequency.QuadPart;
}

#include "wasapi-loopback.hpp"
}

int main(int argc, char** argv) {
  try {
    require(argc == 2, "Expected an owned viewer process ID.");
    const auto pid = std::stoull(argv[1]);
    require(pid > 0 && pid <= MAXDWORD, "Invalid viewer process ID.");
    const std::unique_ptr<void, decltype(&CloseHandle)> process(
        OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid)), CloseHandle);
    require(process && WaitForSingleObject(process.get(), 0) == WAIT_TIMEOUT, "Viewer process ended.");
    const auto pipe = GetStdHandle(STD_INPUT_HANDLE);
    require(GetFileType(pipe) == FILE_TYPE_PIPE && _setmode(_fileno(stdout), _O_BINARY) != -1,
            "The playback fixture requires owned pipes.");
    check_windows_audio();
    std::vector<int16_t> mono;
    WasapiLoopback audio;
    audio.start([&](const float* samples, unsigned frames, uint64_t, bool) {
      mono.assign(frames, 0);
      if (samples) {
        for (unsigned i = 0; i < frames; ++i)
          mono[i] = static_cast<int16_t>(std::clamp((samples[2 * i] + samples[2 * i + 1]) * 0.5f,
                                                    -1.0f, 1.0f) * 32767);
      }
      return std::fwrite(mono.data(), sizeof(int16_t), frames, stdout) == frames &&
          std::fflush(stdout) == 0;
    }, static_cast<DWORD>(pid), true);
    while (!audio.failed && WaitForSingleObject(process.get(), 20) == WAIT_TIMEOUT) {
      if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, nullptr, nullptr)) break;
    }
    return audio.failed ? 1 : 0;
  } catch (const std::exception& failure) {
    std::fprintf(stderr, "%s\n", failure.what());
    return 1;
  }
}
