FROM ghcr.io/dkta-labs/npm-resolver@sha256:2325ccfef8e9db2b1ad0ccf3db1fa228ae4b271ff6eff21dcfc572429d3c20c4
LABEL org.opencontainers.image.source="https://github.com/dkta-labs/extract"

ARG NPM_CONFIG_MIN_RELEASE_AGE
ARG NPM_CONFIG_ALLOW_GIT
ARG NPM_CONFIG_ALLOW_REMOTE
ARG NPM_CONFIG_SAVE_EXACT
RUN test "$NPM_CONFIG_MIN_RELEASE_AGE" = "3" \
    && test "$NPM_CONFIG_ALLOW_GIT" = "none" \
    && test "$NPM_CONFIG_ALLOW_REMOTE" = "none" \
    && test "$NPM_CONFIG_SAVE_EXACT" = "true" \
    && test "$(npm --version)" = "12.0.2"

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm config set allow-git none --location=user \
    && npm config set allow-remote none --location=user \
    && npm config set min-release-age 3 --location=user \
    && npm config set save-exact true --location=user \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && chown -R 65532:65532 /workspace/node_modules \
    && rm -rf /root/.npm /tmp/*
RUN mkdir /capsule-tmp /capsule-root-ro \
    && chown 65532:65532 /capsule-tmp /capsule-root-ro

ENV NODE_ENV=test
