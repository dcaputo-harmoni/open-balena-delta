FROM alpine:3.18

RUN apk add --no-cache \
    btrfs-progs \
    e2fsprogs \
    e2fsprogs-extra \
    ip6tables \
    iptables \
    openssl \
    shadow-uidmap \
    xfsprogs \
    xz \
    pigz \
    zfs \
    nodejs \
    npm \
    rsync

# Install Docker CLI
ENV DOCKER_CLI_VERSION="24.0.7"
RUN wget -O /tmp/docker-cli.tar.gz "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" && \
    tar -xvzf /tmp/docker-cli.tar.gz -C /usr/local/bin --strip-components 1 && \
    chmod +x /usr/local/bin/docker

# Install balena-engine
ENV BALENA_ENGINE_VERSION="20.10.40"
RUN wget -O /tmp/balena-engine.tar.gz "https://github.com/balena-os/balena-engine/releases/download/v${BALENA_ENGINE_VERSION}/balena-engine-v${BALENA_ENGINE_VERSION}-amd64.tar.gz" && \
    tar -xvzf /tmp/balena-engine.tar.gz -C /usr/local/bin && \
    chmod +x /usr/local/bin/balena*

RUN addgroup -S balena-engine

# Storage for balena-engine and delta-rsync binaries
VOLUME /var/lib/balena-engine
VOLUME /delta-rsync

COPY balena-engine/daemon.json /etc/balena-engine/daemon.json

WORKDIR /usr/src/app

COPY . .

RUN npm install typescript -g && \
    npm install --no-fund --no-update-notifier && \
    tsc

CMD ["/bin/sh", "/usr/src/app/start.sh"]