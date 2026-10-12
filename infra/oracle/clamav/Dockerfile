# The official ClamAV stable_base index inspected on 2026-10-12 is AMD64-only.
# Debian's signed maintained packages provide a native ARM64 daemon and updater.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
RUN apt-get update && apt-get upgrade -y && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y ca-certificates clamav-daemon clamav-freshclam clamdscan && rm -rf /var/lib/apt/lists/* && groupadd -g 3000 onesascan && usermod -a -G onesascan clamav && mkdir -p /var/lib/clamav /run/onesa-scanner && chown -R clamav:clamav /var/lib/clamav && chown clamav:onesascan /run/onesa-scanner && chmod 2770 /run/onesa-scanner
COPY clamd.conf freshclam.conf /etc/clamav/
COPY start.sh /usr/local/bin/onesa-clamav
COPY health.sh /usr/local/bin/onesa-scanner-health
RUN chmod 0555 /usr/local/bin/onesa-clamav /usr/local/bin/onesa-scanner-health
USER clamav
VOLUME /var/lib/clamav
ENTRYPOINT ["/usr/local/bin/onesa-clamav"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 CMD /usr/local/bin/onesa-scanner-health
