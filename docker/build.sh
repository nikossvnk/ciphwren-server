#! /bin/bash

# Build the `test-server` image, which runs the server in a simple configuration
# designed to be used in tests, based on the current git revision.

TAG="${1:-latest}"

echo "Building working copy to ciphwren-server/test-server:${TAG}"

CIPHWREN_VERSION=$(git describe --tags)

docker build \
    --build-arg CIPHWREN_VERSION=${CIPHWREN_VERSION} \
    -t ciphwren-server/test-server:${TAG} \
    -f docker/test-server/Dockerfile \
    .
