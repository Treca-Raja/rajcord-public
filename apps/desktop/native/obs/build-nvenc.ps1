[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ObsSource,
  [Parameter(Mandatory)][string]$CodecHeaders,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist')

)

$ErrorActionPreference = 'Stop'
$dist = (Resolve-Path -LiteralPath $OutputDirectory).Path
$out = Join-Path $dist 'nvenc'
New-Item -ItemType Directory -Force $out | Out-Null
$expectedHash = '42d72fbcca46e05a1c05a79f1cda1fedd68ba686b21adf917e05d908153645d9'
if ((Get-FileHash -LiteralPath $CodecHeaders).Hash -ne $expectedHash) {
  throw 'Incorrect SHA-256 for the pinned NVENC headers.'
}
$headers = Join-Path $out 'nv-codec-headers-e844e5b26f46bb77479f063029595293aa8f812d'
if (!(Test-Path -LiteralPath "$headers/include/ffnvcodec/nvEncodeAPI.h")) {
  & tar.exe -xf $CodecHeaders -C $out
  if ($LASTEXITCODE) { throw 'Could not extract the pinned NVENC headers.' }
}

function Replace-NvencAnchor([string]$Text, [string]$Anchor, [string]$Replacement) {
  if ([regex]::Matches($Text, [regex]::Escape($Anchor)).Count -ne 1) {
    throw "Unexpected OBS 33.0.1 NVENC source near $Anchor"
  }
  $Text.Replace($Anchor, $Replacement)
}

$plugin = Join-Path $ObsSource 'plugins/obs-nvenc'
$source = Join-Path $out 'nvenc-low-latency.c'
$text = [IO.File]::ReadAllText("$plugin/nvenc.c")
# Keep the upstream buffer pool. Read back each ready packet for the no-reorder texture path.
$text = Replace-NvencAnchor $text 'const int output_delay = buf_count - 1;' @'
int output_delay = buf_count - 1;
#ifdef _WIN32
	if (enc->codec == CODEC_H264 && !enc->non_texture && !lookahead &&
	    config->frameIntervalP == 1 && enc->params.tuningInfo == NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY)
		output_delay = 1;
#endif
'@
# A driver which needs more input gets the upstream readback delay for the rest of the session.
$anchor = '/* check for encoded packet and parse   */'
$text = Replace-NvencAnchor $text $anchor ($anchor + @'

	if (enc->output_delay == 1 && err == NV_ENC_ERR_NEED_MORE_INPUT)
		enc->output_delay = enc->buf_count - 1;
'@)
$anchor = 'config->rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;'
$text = Replace-NvencAnchor $text $anchor ($anchor + @'

		if (enc->codec == CODEC_H264 && !enc->non_texture &&
		    enc->params.tuningInfo == NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY) {
			config->rcParams.vbvBufferSize = config->rcParams.averageBitRate / 10;
			config->rcParams.vbvInitialDelay = config->rcParams.vbvBufferSize;
		}
'@)
$anchor = 'params.forceIDR = 1;'
$text = Replace-NvencAnchor $text $anchor ($anchor + @'

		if (!vbr && enc->codec == CODEC_H264 && !enc->non_texture &&
		    enc->params.tuningInfo == NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY) {
			enc->config.rcParams.vbvBufferSize = enc->config.rcParams.averageBitRate / 10;
			enc->config.rcParams.vbvInitialDelay = enc->config.rcParams.vbvBufferSize;
			params.forceIDR = 0;
		}
'@)
[IO.File]::WriteAllText($source, $text)

$units = @('nvenc-d3d11.c', 'cuda-helpers.c', 'nvenc-compat.c', 'nvenc-cuda.c',
  'nvenc-helpers.c', 'nvenc-opts-parser.c', 'nvenc-properties.c', 'obs-nvenc.c') |
  ForEach-Object { Join-Path $plugin $_ }
$arguments = @('/nologo', '/std:c17', '/O2', '/MD', '/LD', '/utf-8', '/DREGISTER_FFMPEG_IDS',
  '/DNOMINMAX', '/D_CRT_SECURE_NO_WARNINGS', "/I$dist", "/I$ObsSource/libobs", "/I$headers/include",
  "/I$plugin", "/I$ObsSource/shared/opts-parser", "/I$ObsSource/deps/w32-pthreads", "/Fo$out/",
  "/Fe$out/obs-nvenc.dll")
$libraries = @('/link', "$dist/obs.lib", "$dist/w32-pthreads.lib", 'dxgi.lib', 'd3d11.lib')
& cl.exe @arguments @units $source "$ObsSource/shared/opts-parser/opts-parser.c" @libraries
if ($LASTEXITCODE) { throw "OBS NVENC plugin build failed ($LASTEXITCODE)." }

$notices = foreach ($file in Get-ChildItem -LiteralPath "$headers/include/ffnvcodec" -Filter '*.h' | Sort-Object Name) {
  $notice = [regex]::Match([IO.File]::ReadAllText($file.FullName), '\A/\*[\s\S]+?\*/').Value
  if ($notice -notmatch 'Permission is hereby granted') { throw "Missing notice in $($file.Name)." }
  $file.Name
  $notice
  ''
}
$notices | Set-Content -LiteralPath "$out/nv-codec-headers-license.txt"
