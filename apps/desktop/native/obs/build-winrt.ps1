[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ObsSource,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist')
)

$ErrorActionPreference = 'Stop'
$out = (Resolve-Path -LiteralPath $OutputDirectory).Path
if (!(Test-Path -LiteralPath "$out/obs.lib")) { throw 'Build the matching OBS helper first.' }
$ObsSource = (Resolve-Path -LiteralPath $ObsSource).Path
if (!(Get-Command cl.exe -ErrorAction Ignore)) {
  $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  $vs = & $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (!$vs) { throw 'Install the Visual Studio x64 C++ build tools and Windows SDK.' }
  & (Join-Path $vs 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
}
$capture = [IO.File]::ReadAllText("$ObsSource/libobs-winrt/winrt-capture.cpp")
function Replace-Anchor([string]$Text, [string]$Anchor, [string]$Replacement, [int]$Count) {
  if ([regex]::Matches($Text, [regex]::Escape($Anchor)).Count -ne $Count) {
    throw "Unexpected OBS 33.0.1 capture source near $Anchor"
  }
  $Text.Replace($Anchor, $Replacement)
}
$capture = Replace-Anchor $capture 'bool texture_written;' @'
bool texture_written;
	std::atomic<uint64_t> frames_arrived{0};
	uint64_t texture_time = 0;
'@ 1
$capture = Replace-Anchor $capture 'const winrt::Windows::Graphics::SizeInt32 frame_content_size = frame.ContentSize();' @'
if (!frame)
			return;
		++frames_arrived;
		const winrt::Windows::Graphics::SizeInt32 frame_content_size = frame.ContentSize();
'@ 1
$capture = Replace-Anchor $capture 'texture_written = true;' @'
texture_time = frame.SystemRelativeTime().count();
				texture_written = true;
'@ 1
$capture = Replace-Anchor $capture 'struct winrt_capture {' @'
static void rajcord_configure_capture_interval(
	const winrt::Windows::Graphics::Capture::GraphicsCaptureSession &session)
{
	if (GetEnvironmentVariableW(L"RAJCORD_WGC_TEST_STOCK", nullptr, 0))
		return;
	try {
		if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
			    L"Windows.Graphics.Capture.GraphicsCaptureSession", L"MinUpdateInterval"))
			session.MinUpdateInterval(winrt::Windows::Foundation::TimeSpan{1});
	} catch (const winrt::hresult_error &error) {
		blog(LOG_WARNING, "Windows capture interval request failed (0x%08X)", error.code().value);
	}
}

struct winrt_capture {
'@ 1
$capture = Replace-Anchor $capture "`t`tsession.StartCapture();" ("`t`trajcord_configure_capture_interval(session);`n`t`tsession.StartCapture();") 1
$capture = Replace-Anchor $capture "`n`tsession.StartCapture();" ("`n`trajcord_configure_capture_interval(session);`n`tsession.StartCapture();") 1
$capture += @'

extern "C" EXPORT uint64_t rajcord_winrt_capture_stats(const struct winrt_capture *capture, uint64_t *timestamp)
{
	*timestamp = capture->texture_time;
	return capture->frames_arrived.load();
}
'@
$source = Join-Path $out 'winrt-capture-local.cpp'
[IO.File]::WriteAllText($source, $capture)
$includes = Join-Path $out 'winrt-probe-includes.h'
@(
  '#define NOMINMAX', '#define WIN32_LEAN_AND_MEAN', '#include <atomic>', '#include <d3d11.h>',
  '#include <DispatcherQueue.h>', '#include <dwmapi.h>', '#include <obs-module.h>',
  '#include <util/windows/ComPtr.hpp>', '#include <Windows.Graphics.Capture.Interop.h>',
  '#include <windows.graphics.directx.direct3d11.interop.h>',
  '#include <winrt/Windows.Foundation.Metadata.h>', '#include <winrt/Windows.Graphics.Capture.h>',
  '#include <winrt/Windows.System.h>'
) | Set-Content -LiteralPath $includes
$probe = Join-Path $out 'winrt'
New-Item -ItemType Directory -Force -Path $probe | Out-Null
$args = @('/nologo','/std:c++20','/EHsc','/O2','/MD','/LD','/utf-8',
  "/FI$includes", "/I$out", "/I$ObsSource/libobs", "/I$ObsSource/libobs-winrt",
  "/Fo$probe/", "/Fe$probe/libobs-winrt.dll", $source, "$ObsSource/libobs-winrt/winrt-dispatch.cpp",
  '/link', "$out/obs.lib", 'Dwmapi.lib', 'windowsapp.lib', 'CoreMessaging.lib', 'user32.lib')
& cl.exe @args
if ($LASTEXITCODE) { throw "OBS WinRT capture module build failed ($LASTEXITCODE)." }
