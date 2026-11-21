#!/usr/bin/env bash
set -euo pipefail

# Run from the checkout with Docker available. The generated WASM is a vendored web asset.
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"

curl --fail --location --silent --show-error \
  https://codeload.github.com/xiph/rnnoise/tar.gz/refs/tags/v0.2 -o source.tar.gz
curl --fail --location --silent --show-error \
  https://media.xiph.org/rnnoise/models/rnnoise_data-0b50c45.tar.gz -o model.tar.gz
sha256sum --check <<'HASHES'
e4a17eb1493b7551f9f7781d2acc67b8847d6ed7c4b64db0fd62c017021ae1ec  source.tar.gz
4ac81c5c0884ec4bd5907026aaae16209b7b76cd9d7f71af582094a2f98f4b43  model.tar.gz
HASHES
tar -xf source.tar.gz
tar -xf model.tar.gz -C rnnoise-0.2 src/rnnoise_data_little.c src/rnnoise_data_little.h
cp rnnoise-0.2/src/rnnoise_data_little.h rnnoise-0.2/src/rnnoise_data.h
# v0.2's portable kernel refers to an Opus header/macro absent from RNNoise.
sed -i -e 's/"os_support.h"/"common.h"/' -e 's/OPUS_CLEAR/RNN_CLEAR/g' rnnoise-0.2/src/vec.h

docker run --rm --platform linux/amd64 \
  --volume "$work:/build" --workdir /build/rnnoise-0.2 \
  emscripten/emsdk@sha256:86537645c51e44899812d29820ee3b64b96c321ebb2aba4416a04ceeb1bcde62 \
  emcc -O3 -msimd128 --no-entry -Iinclude -Isrc \
  -s STANDALONE_WASM=1 -s ALLOW_MEMORY_GROWTH=0 -s STACK_SIZE=524288 -s INITIAL_MEMORY=4194304 \
  -s EXPORTED_FUNCTIONS=_rnnoise_create,_rnnoise_get_frame_size,_rnnoise_process_frame,_malloc \
  src/denoise.c src/rnn.c src/pitch.c src/kiss_fft.c src/celt_lpc.c src/nnet.c \
  src/nnet_default.c src/parse_lpcnet_weights.c src/rnnoise_data_little.c src/rnnoise_tables.c \
  -o /build/rnnoise.wasm
cp rnnoise.wasm "$root/apps/web/src/features/voice/rnnoise.wasm"
