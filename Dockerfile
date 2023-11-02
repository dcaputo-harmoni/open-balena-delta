FROM debian:bookworm as build

RUN apt-get update && apt-get install -y git cargo libclang-dev

WORKDIR /usr/src/app

RUN git clone --quiet https://github.com/da-x/deltaimage.git

WORKDIR /usr/src/app/deltaimage

RUN ./run build-small-static-exe

FROM debian:bookworm

EXPOSE 80

RUN apt-get update && apt-get install -y nodejs npm buildah

WORKDIR /usr/src/app

COPY --from=build /usr/src/app/deltaimage/target/x86_64-unknown-linux-gnu/release-lto/deltaimage /usr/local/bin

COPY . .

RUN npm install typescript -g && \
    npm install --no-fund --no-update-notifier && \
    tsc

CMD ["/bin/sh", "/usr/src/app/start.sh"]