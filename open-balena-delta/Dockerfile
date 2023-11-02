FROM debian:bookworm

RUN apt-get update && apt-get install -y nodejs npm git curl docker-compose

WORKDIR /usr/src/app

COPY . .

RUN npm install typescript -g && \
    npm install --no-fund --no-update-notifier && \
    tsc

CMD ["/bin/sh", "/usr/src/app/start.sh"]