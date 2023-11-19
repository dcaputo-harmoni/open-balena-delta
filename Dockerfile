FROM docker:24.0.7-dind

EXPOSE 80

RUN apk add --update nodejs npm

WORKDIR /usr/src/app

COPY . .

RUN npm install typescript -g && \
    npm install --no-fund --no-update-notifier && \
    tsc

CMD ["/bin/sh", "/usr/src/app/start.sh"]