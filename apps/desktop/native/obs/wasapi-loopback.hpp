using LoopbackSamples = std::function<bool(const float*, unsigned, uint64_t, bool)>;

struct LoopbackActivation : Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
    IActivateAudioInterfaceCompletionHandler, Microsoft::WRL::FtmBase> {
  std::unique_ptr<void, decltype(&CloseHandle)> done{CreateEventW(nullptr, TRUE, FALSE, nullptr), CloseHandle};
  Microsoft::WRL::ComPtr<IAudioClient> client;
  HRESULT result = E_FAIL;

  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activated = E_FAIL;
    Microsoft::WRL::ComPtr<IUnknown> device;
    result = operation->GetActivateResult(&activated, device.GetAddressOf());
    if (SUCCEEDED(result)) result = activated;
    if (SUCCEEDED(result)) result = device ? device.As(&client) : E_NOINTERFACE;
    SetEvent(done.get());
    return S_OK;
  }
};

struct WasapiFailure : std::runtime_error {
  HRESULT code;
  WasapiFailure(const char* stage, HRESULT result) : std::runtime_error(stage), code(result) {}
};

static void wasapi_check(const char* stage, HRESULT result) {
  if (diagnostics)
    std::fprintf(stderr, "wasapi stage=%s time_ms=%llu hr=0x%08lx\n", stage,
                 static_cast<unsigned long long>(GetTickCount64()), static_cast<unsigned long>(result));
  if (FAILED(result)) throw WasapiFailure(stage, result);
}

static DWORD windows_audio_state() {
  using ServiceHandle = std::unique_ptr<std::remove_pointer_t<SC_HANDLE>, decltype(&CloseServiceHandle)>;
  ServiceHandle manager(OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT), CloseServiceHandle);
  if (!manager) return 0;
  ServiceHandle service(OpenServiceW(manager.get(), L"Audiosrv", SERVICE_QUERY_STATUS), CloseServiceHandle);
  SERVICE_STATUS status{};
  return service && QueryServiceStatus(service.get(), &status) ? status.dwCurrentState : 0;
}

static constexpr auto windows_audio_stopped =
    "Windows Audio is stopped (0x88890010). Start Windows Audio in Services, then share again.";

static void check_windows_audio() {
  const auto state = windows_audio_state();
  if (state == SERVICE_STOPPED || state == SERVICE_STOP_PENDING) {
    if (diagnostics)
      std::fprintf(stderr, "wasapi stage=WindowsAudioService time_ms=%llu hr=0x88890010\n",
                   static_cast<unsigned long long>(GetTickCount64()));
    throw std::runtime_error(windows_audio_stopped);
  }
}

static std::string wasapi_message(const WasapiFailure& error) {
  if (error.code == AUDCLNT_E_SERVICE_NOT_RUNNING) return windows_audio_stopped;
  char code[11];
  std::snprintf(code, sizeof(code), "0x%08lx", static_cast<unsigned long>(error.code));
  return std::string("Windows could not capture the selected source audio (") +
         error.what() + ", " + code + "). Start a new share to retry the same source.";
}

class WasapiLoopback {
  std::unique_ptr<void, decltype(&CloseHandle)> stopping{nullptr, CloseHandle};
  std::thread worker;
  std::string failure_detail;
  static constexpr unsigned rate = 48000;
  static constexpr unsigned stride = 8;

  void capture(const LoopbackSamples& input, DWORD pid, bool include) {
    using Microsoft::WRL::ComPtr;
    wasapi_check("CoInitializeEx", CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    struct Apartment { ~Apartment() { CoUninitialize(); } } apartment;
    const auto activation = Microsoft::WRL::Make<LoopbackActivation>();
    require(activation && activation->done, "Could not open the process audio endpoint.");
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        include ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT properties{};
    properties.vt = VT_BLOB;
    properties.blob.cbSize = sizeof(params);
    properties.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    wasapi_check("ActivateAudioInterfaceAsync", ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                __uuidof(IAudioClient), &properties, activation.Get(), operation.GetAddressOf()));
    HANDLE events[] = {stopping.get(), activation->done.get()};
    const auto activated = WaitForMultipleObjects(2, events, FALSE, 4000);
    if (activated == WAIT_OBJECT_0) return;
    wasapi_check("WaitForActivation", activated == WAIT_OBJECT_0 + 1 ? S_OK :
                 HRESULT_FROM_WIN32(activated == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError()));
    wasapi_check("GetActivateResult", activation->result);

    auto client = activation->client;
    // Match OBS's stereo floating-point capture at Opus's native clock rate.
    WAVEFORMATEXTENSIBLE format{};
    format.Format = {WAVE_FORMAT_EXTENSIBLE, 2, rate, rate * stride, stride, 32,
                     sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)};
    format.Samples.wValidBitsPerSample = 32;
    format.dwChannelMask = KSAUDIO_SPEAKER_STEREO;
    format.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    wasapi_check("IAudioClient.Initialize", client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0, 0, &format.Format, nullptr));
    std::unique_ptr<void, decltype(&CloseHandle)> packet_event(CreateEventW(nullptr, FALSE, FALSE, nullptr), CloseHandle);
    require(packet_event != nullptr, "Could not create the process audio event.");
    wasapi_check("IAudioClient.SetEventHandle", client->SetEventHandle(packet_event.get()));
    ComPtr<IAudioCaptureClient> packets;
    wasapi_check("IAudioClient.GetService", client->GetService(IID_PPV_ARGS(packets.GetAddressOf())));
    wasapi_check("IAudioClient.Start", client->Start());
    struct StopClient { IAudioClient* client; ~StopClient() { client->Stop(); } } running{client.Get()};
    active = true;
    events[1] = packet_event.get();
    uint64_t next = 0;
    std::vector<float> samples;
    bool first_packet = true;
    for (;;) {
      const auto signaled = WaitForMultipleObjects(2, events, FALSE, 2000);
      if (signaled == WAIT_OBJECT_0) return;
      if (signaled == WAIT_TIMEOUT) check_windows_audio();
      else if (signaled != WAIT_OBJECT_0 + 1)
        wasapi_check("WaitForCapturePacket", signaled == WAIT_FAILED ? HRESULT_FROM_WIN32(GetLastError()) : E_UNEXPECTED);
      UINT32 count = 0;
      auto status = packets->GetNextPacketSize(&count);
      if (FAILED(status)) wasapi_check("IAudioCaptureClient.GetNextPacketSize", status);
      while (count && WaitForSingleObject(stopping.get(), 0) == WAIT_TIMEOUT) {
        BYTE* bytes = nullptr;
        DWORD flags = 0;
        UINT64 qpc = 0;
        status = packets->GetBuffer(&bytes, &count, &flags, nullptr, &qpc);
        if (FAILED(status)) wasapi_check("IAudioCaptureClient.GetBuffer", status);
        if (!count) break;
        if (first_packet) {
          first_packet = false;
          wasapi_check("IAudioCaptureClient.FirstPacket", status);
        }
        const auto now = os_gettime_ns();
        // Process loopback provides the first sample in the same QPC domain as libobs.
        const bool discontinuity = (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0;
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
        uint64_t pts = 0;
        if (!(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) && qpc && qpc <= now / 100 &&
            now - qpc * 100 < 1'000'000'000)
          pts = qpc * 100;
        if (!pts && !discontinuity) pts = next;
        if (pts && bytes && !silent) {
          samples.resize(static_cast<size_t>(count) * 2);
          std::memcpy(samples.data(), bytes, static_cast<size_t>(count) * stride);
        }
        status = packets->ReleaseBuffer(count);
        if (FAILED(status)) wasapi_check("IAudioCaptureClient.ReleaseBuffer", status);
        if (pts && (bytes || silent)) {
          if (!discontinuity) pts = std::max(next, pts);
          next = pts + (uint64_t(count) * 1'000'000'000 / rate);
          if (!input(silent ? nullptr : samples.data(), count, pts, discontinuity)) return;
        }
        status = packets->GetNextPacketSize(&count);
        if (FAILED(status)) wasapi_check("IAudioCaptureClient.GetNextPacketSize", status);
      }
    }
  }

 public:
  std::atomic<bool> active{false};
  std::atomic<bool> failed{false};
  std::string failure() const { return failed.load() ? failure_detail : std::string{}; }
  void start(LoopbackSamples input, DWORD pid, bool include) {
    stopping.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    require(input && stopping, "WASAPI process loopback is unavailable.");
    worker = std::thread([this, input = std::move(input), pid, include] {
      try {
        capture(input, pid, include);
        failure_detail = "Windows stopped the selected source audio.";
      } catch (const WasapiFailure& error) {
        failure_detail = wasapi_message(error);
      } catch (const std::exception& error) {
        failure_detail = error.what();
      }
      if (WaitForSingleObject(stopping.get(), 0) == WAIT_TIMEOUT) {
        if (diagnostics) std::fprintf(stderr, "audio capture: %s\n", failure_detail.c_str());
        failed = true;
      }
    });
  }
  void stop() {
    if (!worker.joinable()) return;
    SetEvent(stopping.get());
    worker.join();
  }
};
