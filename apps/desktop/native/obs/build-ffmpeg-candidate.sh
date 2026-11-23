#!/bin/sh
# Builds a Windows x64 candidate for the licensing audit in a disposable Linux
# builder with mingw-w64 gcc/binutils, make and nasm. The installer does not use it.
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: sh $0 /absolute/ffmpeg-8.1.2.tar.xz /absolute/output" >&2
  exit 1
fi
source_archive=$1
destination=$2
build=$(mktemp -d)
trap 'rm -rf -- "$build"' EXIT HUP INT TERM
tar -xJf "$source_archive" -C "$build"
cd "$build/ffmpeg-8.1.2"
./configure \
  --prefix="$build/install" \
  --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- \
  --enable-shared --disable-static --enable-w32threads --disable-pthreads \
  --disable-autodetect --disable-gpl --disable-version3 --disable-nonfree \
  --disable-libx264 --disable-programs --disable-doc || {
  mkdir -p "$destination"
  cp ffbuild/config.log "$destination/configure-failed.log"
  exit 1
}
make -j"${FFMPEG_BUILD_JOBS:-2}"
make install
mkdir -p "$destination"
cp "$build"/install/bin/*.dll "$destination/"
pthread_runtime=$(x86_64-w64-mingw32-gcc -print-file-name=libwinpthread-1.dll)
if [ -f "$pthread_runtime" ]; then
  cp "$pthread_runtime" "$destination/"
fi
cp config.h ffbuild/config.log config_components.h COPYING.LGPLv2.1 LICENSE.md "$destination/"
(cd "$destination" && sha256sum ./*.dll > binary-sha256.txt)
