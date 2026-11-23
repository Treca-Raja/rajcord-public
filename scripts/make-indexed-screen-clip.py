"""Generate a local 1080p60 clip with one checksummed visual ID per frame."""

import argparse
from pathlib import Path
import subprocess

WIDTH, HEIGHT, FPS = 1920, 1080, 60
MARKER_ROWS = 12


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--seconds", type=int, default=30, choices=range(10, 121))
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output already exists")
    encoder = [
        args.ffmpeg, "-hide_banner", "-loglevel", "error", "-n", "-f", "rawvideo",
        "-pixel_format", "gray", "-video_size", f"{WIDTH}x{HEIGHT}", "-framerate",
        str(FPS), "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast",
        "-tune", "zerolatency", "-b:v", "4M", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(args.output.resolve()),
    ]
    with subprocess.Popen(encoder, stdin=subprocess.PIPE) as process:
        for frame in range(args.seconds * FPS):
            checksum = (frame ^ (frame >> 8) ^ (frame >> 16) ^ 0xA5) & 255
            word = frame | (checksum << 24)
            marker = b"".join(bytes([235 if word & (1 << bit) else 16]) * 10 for bit in range(32))
            process.stdin.write((marker + bytes(WIDTH - len(marker))) * MARKER_ROWS)
            left = (frame * 11) % (WIDTH - 200)
            row = b"\x20" * left + b"\xb0" * 200 + b"\x20" * (WIDTH - left - 200)
            process.stdin.write(row * (HEIGHT - MARKER_ROWS))
        process.stdin.close()
        if process.wait():
            raise SystemExit("Could not encode the indexed fixture.")


if __name__ == "__main__":
    main()
