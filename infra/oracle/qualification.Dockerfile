# Credential-free, disposable owner tool; never an application runtime service.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS node
FROM ubuntu:26.04@sha256:c098726dd9b9733f3e885f8de0ef375206a311b0a317eadc40d347b1115fb944 AS complete
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates python3 xvfb xauth && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /tmp/npm
WORKDIR /opt/onesa-company-portal
COPY onesa-company-portal-frontend/package.json onesa-company-portal-frontend/package-lock.json ./onesa-company-portal-frontend/
COPY onesa-company-portal-frontend/vendor ./onesa-company-portal-frontend/vendor
RUN node /tmp/npm/bin/npm-cli.js ci --ignore-scripts --prefix onesa-company-portal-frontend && node onesa-company-portal-frontend/node_modules/playwright/cli.js install --with-deps chromium firefox webkit && ln -s onesa-company-portal-frontend/node_modules node_modules && rm -rf /tmp/npm /root/.npm /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /opt/yarn-* && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
# The explicit Node/Python probe never starts the base image's service manager.
# Remove that unused Go executable rather than carrying its vulnerable runtime.
RUN rm -f /usr/bin/pebble
COPY scripts/release ./scripts/release
COPY scripts/check_tls_bundle.mjs ./scripts/check_tls_bundle.mjs
COPY scripts/oracle_backup_store.mjs ./scripts/oracle_backup_store.mjs
COPY onesa-company-portal-frontend/public/models/nvidia/manifest.json ./onesa-company-portal-frontend/public/models/nvidia/manifest.json
COPY onesa-company-portal-frontend/src/config/nvidia-reference-assets.json ./onesa-company-portal-frontend/src/config/nvidia-reference-assets.json
COPY onesa-company-portal-frontend/public/licenses/three.txt ./onesa-company-portal-frontend/public/licenses/three.txt
# Remove build history/tooling from the final host-mounted credential boundary.
FROM scratch
COPY --from=complete / /
WORKDIR /opt/onesa-company-portal
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ARG SOURCE_COMMIT
ARG SOURCE_ARCHIVE_SHA256
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT org.onesa.source-archive-sha256=$SOURCE_ARCHIVE_SHA256 org.onesa.browser="Playwright locked Chromium Firefox WebKit"
ENTRYPOINT ["node","/opt/onesa-company-portal/scripts/release/oracle_portal_browser.mjs"]
