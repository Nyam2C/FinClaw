#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${1:-finclaw}"
TAG="${2:-dev}"

echo "Building ${IMAGE_NAME}:${TAG} ..."
docker build -t "${IMAGE_NAME}:${TAG}" .
echo "Done. Run with: docker run -p 3000:3000 ${IMAGE_NAME}:${TAG}"
