import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { join } from 'path';

const rootDir = join(import.meta.dirname, '..');
const publicDir = join(rootDir, 'public');
const tauriIconsDir = join(rootDir, 'src-tauri', 'icons');

// Globe icon as SVG - earth-like sphere with meridians and parallels
const svgIcon = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <radialGradient id="sphere" cx="40%" cy="35%" r="50%">
      <stop offset="0%" stop-color="#4FC3F7"/>
      <stop offset="60%" stop-color="#1565C0"/>
      <stop offset="100%" stop-color="#0D2137"/>
    </radialGradient>
    <radialGradient id="shine" cx="35%" cy="30%" r="45%">
      <stop offset="0%" stop-color="white" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="clip">
      <circle cx="${size/2}" cy="${size/2}" r="${size*0.44}"/>
    </clipPath>
  </defs>
  <!-- Background circle -->
  <circle cx="${size/2}" cy="${size/2}" r="${size*0.46}" fill="#0a1628"/>
  <!-- Globe body -->
  <circle cx="${size/2}" cy="${size/2}" r="${size*0.44}" fill="url(#sphere)"/>
  <!-- Grid lines (meridians & parallels) -->
  <g clip-path="url(#clip)" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="${Math.max(1, size*0.012)}">
    <!-- Equator -->
    <ellipse cx="${size/2}" cy="${size/2}" rx="${size*0.44}" ry="${size*0.06}"/>
    <!-- Parallels -->
    <ellipse cx="${size/2}" cy="${size*0.33}" rx="${size*0.35}" ry="${size*0.05}"/>
    <ellipse cx="${size/2}" cy="${size*0.67}" rx="${size*0.35}" ry="${size*0.05}"/>
    <!-- Central meridian -->
    <ellipse cx="${size/2}" cy="${size/2}" rx="${size*0.06}" ry="${size*0.44}"/>
    <!-- Side meridians -->
    <ellipse cx="${size*0.37}" cy="${size/2}" rx="${size*0.04}" ry="${size*0.42}"/>
    <ellipse cx="${size*0.63}" cy="${size/2}" rx="${size*0.04}" ry="${size*0.42}"/>
  </g>
  <!-- Simplified land masses -->
  <g clip-path="url(#clip)" fill="rgba(76,175,80,0.5)" stroke="none">
    <!-- Americas-like shape -->
    <path d="M${size*0.38} ${size*0.22} Q${size*0.42} ${size*0.25} ${size*0.40} ${size*0.32} Q${size*0.36} ${size*0.36} ${size*0.38} ${size*0.40} Q${size*0.42} ${size*0.48} ${size*0.38} ${size*0.55} Q${size*0.35} ${size*0.62} ${size*0.37} ${size*0.70} Q${size*0.35} ${size*0.65} ${size*0.33} ${size*0.58} Q${size*0.32} ${size*0.50} ${size*0.34} ${size*0.42} Q${size*0.33} ${size*0.35} ${size*0.35} ${size*0.28} Z"/>
    <!-- Europe/Africa-like shape -->
    <path d="M${size*0.52} ${size*0.25} Q${size*0.56} ${size*0.28} ${size*0.58} ${size*0.34} Q${size*0.60} ${size*0.40} ${size*0.57} ${size*0.48} Q${size*0.55} ${size*0.55} ${size*0.56} ${size*0.62} Q${size*0.54} ${size*0.58} ${size*0.53} ${size*0.50} Q${size*0.52} ${size*0.42} ${size*0.54} ${size*0.34} Q${size*0.52} ${size*0.30} ${size*0.50} ${size*0.27} Z"/>
  </g>
  <!-- Specular highlight -->
  <circle cx="${size/2}" cy="${size/2}" r="${size*0.44}" fill="url(#shine)"/>
  <!-- Outer ring -->
  <circle cx="${size/2}" cy="${size/2}" r="${size*0.44}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="${Math.max(1, size*0.015)}"/>
</svg>`;

async function generatePng(size, outPath) {
  const buf = Buffer.from(svgIcon(size));
  const png = await sharp(buf).png().toBuffer();
  writeFileSync(outPath, png);
  console.log(`  ${outPath.split('/').slice(-2).join('/')} (${size}x${size})`);
}

// --- Web icons (public/) ---
console.log('Web icons:');
const webIcons = [
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'favicon-32.png', size: 32 },
  { name: 'favicon-16.png', size: 16 },
];
for (const { name, size } of webIcons) {
  await generatePng(size, join(publicDir, name));
}
writeFileSync(join(publicDir, 'favicon.svg'), svgIcon(32));
console.log('  public/favicon.svg');

// --- Desktop icons (src-tauri/icons/) ---
console.log('Desktop icons:');
const tauriIcons = [
  { name: '32x32.png', size: 32 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
];
for (const { name, size } of tauriIcons) {
  await generatePng(size, join(tauriIconsDir, name));
}

// Generate ICO (contains 16, 32, 48, 256 sizes)
// sharp doesn't support ICO natively, so we build a minimal ICO file
async function generateIco(outPath) {
  const icoSizes = [16, 32, 48, 256];
  const pngBuffers = [];
  for (const size of icoSizes) {
    const buf = Buffer.from(svgIcon(size));
    pngBuffers.push(await sharp(buf).png().toBuffer());
  }

  // ICO header: 2 reserved + 2 type (1=ICO) + 2 count
  const headerSize = 6;
  const dirEntrySize = 16;
  const numImages = pngBuffers.length;
  let dataOffset = headerSize + dirEntrySize * numImages;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);       // reserved
  header.writeUInt16LE(1, 2);       // type: ICO
  header.writeUInt16LE(numImages, 4);

  const dirEntries = [];
  for (let i = 0; i < numImages; i++) {
    const entry = Buffer.alloc(dirEntrySize);
    const s = icoSizes[i];
    entry.writeUInt8(s >= 256 ? 0 : s, 0);   // width (0 = 256)
    entry.writeUInt8(s >= 256 ? 0 : s, 1);   // height
    entry.writeUInt8(0, 2);                    // color palette
    entry.writeUInt8(0, 3);                    // reserved
    entry.writeUInt16LE(1, 4);                 // color planes
    entry.writeUInt16LE(32, 6);                // bits per pixel
    entry.writeUInt32LE(pngBuffers[i].length, 8);  // size
    entry.writeUInt32LE(dataOffset, 12);            // offset
    dataOffset += pngBuffers[i].length;
    dirEntries.push(entry);
  }

  writeFileSync(outPath, Buffer.concat([header, ...dirEntries, ...pngBuffers]));
  console.log(`  src-tauri/icons/icon.ico`);
}
await generateIco(join(tauriIconsDir, 'icon.ico'));

// Generate ICNS (minimal format with ic08 = 256x256 PNG entry)
async function generateIcns(outPath) {
  const svg = Buffer.from(svgIcon(256));
  const png256 = await sharp(svg).png().toBuffer();

  const entryDataLen = 8 + png256.length;
  const fileLen = 8 + entryDataLen;
  const header = Buffer.alloc(8);
  header.write('icns', 0);
  header.writeUInt32BE(fileLen, 4);
  const entryHeader = Buffer.alloc(8);
  entryHeader.write('ic08', 0);
  entryHeader.writeUInt32BE(entryDataLen, 4);

  writeFileSync(outPath, Buffer.concat([header, entryHeader, png256]));
  console.log(`  src-tauri/icons/icon.icns`);
}
await generateIcns(join(tauriIconsDir, 'icon.icns'));

// Also generate a 1024px source PNG (useful for higher-res .icns via `sips` on macOS CI)
await generatePng(1024, join(tauriIconsDir, 'icon-1024.png'));

console.log('Done!');
