#!/bin/bash
set -e

SDK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "📦 Building @bonya-ai/tyto (TypeScript)..."
npm run build

echo "✅ Publishing @bonya-ai/tyto to npm..."
npm publish --access public --otp="$1"

echo "🎉 @bonya-ai/tyto deployed successfully!"
