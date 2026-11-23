#pragma once
using Microsoft::WRL::ComPtr;

const char* obs_choice = "auto";
const char* obs_vendor = "";
const char* selected_obs_encoder = nullptr;
bool obs_available(const char* id) {
  const char* candidate = nullptr;
  for (size_t i = 0; obs_enum_encoder_types(i, &candidate); ++i)
    if (std::strcmp(id, candidate) == 0) return true;
  return false;
}

struct ObsCapture {
  HMODULE winrt = nullptr;
  void* capture = nullptr;
  obs_source_t* game_capture = nullptr;
  const Source* source = nullptr;
  std::atomic<uint64_t>* frames = nullptr;
  FrameGaps* gaps = nullptr;
  uint64_t last_render = 0;
  uint64_t last_texture_time = 0;
  std::atomic<uint64_t> wgc_arrivals{0}, wgc_render_updates{0};
  std::atomic<int64_t> texture_to_composition_us{0};
  std::atomic<const char*> failure{nullptr};
  uint64_t (*capture_stats)(const void*, uint64_t*) = nullptr;
  bool started = false, drawing = false;
  decltype(capture) (*window)(BOOL, HWND, BOOL, BOOL) = nullptr;
  decltype(capture) (*monitor)(BOOL, HMONITOR, BOOL) = nullptr;
  void (*release)(void*) = nullptr;
  void (*draw)(void*) = nullptr;
  BOOL (*is_active)(const void*) = nullptr;
  uint32_t (*width)(const void*) = nullptr;
  uint32_t (*height)(const void*) = nullptr;

  template <typename T> void import(T& fn, const char* name) {
    fn = reinterpret_cast<T>(GetProcAddress(winrt, name));
    require(fn != nullptr, "The OBS Windows capture component is incomplete.");
  }

  static void render(void* context, uint32_t canvas_width, uint32_t canvas_height) {
    auto& self = *static_cast<ObsCapture*>(context);
    if (self.failure.load()) return;
    if (self.source->window) {
      if (!self.source->valid()) {
        self.failure = "The selected native window ended.";
        return;
      }
      // Leave the canvas blank while the same authorized window is minimized.
      if (IsIconic(self.source->window) || !IsWindowVisible(self.source->window)) {
        if (!self.last_render) self.failure = "Restore the selected window and start sharing again.";
        return;
      }
    }
    if (!self.game_capture && !self.capture && self.source->valid()) {
      self.capture = self.source->window
        ? self.window(TRUE, self.source->window, TRUE, TRUE)
        : self.monitor(TRUE, self.source->monitor, TRUE);
      if (!self.capture) {
        self.failure = "Windows Graphics Capture could not open the selected source.";
        return;
      }
    }
    if (!self.game_capture && !self.capture) return;
    if (self.capture && !self.is_active(self.capture)) {
      self.failure = "Windows Graphics Capture lost the selected source. Choose it again to share.";
      return;
    }
    const auto w = self.game_capture ? obs_source_get_width(self.game_capture) : self.width(self.capture);
    const auto h = self.game_capture ? obs_source_get_height(self.game_capture) : self.height(self.capture);
    if (!w || !h) return;
    const auto scale = std::min(float(canvas_width) / w, float(canvas_height) / h);
    gs_matrix_push();
    gs_matrix_translate3f((canvas_width - w * scale) / 2, (canvas_height - h * scale) / 2, 0);
    gs_matrix_scale3f(scale, scale, 1);
    if (self.game_capture) obs_source_video_render(self.game_capture);
    else self.draw(self.capture);
    gs_matrix_pop();
    const auto frame = obs_get_video_frame_time();
    if (frame != self.last_render) {
      self.last_render = frame;
      ++*self.frames;
      self.gaps->frame();
      if (self.capture && self.capture_stats) {
        uint64_t texture_time = 0;
        self.wgc_arrivals = self.capture_stats(self.capture, &texture_time);
        if (texture_time && texture_time != self.last_texture_time) {
          ++self.wgc_render_updates;
          self.last_texture_time = texture_time;
          self.texture_to_composition_us =
              (static_cast<int64_t>(frame) - static_cast<int64_t>(texture_time * 100)) / 1000;
        }
      }
    }
  }

  void start_game_capture() {
    require(source && source->window && source->valid(), "Game Capture requires an authorized window.");
    obs_module_t* module = nullptr;
    require(obs_open_module(&module, "../obs/core/win-capture/win-capture.dll",
                            "../obs/core/win-capture/data") == MODULE_SUCCESS &&
                obs_init_module(module),
            "The private OBS Game Capture module is unavailable.");
    auto* settings = obs_data_create();
    obs_data_set_string(settings, "capture_mode", "window");
    obs_data_set_int(settings, "rajcord_window", reinterpret_cast<intptr_t>(source->window));
    obs_data_set_int(settings, "rajcord_process", reinterpret_cast<intptr_t>(source->process.get()));
    obs_data_set_int(settings, "rajcord_thread", source->thread);
    obs_data_set_bool(settings, "capture_audio", false);
    obs_data_set_bool(settings, "anti_cheat_hook", false);
    game_capture = obs_source_create_private("game_capture", "Rajcord Game Capture", settings);
    obs_data_release(settings);
    require(game_capture != nullptr, "Could not create the exact-window OBS Game Capture source.");
    obs_source_inc_showing(game_capture);
  }

  void start(const Source* selected, std::atomic<uint64_t>& count, FrameGaps& frame_gaps) {
    source = selected;
    frames = &count;
    gaps = &frame_gaps;
    const char* choice = std::getenv("RAJCORD_OBS_ENCODER");
    if (choice) obs_choice = choice;
    require(std::string_view(obs_choice) == "auto" || std::string_view(obs_choice) == "nvenc" ||
            std::string_view(obs_choice) == "amf" || std::string_view(obs_choice) == "x264",
            "Invalid OBS encoder choice.");
    base_set_log_handler([](int, const char* fmt, va_list args, void*) {
      if (diagnostics) {
        std::vfprintf(stderr, fmt, args);
        std::fputc('\n', stderr);
      }
    }, nullptr);
    require(std::string_view(obs_get_version_string()) == RAJCORD_OBS_VERSION,
            "The private libobs runtime does not match the helper build.");
    require(obs_startup("en-US", nullptr, nullptr), "Could not initialize libobs.");
    started = true;
    obs_add_data_path("../obs/data/libobs/");
    winrt = LoadLibraryW(L"libobs-winrt.dll");
    require(winrt != nullptr, "The OBS Windows capture component is missing.");
    import(window, "winrt_capture_init_window");
    import(monitor, "winrt_capture_init_monitor");
    import(release, "winrt_capture_free");
    import(draw, "winrt_capture_render");
    import(is_active, "winrt_capture_active");
    import(width, "winrt_capture_width");
    import(height, "winrt_capture_height");
    if (diagnostics)
      capture_stats = reinterpret_cast<decltype(capture_stats)>(
          GetProcAddress(winrt, "rajcord_winrt_capture_stats"));

    // OBS indexes the same DXGI adapters. Prefer the adapter owning the selected display.
    ComPtr<IDXGIFactory1> factory;
    uint32_t adapter_index = 0;
    const auto selected_monitor = source ? (source->window
      ? MonitorFromWindow(source->window, MONITOR_DEFAULTTONEAREST) : source->monitor) : nullptr;
    if (SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(factory.GetAddressOf())))) {
      ComPtr<IDXGIAdapter1> adapter;
      for (UINT index = 0; factory->EnumAdapters1(index, adapter.ReleaseAndGetAddressOf()) == S_OK; ++index) {
        DXGI_ADAPTER_DESC1 desc{};
        if (FAILED(adapter->GetDesc1(&desc))) continue;
        const char* vendor = desc.VendorId == 0x10de ? "nvenc" : desc.VendorId == 0x1002 ? "amf" : "";
        if (!index) obs_vendor = vendor;
        ComPtr<IDXGIOutput> output;
        for (UINT j = 0; selected_monitor && adapter->EnumOutputs(j, output.ReleaseAndGetAddressOf()) == S_OK; ++j) {
          DXGI_OUTPUT_DESC display{};
          if (SUCCEEDED(output->GetDesc(&display)) && display.Monitor == selected_monitor) {
            adapter_index = index;
            obs_vendor = vendor;
          }
        }
      }
    }
    obs_video_info video{};
    video.graphics_module = "libobs-d3d11";
    video.fps_num = 60;
    video.fps_den = 1;
    video.base_width = video.output_width = 1920;
    video.base_height = video.output_height = 1080;
    video.output_format = VIDEO_FORMAT_NV12;
    video.adapter = adapter_index;
    video.gpu_conversion = true;
    video.colorspace = VIDEO_CS_709;
    video.range = VIDEO_RANGE_PARTIAL;
    video.scale_type = OBS_SCALE_BICUBIC;
    require(obs_reset_video(&video) == OBS_VIDEO_SUCCESS, "OBS could not start its Direct3D11 video device.");
    for (const auto name : {"obs-nvenc", "obs-ffmpeg", "obs-x264"}) {
      obs_module_t* module = nullptr;
      const auto root = std::string("../obs/core/") + name;
      if (obs_open_module(&module, (root + "/" + name + ".dll").c_str(), (root + "/data").c_str()) == MODULE_SUCCESS)
        obs_init_module(module);
    }
    if (source) {
      if (env_enabled("RAJCORD_OBS_GAME_CAPTURE_TEST")) start_game_capture();
      obs_add_main_render_callback(render, this);
      drawing = true;
    }
  }

  ~ObsCapture() {
    if (drawing) obs_remove_main_render_callback(render, this);
    if (game_capture) {
      obs_source_dec_showing(game_capture);
      obs_source_release(game_capture);
    }
    if (capture)
      obs_queue_task(OBS_TASK_GRAPHICS, [](void* context) {
        auto& self = *static_cast<ObsCapture*>(context);
        obs_enter_graphics();
        self.release(self.capture);
        obs_leave_graphics();
      }, this, true);
    if (started) obs_shutdown();
    if (winrt) FreeLibrary(winrt);
  }
};

struct ObsEncoder;
thread_local ObsEncoder* creating_output = nullptr;

struct ObsEncoder {
  using PacketSink = std::function<void(const encoder_packet&, const uint8_t*, size_t, uint64_t)>;
  PacketSink packet_sink;

  obs_output_t* output = nullptr;
  obs_encoder_t* encoder = nullptr;
  std::atomic<uint64_t> packets{0};
  std::atomic<uint64_t> composition_to_packet_us{0};
  const char* id = nullptr;

  void push(encoder_packet* packet) {
    const auto now = os_gettime_ns();
    const auto frame_time = packet->sys_dts_usec > 0 ? uint64_t(packet->sys_dts_usec) * 1000 : 0;
    const auto age = frame_time && now >= frame_time ? now - frame_time : UINT64_MAX;
    if (age < 1'000'000'000) composition_to_packet_us = age / 1000;
    if (!packet_sink) return;
    uint8_t* headers = nullptr;
    size_t size = 0;
    if (!packet->keyframe || !obs_encoder_get_extra_data(encoder, &headers, &size) || size > 4096)
      size = 0;
    packet_sink(*packet, headers, size, age);
  }

  static void register_output() {
    obs_output_info info{};
    info.id = "rajcord_video";
    info.flags = OBS_OUTPUT_VIDEO | OBS_OUTPUT_ENCODED;
    info.encoded_video_codecs = "h264";
    info.get_name = [](void*) { return "Rajcord video"; };
    info.create = [](obs_data_t*, obs_output_t*) -> void* { return creating_output; };
    info.destroy = [](void*) {};
    info.start = [](void* data) {
      auto* out = static_cast<ObsEncoder*>(data)->output;
      return obs_output_can_begin_data_capture(out, 0) &&
        obs_output_initialize_encoders(out, 0) && obs_output_begin_data_capture(out, 0);
    };
    info.stop = [](void* data, uint64_t) {
      obs_output_end_data_capture(static_cast<ObsEncoder*>(data)->output);
    };
    info.encoded_packet = [](void* data, encoder_packet* packet) {
      auto& self = *static_cast<ObsEncoder*>(data);
      if (!packet || !packet->size || packet->size > 4 * 1024 * 1024) return;
      self.push(packet);
      ++self.packets;
    };
    obs_register_output(&info);
  }

  bool start(const char* name, const Video& video, PacketSink sink,
             bool wait_for_packet = true) {
    stop();
    packet_sink = std::move(sink);
    packets = 0;
    id = name;
    if (!obs_available(name)) return false;
    obs_data_t* settings = obs_data_create();
    obs_data_set_string(settings, "rate_control", "CBR");
    obs_data_set_string(settings, "profile", "baseline");
    obs_data_set_int(settings, "bitrate", video.bitrate / 1000);
    obs_data_set_int(settings, "keyint_sec", 1);
    obs_data_set_int(settings, "bf", 0);
    const auto divisor = (60 + video.fps - 1) / video.fps;
    const std::string_view type(name);
    if (type == "obs_nvenc_h264_tex") {
      obs_data_set_string(settings, "preset", "p4");
      obs_data_set_string(settings, "tune", "ull");
      obs_data_set_string(settings, "multipass", "disabled");
      obs_data_set_bool(settings, "lookahead", false);
      obs_data_set_bool(settings, "adaptive_quantization", false);
    } else if (type == "h264_texture_amf") {
      obs_data_set_string(settings, "preset", "speed");
      obs_data_set_string(settings, "ffmpeg_opts", "usage=ultralowlatency");
    } else {
      obs_data_set_string(settings, "preset", "ultrafast");
      obs_data_set_string(settings, "tune", "zerolatency");
    }
    encoder = obs_video_encoder_create(name, "Rajcord viewer H.264", settings, nullptr);
    obs_data_release(settings);
    if (!encoder) return false;
    obs_encoder_set_video(encoder, obs_get_video());
    obs_encoder_set_scaled_size(encoder, video.width, video.height);
    obs_encoder_set_gpu_scale_type(encoder, OBS_SCALE_BICUBIC);
    if (!obs_encoder_set_frame_rate_divisor(encoder, divisor))
      return false;
    creating_output = this;
    output = obs_output_create("rajcord_video", "Rajcord viewer output", nullptr, nullptr);
    creating_output = nullptr;
    if (!output) return false;
    obs_output_set_video_encoder(output, encoder);
    if (!obs_output_start(output)) return false;
    if (!wait_for_packet) return true;
    for (unsigned i = 0; i < 80 && !packets; ++i) Sleep(10);
    return packets > 0;
  }

  void stop() {
    if (output) {
      obs_output_force_stop(output);
      obs_output_release(output);
      output = nullptr;
    }
    if (encoder) {
      obs_encoder_release(encoder);
      encoder = nullptr;
    }
  }

  void bitrate(unsigned kbps) {
    auto settings = obs_data_create();
    obs_data_set_int(settings, "bitrate", kbps);
    obs_encoder_update(encoder, settings);
    obs_data_release(settings);
  }

  ~ObsEncoder() { stop(); }
};

const char* obs_encoder_name(std::string_view key) {
  if (key == "nvenc") return "obs_nvenc_h264_tex";
  if (key == "amf") return "h264_texture_amf";
  return "obs_x264";
}

