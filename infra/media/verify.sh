#!/bin/sh
set -eu
case "$(apk --print-arch)" in
  aarch64) expected=c9673a510eedc733101481aabb420f434eddcaec2b50d4f8aca32e7fd652cbf9 ;;
  x86_64) expected=c5b305d611f0c586a71db13734db6ef7a84747ffca88a0ab95edbfc954bdee2b ;;
  *) exit 1 ;;
esac
echo "$expected  /usr/bin/ffmpeg" | sha256sum -c >/dev/null
ffmpeg -version | grep -q '^ffmpeg version 8\.1\.3 '
if [ "${1:-}" = runtime ]; then
  [ "$(id -u)" -eq 65534 ]
  [ -z "${MATRACA_MEDIA_TEST_MARKER:-}" ]
  [ "$(wc -l < /proc/net/route)" -eq 1 ]
  awk '$2=="/" && $4 ~ /^ro(,|$)/ { found=1 } END { exit !found }' /proc/mounts
fi
printf '%s\n' 'FFmpeg 8.1.3 verificado'
