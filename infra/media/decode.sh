#!/bin/sh
set -eu
cd /work
duration=$2
case "$1" in
  wav) demuxer=wav ;;
  mp3) demuxer=mp3 ;;
  mp4) demuxer=mov ;;
  webm) demuxer=matroska ;;
  *) exit 2 ;;
esac
case "$duration" in ''|*[!0-9]*) exit 2 ;; esac
[ "$duration" -gt 0 ] && [ "$duration" -le 300000000 ] || exit 2
cat > input
chmod 400 input
codecs=vorbis,opus,aac,mp3,mp3float,flac,ac3,ac3_fixed,eac3,dca,truehd,h264,hevc,vp8,vp9,av1,libdav1d,prores,pcm_u8,pcm_s8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_alaw,pcm_mulaw
seconds() { printf '%d.%06d' "$(($1 / 1000000))" "$(($1 % 1000000))"; }
decode() {
  start=$1
  shift
  ffmpeg -y -nostdin -hide_banner -loglevel error -max_alloc 67108864 -filter_threads 1 -threads 1 \
    -protocol_whitelist file,pipe -codec_whitelist "$codecs" -f "$demuxer" -ss "$(seconds "$start")" -i input "$@"
}
emit() {
  printf '%s:%d:%d:%d\n' "$1" "$2" "$3" "$(wc -c < "$4")"
  cat "$4"
}
if [ "$3" = 1 ]; then
  start=0
  while [ "$start" -lt "$duration" ]; do
    end=$((start + 60000000))
    if [ "$end" -gt "$duration" ]; then end=$duration; fi
    decode "$start" -t "$(seconds "$((end - start))")" -map 0:a:0 -vn -sn -dn \
      -ac 1 -ar 16000 -c:a pcm_s16le -threads 1 clip.wav
    size=$(wc -c < clip.wav)
    [ "$size" -le 2000000 ] || exit 3
    if [ "$size" -gt 100 ]; then emit audio "$start" "$end" clip.wav; fi
    start=$end
  done
fi
if [ "$4" = 1 ]; then
  count=$(((duration + 4999999) / 5000000))
  if [ "$count" -gt 12 ]; then count=12; fi
  index=0
  while [ "$index" -lt "$count" ]; do
    start=$((duration * (2 * index + 1) / (2 * count)))
    rm -f frame.jpg
    decode "$start" -map 0:v:0 -an -sn -dn -frames:v 1 \
      -vf 'scale=512:512:force_original_aspect_ratio=decrease' -q:v 4 -threads 1 frame.jpg
    if [ -s frame.jpg ]; then
      end=$((start + 1000000))
      if [ "$end" -gt "$duration" ]; then end=$duration; fi
      [ "$(wc -c < frame.jpg)" -le 512000 ] || exit 3
      ffmpeg -y -nostdin -hide_banner -loglevel error -max_alloc 67108864 -filter_threads 1 -threads 1 \
        -protocol_whitelist file,pipe -i frame.jpg -vf 'scale=32:32,format=rgb24' -frames:v 1 -f rawvideo sample.rgb
      [ "$(wc -c < sample.rgb)" -eq 3072 ] || exit 3
      cat sample.rgb frame.jpg > frame.packet
      emit frame "$start" "$end" frame.packet
    fi
    index=$((index + 1))
  done
fi
