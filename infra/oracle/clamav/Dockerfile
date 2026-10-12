# Official Alpine multi-architecture index; reviewed ARM64 distribution packages.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates clamav-daemon=1.4.6-r0 clamav-clamdscan=1.4.6-r0 freshclam=1.4.6-r0 clamav-doc=1.4.6-r0 && addgroup -g 3000 onesascan && addgroup clamav onesascan && mkdir -p /var/lib/clamav /run/onesa-scanner && chown -R clamav:clamav /var/lib/clamav && chown clamav:onesascan /run/onesa-scanner && chmod 2770 /run/onesa-scanner
COPY clamd.conf freshclam.conf /etc/clamav/
COPY start.sh /usr/local/bin/onesa-clamav
COPY health.sh /usr/local/bin/onesa-scanner-health
RUN chmod 0555 /usr/local/bin/onesa-clamav /usr/local/bin/onesa-scanner-health
USER clamav
VOLUME /var/lib/clamav
ENTRYPOINT ["/usr/local/bin/onesa-clamav"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 CMD /usr/local/bin/onesa-scanner-health
