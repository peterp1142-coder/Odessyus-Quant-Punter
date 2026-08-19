#!/bin/bash
set -e

echo "Installing dependencies..."
npm install

echo "Installing Chrome for Puppeteer..."
npx puppeteer browsers install chrome

echo "Copying Chrome to persistent directory..."
mkdir -p /opt/render/project/.chrome
cp -r /opt/render/.cache/puppeteer/chrome /opt/render/project/.chrome/

echo "Chrome copied successfully!"
ls -la /opt/render/project/.chrome/
