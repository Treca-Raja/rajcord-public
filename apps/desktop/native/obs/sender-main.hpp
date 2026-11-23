#pragma once

int main(int argc, char** argv) {
  WSADATA winsock{};
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) {
    emit("FATAL\t" + encode("Could not initialize Windows network sockets."));
    return 1;
  }
  struct WinsockCleanup { ~WinsockCleanup() { WSACleanup(); } } network;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  initialize_transport();
  diagnostics = std::getenv("RAJCORD_OBS_DIAGNOSTICS") != nullptr;
  if (argc == 2 && std::string_view(argv[1]) == "--probe") {
    try {
      std::atomic<uint64_t> frames{0};
      FrameGaps gaps;
      ObsCapture capture;
      capture.start(nullptr, frames, gaps);
      ObsEncoder::register_output();
      for (const auto choice : {"nvenc", "amf", "x264"}) {
        ObsEncoder encoder;
        Video video({"0", "open", "probe", "1280", "720", "30", "4000000"});
        if (encoder.start(obs_encoder_name(choice), video, nullptr)) emit(choice);
      }
      return 0;
    } catch (const std::exception& error) {
      emit(std::string("FAIL: ") + error.what());
      return 1;
    }
  }
  Sender sender;
  const auto input = GetStdHandle(STD_INPUT_HANDLE);
  std::string line;
  try {
    while (true) {
      DWORD waiting = 0;
      if (!PeekNamedPipe(input, nullptr, 0, nullptr, &waiting, nullptr)) break;
      if (waiting) {
        char bytes[4096];
        DWORD count = 0;
        if (!ReadFile(input, bytes, std::min<DWORD>(waiting, sizeof(bytes)), &count, nullptr) ||
            !count) break;
        for (DWORD index = 0; index < count; ++index) {
          if (bytes[index] != '\n') {
            require(line.size() < max_line, "Native command is too large.");
            line += bytes[index];
            continue;
          }
          const auto command = fields(line);
          line.clear();
          try {
            sender.execute(command);
          } catch (const SourceFailure&) {
            throw;
          } catch (const std::exception& failure) {
            if (command.size() < 2 || command.at(1) == "start") throw;
            emit("ERROR\t" + command.at(0) + "\t" + encode(failure.what()));
          }
        }
      }
      sender.poll();
      if (!waiting) Sleep(5);
    }
  } catch (const std::exception& failure) {
    emit("FATAL\t" + encode(failure.what()));
    return 1;
  }
  return 0;
}
