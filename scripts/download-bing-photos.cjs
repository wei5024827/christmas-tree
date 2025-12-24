#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUTPUT_DIR = path.resolve(__dirname, '../public/photos');
const TARGET_COUNT = 50;
const MAX_BYTES = 500 * 1024;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MARKETS = [
  'zh-CN', 'en-US', 'en-GB', 'ja-JP', 'de-DE', 'fr-FR', 'it-IT', 'es-ES', 'pt-BR', 'pt-PT',
  'ko-KR', 'zh-TW', 'ru-RU', 'nl-NL', 'sv-SE', 'da-DK', 'fi-FI', 'no-NO', 'pl-PL', 'tr-TR',
  'th-TH', 'id-ID', 'vi-VN', 'hi-IN', 'ar-SA', 'he-IL', 'cs-CZ', 'hu-HU', 'el-GR', 'ro-RO',
  'uk-UA', 'bg-BG'
];
const BATCH_SIZE = 1;
const SIZE_CANDIDATES = ['800x600', '640x480', '400x240'];
const MAX_FETCH_DAYS = 8;

const fetchJson = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Request failed: ${res.statusCode}`));
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });

const downloadWithLimit = (url, dest, maxBytes) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ ok: false, reason: `status:${res.statusCode}` });
          return;
        }
        const lengthHeader = res.headers['content-length'];
        if (lengthHeader && Number(lengthHeader) > maxBytes) {
          res.resume();
          resolve({ ok: false, reason: 'too-large' });
          return;
        }
        const chunks = [];
        let total = 0;
        let aborted = false;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            aborted = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) {
            resolve({ ok: false, reason: 'too-large' });
            return;
          }
          fs.writeFile(dest, Buffer.concat(chunks), (err) => {
            if (err) reject(err);
            else resolve({ ok: true, bytes: total });
          });
        });
      })
      .on('error', reject);
  });

const buildArchiveUrl = (idx, n, market) =>
  `https://www.bing.com/HPImageArchive.aspx?format=js&idx=${idx}&n=${n}&mkt=${market}`;

const buildImageUrl = (urlBase, size) =>
  `https://www.bing.com${urlBase}_${size}.jpg`;

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

const extractImages = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload.images)) return payload.images;
  return [];
};

const compressToLimit = async (filePath, maxBytes) => {
  const inputBuffer = fs.readFileSync(filePath);
  let meta;
  try {
    meta = await sharp(inputBuffer).metadata();
  } catch (err) {
    return false;
  }
  const width = meta.width || 0;
  const candidates = [width, 1000, 900, 800, 700, 640, 560, 480, 400]
    .filter((w) => w > 0 && w <= width)
    .filter((w, idx, arr) => arr.indexOf(w) === idx);
  const qualities = [80, 70, 60, 55, 50, 45, 40, 35];

  for (const targetWidth of candidates) {
    for (const quality of qualities) {
      const outputBuffer = await sharp(inputBuffer)
        .resize({ width: targetWidth, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (outputBuffer.length <= maxBytes) {
        fs.writeFileSync(filePath, outputBuffer);
        return true;
      }
    }
  }
  return false;
};

const main = async () => {
  ensureDir(OUTPUT_DIR);

const images = [];
  const seen = new Set();
  let idx = 0;

  while (images.length < TARGET_COUNT && idx < MAX_FETCH_DAYS) {
    for (const market of MARKETS) {
      let payload;
      try {
        payload = await fetchJson(buildArchiveUrl(idx, BATCH_SIZE, market));
      } catch (err) {
        console.error(`Archive fetch failed at idx=${idx} market=${market}:`, err.message);
        continue;
      }

      const items = extractImages(payload);
      if (items.length === 0) continue;

      for (const item of items) {
        const url = item.url ? `https://www.bing.com${item.url}` : null;
        const urlBase = item.urlbase || null;
        if (!url) continue;
        const dedupeKey = urlBase || url;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        images.push({ url, urlBase });
        if (images.length >= TARGET_COUNT) break;
      }
      if (images.length >= TARGET_COUNT) break;
    }

    idx += BATCH_SIZE;
  }

  if (images.length === 0) {
    console.error('No images found from Bing archive.');
    process.exit(1);
  }

  if (images.length < TARGET_COUNT) {
    const original = images.slice();
    while (images.length < TARGET_COUNT) {
      images.push(original[images.length % original.length]);
    }
  }

  let saved = 0;
  for (let i = 0; i < images.length && saved < TARGET_COUNT; i += 1) {
    const { url, urlBase } = images[i];
    const outPath = path.join(OUTPUT_DIR, `${saved + 1}.jpg`);
    let stored = false;

    const candidates = [url, ...SIZE_CANDIDATES.map((size) => buildImageUrl(urlBase, size))];
    for (const imageUrl of candidates) {
      try {
        const result = await downloadWithLimit(imageUrl, outPath, MAX_DOWNLOAD_BYTES);
        if (result.ok) {
          const stats = fs.statSync(outPath);
          if (stats.size > MAX_BYTES) {
            const compressed = await compressToLimit(outPath, MAX_BYTES);
            if (!compressed) {
              fs.unlinkSync(outPath);
              continue;
            }
          }
          stored = true;
          saved += 1;
          console.log(`Saved ${saved}/${TARGET_COUNT}: ${imageUrl}`);
          break;
        }
      } catch (err) {
        console.warn(`Download failed: ${imageUrl}: ${err.message}`);
      }
    }

    if (!stored) {
      console.warn(`Skipped (too large or unavailable): ${urlBase}`);
    }
  }

  console.log(`Finished. Saved ${saved} images to ${OUTPUT_DIR}`);
  if (saved < TARGET_COUNT) {
    console.log(`Only ${saved} images met the size limit of ${MAX_BYTES} bytes.`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
