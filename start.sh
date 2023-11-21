#!/bin/sh

balena-engine-daemon &

node dist/index.js &

sleep infinity