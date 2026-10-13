const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'assests', 'logo.png.PNG');
const targetDir = path.join(root, 'public', 'images');

fs.mkdirSync(targetDir, { recursive: true });

async function buildAssets() {
  const img = sharp(sourcePath);
  const metadata = await img.metadata();

  await img.clone().toFile(path.join(targetDir, 'logo-original.png'));
  await img.clone().resize({ width: 1100, withoutEnlargement: true }).toFormat('webp').toFile(path.join(targetDir, 'logo.webp'));
  await img.clone().resize({ width: 512, withoutEnlargement: true }).png().toFile(path.join(targetDir, 'logo.png'));
  await img.clone().resize({ width: 128, height: 128, fit: 'contain' }).toFormat('png').toFile(path.join(targetDir, 'favicon-128.png'));
  await img.clone().resize({ width: 64, height: 64, fit: 'contain' }).toFormat('png').toFile(path.join(targetDir, 'favicon-64.png'));
  await img.clone().resize({ width: 180, height: 180, fit: 'contain' }).toFormat('png').toFile(path.join(targetDir, 'apple-touch-icon.png'));
  await img.clone().resize({ width: 32, height: 32, fit: 'contain' }).toFormat('png').toFile(path.join(targetDir, 'favicon-32.png'));

  console.log('Prepared assets:', { width: metadata.width, height: metadata.height, dir: targetDir });
}

buildAssets().catch((error) => {
  console.error('Asset preparation failed:', error);
  process.exit(1);
});
