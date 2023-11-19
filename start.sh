#!/bin/sh

# Launch docker daemon (necessary because we are overriding the dind entrypoint)
docker-entrypoint.sh dockerd &

node dist/index.js &

sleep infinity