#!/usr/bin/env bash
# Generates TypeScript message/service code from the Tyto protos using
# protoc + ts-proto.
#
# By default, sources the protos from the Buf Schema Registry
# (buf.build/bonya/tyto) via `buf export`, so this SDK never needs a local
# checkout of the compute repository. Set PROTO_DIR to generate from a local
# checkout instead, e.g. while developing against unpublished proto changes:
#   PROTO_DIR=../../compute/proto npm run proto
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BSR_MODULE="${BSR_MODULE:-buf.build/bonya/tyto}"
PROTO_EXPORT_DIR="$ROOT_DIR/.proto-export"
OUT_DIR="$ROOT_DIR/src/proto"

if [ -z "${PROTO_DIR:-}" ]; then
  if ! command -v buf >/dev/null 2>&1; then
    echo "buf is required on PATH to export $BSR_MODULE (e.g. 'brew install bufbuild/buf/buf')," >&2
    echo "or set PROTO_DIR to a local checkout of proto/ from the compute repository." >&2
    exit 1
  fi
  rm -rf "$PROTO_EXPORT_DIR"
  buf export "$BSR_MODULE" -o "$PROTO_EXPORT_DIR"
  PROTO_DIR="$PROTO_EXPORT_DIR"
fi

if ! command -v protoc >/dev/null 2>&1; then
  echo "protoc is required on PATH (e.g. 'brew install protobuf')." >&2
  exit 1
fi

PROTOC_GEN_TS_PROTO="$ROOT_DIR/node_modules/.bin/protoc-gen-ts_proto"
if [ ! -x "$PROTOC_GEN_TS_PROTO" ]; then
  echo "ts-proto is not installed; run 'npm install' first." >&2
  exit 1
fi

if [ ! -d "$PROTO_DIR/tyto/runtime/v1" ]; then
  echo "PROTO_DIR ($PROTO_DIR) does not contain tyto/runtime/v1 protos." >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

protoc \
  --plugin="protoc-gen-ts_proto=$PROTOC_GEN_TS_PROTO" \
  --proto_path="$PROTO_DIR" \
  --ts_proto_out="$OUT_DIR" \
  --ts_proto_opt=outputServices=grpc-js \
  --ts_proto_opt=esModuleInterop=true \
  --ts_proto_opt=useExactTypes=false \
  --ts_proto_opt=env=node \
  --ts_proto_opt=unrecognizedEnum=false \
  --ts_proto_opt=stringEnums=false \
  --ts_proto_opt=outputIndex=false \
  --ts_proto_opt=importSuffix=.js \
  "$PROTO_DIR/tyto/runtime/v1/guest.proto" \
  "$PROTO_DIR/tyto/runtime/v1/host.proto" \
  "$PROTO_DIR/tyto/runtime/v1/preview.proto" \
  "$PROTO_DIR/tyto/runtime/v1/tapi.proto"

echo "Generated TypeScript proto code in $OUT_DIR"
