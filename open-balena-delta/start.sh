#!/bin/sh

docker pull deltaimage/deltaimage:0.1.0

node dist/index.js &

sleep infinity