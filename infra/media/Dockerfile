FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache ffmpeg=8.1.3-r0
COPY --chmod=0555 verify.sh /usr/local/bin/verify-media
COPY --chmod=0555 decode.sh /usr/local/bin/decode-media
RUN /usr/local/bin/verify-media
USER 65534:65534
ENTRYPOINT ["/bin/busybox", "timeout", "-s", "KILL", "55", "/usr/local/bin/decode-media"]
