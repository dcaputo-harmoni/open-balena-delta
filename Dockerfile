FROM docker:24.0.7-dind-alpine3.18

RUN apk add --update nodejs npm

CMD ["sleep", "infinity"]