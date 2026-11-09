FROM golang@sha256:2920bb124f1a2e12a1d39f0cab756ae0068441ee1da7655dec7f5e374944095b
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libseccomp-dev=2.6.0-2 libselinux1-dev=3.8.1-1 \
      libbtrfs-dev=6.14-1 zstd=1.5.7+dfsg-1 \
      zlib1g-dev=1:1.3.dfsg+really1.3.1-1+b1 \
 && dpkg-query -W -f='${Package}=${Version}\n' > /usr/local/share/onesa-k3s-builder-packages.txt \
 && rm -rf /var/lib/apt/lists/*
