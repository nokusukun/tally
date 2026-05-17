#!/usr/bin/env node
// Renders public/icon.svg into the PNG sizes the PWA + favicon need.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const src = path.join(root, 'public', 'icon.svg');
const pwaDir = path.join(root, 'public', 'icons');
const buildDir = path.join(root, 'build');

const pwaSizes = {
  'icon-192.png': 192,
  'icon-512.png': 512,
  'icon-1024.png': 1024,
  'apple-touch-icon.png': 180,
  'favicon-32.png': 32,
  'favicon-64.png': 64,
};

// electron-builder reads build/icon.png and auto-derives .ico / .icns at build
// time on the matching runner (Windows uses ico-maker, macOS shells out to
// iconutil). 1024×1024 is the size electron-builder recommends.
const builderSize = 1024;

async function render(svg, size, dest) {
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toFile(dest);
}

(async () => {
  if (!fs.existsSync(src)) throw new Error('Missing source SVG: ' + src);
  if (!fs.existsSync(pwaDir)) fs.mkdirSync(pwaDir, { recursive: true });
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
  const svg = fs.readFileSync(src);

  await Promise.all(
    Object.entries(pwaSizes).map(async ([name, size]) => {
      await render(svg, size, path.join(pwaDir, name));
      console.log('  •', name, size + 'px');
    })
  );
  console.log('PWA icons →', path.relative(root, pwaDir));

  await render(svg, builderSize, path.join(buildDir, 'icon.png'));
  console.log('build/icon.png', builderSize + 'px (electron-builder auto-converts to ico/icns)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
