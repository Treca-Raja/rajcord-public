#pragma once

#include "wasapi-loopback.hpp"

class ProcessLoopback {
  HANDLE target = nullptr;
  DWORD pid = 0;
  bool include = false;
  WasapiLoopback loopback;

  static bool descendant(DWORD candidate, DWORD ancestor,
                         const std::map<DWORD, DWORD>& parents) {
    for (size_t depth = 0; candidate && depth <= parents.size(); ++depth) {
      if (candidate == ancestor) return true;
      const auto entry = parents.find(candidate);
      if (entry == parents.end()) break;
      candidate = entry->second;
    }
    return false;
  }

  static void verify_separate_application(DWORD source_pid, DWORD owner_pid) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    require(snapshot != INVALID_HANDLE_VALUE, "Could not check the application audio owner.");
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    std::map<DWORD, DWORD> parents;
    if (Process32FirstW(snapshot, &entry)) {
      do {
        parents.emplace(entry.th32ProcessID, entry.th32ParentProcessID);
      } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    require(parents.count(owner_pid) && parents.count(source_pid) &&
                !descendant(source_pid, owner_pid, parents) &&
                !descendant(owner_pid, source_pid, parents),
            "Choose an application outside Rajcord's process tree.");
  }

 public:
  ProcessLoopback() = default;
  ProcessLoopback(const ProcessLoopback&) = delete;
  ProcessLoopback& operator=(const ProcessLoopback&) = delete;
  ~ProcessLoopback() {
    stop();
    if (target) CloseHandle(target);
  }

  void bind(const Source& source, const std::vector<std::string>& command) {
    const size_t offset = source.window ? 4 : 7;
    if (command.size() == offset) return;
    if (source.window && command.at(offset) == "identity") return;
    include = command.at(offset) == "app";
    require((include && source.window && command.size() == offset + 4) ||
                (!include && command.at(offset) == "system" && source.monitor &&
                 command.size() == offset + 2),
            "Invalid native audio consent.");
    const auto value = std::stoull(command.at(offset + 1));
    require(value > 0 && value <= MAXDWORD, "Invalid native audio identity.");
    pid = static_cast<DWORD>(value);
    target = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    require(valid() && target, "The consented audio process ended.");
    if (include) {
      FILETIME created{}, exited{}, kernel{}, user{};
      require(source.pid == pid && GetProcessTimes(target, &created, &exited, &kernel, &user),
              "The window no longer belongs to the selected audio process.");
      ULARGE_INTEGER start;
      start.LowPart = created.dwLowDateTime;
      start.HighPart = created.dwHighDateTime;
      // Picker identity is .NET UTC ticks since 0001, FILETIME counts ticks since 1601.
      require(start.QuadPart + 504911232000000000ULL == std::stoull(command.at(offset + 2)),
              "The selected application audio identity changed.");
      verify_separate_application(pid, std::stoul(command.at(offset + 3)));
    }
    check_windows_audio();
  }

  bool valid() const { return !target || (!loopback.failed && WaitForSingleObject(target, 0) == WAIT_TIMEOUT); }
  bool ready() const { return !target || loopback.active; }
  std::string failure() const { return loopback.failure(); }

  bool enabled() const { return target != nullptr; }
  void start(LoopbackSamples input) {
    if (target) loopback.start(std::move(input), pid, include);
  }
  void stop() { loopback.stop(); }
};
