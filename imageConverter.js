const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

// name + digits + extension
const SEQ_REGEX = /^(.*?)(\d+)\.(png|jpg|jpeg)$/i;

// ---- TIMING CONSTANTS ----
const GAME_FPS = 60;
const MIN_LOGICAL_FPS = 0.1;     // lowest supported sprite FPS
const MAX_HOLD_FRAMES = 600;     // max hold = 10 seconds @ 60fps
const DISABLE_PINGPONG_BELOW = 1; // fps threshold

class ImageConverter {
  sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9]+$/, '').trim();
  }

  // ---------------- SPRITE DATA ----------------

  async collectSpritesWithData(pluginDir, parsedData) {
    const sprites = [];

    const extract = (item) => {
      const out = [];
      if (item.sprite) {
        out.push({
          path: item.sprite,
          spriteData: item.spriteData || null
        });
      }
      if (item.weapon?.sprite) {
        out.push({
          path: item.weapon.sprite,
          spriteData: item.weapon.spriteData || null
        });
      }
      return out;
    };

    parsedData.ships?.forEach(s => sprites.push(...extract(s)));
    parsedData.variants?.forEach(v => sprites.push(...extract(v)));
    parsedData.outfits?.forEach(o => sprites.push(...extract(o)));

    return sprites;
  }

  getFrameRate(spriteData) {
    if (!spriteData) return null;
    if (spriteData['frame rate']) return parseFloat(spriteData['frame rate']);
    if (spriteData['frame time']) {
      const ft = parseFloat(spriteData['frame time']);
      return ft > 0 ? 60 / ft : null;
    }
    return null;
  }

  buildSpriteDataMap(sprites) {
    const map = new Map();
    for (const s of sprites) {
      const key = s.path.replace(/\\/g, '/').replace(/\.(png|jpg|jpeg)$/i, '');
      const fps = this.getFrameRate(s.spriteData);
      if (fps) map.set(key, fps);
    }
    return map;
  }

  findFrameRateForImage(imagePath, imagesRoot, spriteDataMap) {
    const rel = path
      .relative(imagesRoot, imagePath)
      .replace(/\\/g, '/')
      .replace(/\.(png|jpg|jpeg)$/i, '')
      .replace(/[-+]\d+$/, '');

    return spriteDataMap.get(rel) || null;
  }

  // ---------------- SEQUENCE GENERATION ----------------

  generateSequence(seqFiles, logicalFps) {
    const sorted = [...seqFiles].sort((a, b) => {
      const na = parseInt(a.match(SEQ_REGEX)[2], 10);
      const nb = parseInt(b.match(SEQ_REGEX)[2], 10);
      return na - nb;
    });

    const fps = Math.max(logicalFps, MIN_LOGICAL_FPS);
    const holdFrames = Math.min(
      Math.round(GAME_FPS / fps),
      MAX_HOLD_FRAMES
    );

    const sequence = [];
    for (const file of sorted) {
      sequence.push({ file, repeat: holdFrames });
    }

    // Ping-pong only if sprite is not ultra-slow
    if (fps >= DISABLE_PINGPONG_BELOW && sorted.length > 2) {
      const reverse = sequence.slice(1, -1).reverse();
      return [...sequence, ...reverse];
    }

    return sequence;
  }

  createConcatFile(sequence, dir) {
    const lines = [];
    for (const item of sequence) {
      const filePath = path.join(dir, item.file).replace(/\\/g, '/');
      for (let i = 0; i < item.repeat; i++) {
        lines.push(`file '${filePath}'`);
      }
    }
    return lines.join('\n');
  }

  // ---------------- MAIN PROCESS ----------------

  async processAllImages(pluginDir, parsedData, options = {}) {
    const imagesRoot = path.join(pluginDir, 'images');

    const sprites = await this.collectSpritesWithData(pluginDir, parsedData);
    const spriteDataMap = this.buildSpriteDataMap(sprites);

    let converted = 0;
    let skipped = 0;

    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries.filter(e => e.isFile()).map(e => e.name);

      const sequences = new Map();
      for (const file of files) {
        if (!SEQ_REGEX.test(file)) continue;
        const base = file.match(SEQ_REGEX)[1].trim();
        if (!sequences.has(base)) sequences.set(base, []);
        sequences.get(base).push(file);
      }

      for (const [baseName, seqFiles] of sequences) {
        if (seqFiles.length < 2) {
          skipped++;
          continue;
        }

        const firstImagePath = path.join(dir, seqFiles[0]);
        const spriteFps =
          this.findFrameRateForImage(firstImagePath, imagesRoot, spriteDataMap)
          || options.fps
          || 10;

        const sequence = this.generateSequence(seqFiles, spriteFps);
        const listFile = path.join(dir, `._${baseName}_frames.txt`);
        await fs.writeFile(listFile, this.createConcatFile(sequence, dir));

        const outName = this.sanitizeFilename(baseName);
        const outputPath = path.join(dir, `${outName}.avif`);

        console.log(
          `▶ ${path.relative(imagesRoot, dir)}/${baseName} | sprite FPS=${spriteFps}`
        );

        try {
          await execFileAsync('ffmpeg', [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', listFile,
            '-vsync', 'cfr',
            '-r', String(GAME_FPS),
            '-c:v', 'libaom-av1',
            '-crf', String(options.crf ?? 40),
            '-cpu-used', String(options.speed ?? 6),
            '-pix_fmt', 'yuv444p',
            '-aom-params', 'enable-fwd-kf=0',
            outputPath
          ]);

          converted++;
        } catch (e) {
          console.error(`✖ Failed: ${outputPath}`, e.message);
        } finally {
          await fs.unlink(listFile);
        }
      }

      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(dir, e.name));
      }
    };

    await walk(imagesRoot);

    console.log(
      `\n✔ Done: ${converted} animated AVIFs, ${skipped} skipped`
    );
  }
}

module.exports = ImageConverter;
