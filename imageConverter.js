const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const SEQ_REGEX = /^(.*?)(\d+)\.(png|jpg|jpeg)$/i;

// ---------------- CONFIG ----------------
const GAME_FPS = 60;
const MIN_LOGICAL_FPS = 0.1;
const MAX_HOLD_FRAMES = 600;
const DISABLE_PINGPONG_BELOW = 1;

// Interpolation modes for smooth transitions
const INTERPOLATION_MODE = 'framerate'; // Options: 'none', 'blend', 'minterpolate', 'weighted', 'framerate'
const BLEND_FRAMES = 3; // Number of frames to blend together (for 'blend' mode)
const MINTERPOLATE_MODE = 'mci'; // 'mci' (motion compensated) or 'blend'
const MINTERPOLATE_MC_MODE = 'aobmc'; // 'obmc' or 'aobmc' (adaptive) - better quality
const MINTERPOLATE_ME_MODE = 'bidir'; // 'bidir' (bidirectional) - smoother
const MINTERPOLATE_VFE = 'pde'; // 'pde' (partial differential equation) - better for smooth gradients

// Framerate filter configuration (best for smooth interpolation)
const FRAMERATE_INTERP_START = 240; // Start frame interpolation threshold (higher = more smoothing)
const FRAMERATE_INTERP_END = 240;   // End frame interpolation threshold

// Weighted blending configuration
const WEIGHTED_BLEND_OVERLAP = 0.5; // 50% overlap between frames for smoother transitions (0.0 to 1.0)
// ----------------------------------------

class ImageConverter {
  sanitizeFilename(name) {
    const cleaned = name.replace(/[^a-zA-Z0-9]+$/g, '').trim();
    return cleaned.length ? cleaned : 'sprite';
  }

  async collectSpritesWithData(pluginDir, parsedData) {
    const sprites = [];
    const extract = (item) => {
      const out = [];
      if (item.sprite) out.push({ path: item.sprite, spriteData: item.spriteData || null });
      if (item.weapon?.sprite)
        out.push({ path: item.weapon.sprite, spriteData: item.weapon.spriteData || null });
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

  // ---------------- SEQUENCE ----------------

  generateSequence(seqFiles, logicalFps) {
    const sorted = [...seqFiles].sort((a, b) => {
      const na = parseInt(a.match(SEQ_REGEX)[2], 10);
      const nb = parseInt(b.match(SEQ_REGEX)[2], 10);
      return na - nb;
    });

    const fps = Math.max(logicalFps, MIN_LOGICAL_FPS);
    const holdFrames = Math.min(Math.round(GAME_FPS / fps), MAX_HOLD_FRAMES);

    const sequence = sorted.map(file => ({
      file,
      repeat: holdFrames
    }));

    // Create pingpong/bounce effect for smoother looping
    if (fps >= DISABLE_PINGPONG_BELOW && sorted.length > 2) {
      // Don't duplicate first and last frames to avoid stuttering
      const reverse = sequence.slice(1, -1).reverse();
      return [...sequence, ...reverse];
    }

    return sequence;
  }

  createConcatFile(sequence, dir) {
    const lines = [];
    const frameDuration = 1 / GAME_FPS;
    
    for (const item of sequence) {
      const filePath = path.join(dir, item.file).replace(/\\/g, '/');
      for (let i = 0; i < item.repeat; i++) {
        lines.push(`file '${filePath}'`);
        lines.push(`duration ${frameDuration.toFixed(6)}`);
      }
    }
    
    // FFmpeg concat requires the last file to be listed again without duration
    if (sequence.length > 0) {
      const lastFile = path.join(dir, sequence[sequence.length - 1].file).replace(/\\/g, '/');
      lines.push(`file '${lastFile}'`);
    }
    
    return lines.join('\n') + '\n';
  }

  // Build interpolation filter chain
  buildInterpolationFilter(mode, spriteFps, imageDimensions = null, frameCount = 0) {
    const filters = [];
    
    // Add padding if needed for minterpolate (requires 32x32 minimum)
    let needsPadding = false;
    let padWidth = 0;
    let padHeight = 0;
    
    if (imageDimensions && mode === 'minterpolate') {
      const { width, height } = imageDimensions;
      if (width < 32) {
        needsPadding = true;
        padWidth = 32 - width;
      }
      if (height < 32) {
        needsPadding = true;
        padHeight = 32 - height;
      }
      
      if (needsPadding) {
        // Calculate exact padding needed
        const newWidth = width + padWidth;
        const newHeight = height + padHeight;
        const padLeft = Math.floor(padWidth / 2);
        const padTop = Math.floor(padHeight / 2);
        
        filters.push(`pad=${newWidth}:${newHeight}:${padLeft}:${padTop}:color=0x00000000`);
      }
    }
    
    switch (mode) {
      case 'blend':
        // Simple temporal blending - blends multiple consecutive frames together
        // Creates smooth transitions but can look slightly blurry
        filters.push(`tmix=frames=${BLEND_FRAMES}:weights='1 1 1'`);
        filters.push('setpts=PTS-STARTPTS');
        break;
        
      case 'framerate':
        // Framerate filter with scene change detection disabled
        // Creates the smoothest interpolation by blending frames
        // This is the best option for eliminating jitter
        filters.push(`framerate=fps=${GAME_FPS}:interp_start=${FRAMERATE_INTERP_START}:interp_end=${FRAMERATE_INTERP_END}:scene=100`);
        filters.push('setpts=PTS-STARTPTS');
        break;
        
      case 'minterpolate':
        // Motion-interpolated frames - generates intermediate frames using motion estimation
        // Best for smooth, fluid motion with minimal blur
        // For 2-frame sequences, use blend mode for better results
        const miMode = frameCount === 2 ? 'blend' : MINTERPOLATE_MODE;
        filters.push(`minterpolate=fps=${GAME_FPS}:mi_mode=${miMode}:mc_mode=${MINTERPOLATE_MC_MODE}:me_mode=${MINTERPOLATE_ME_MODE}:vsbmc=1`);
        filters.push('setpts=PTS-STARTPTS');
        
        // Remove padding after interpolation if it was added
        if (needsPadding && imageDimensions) {
          filters.push(`crop=${imageDimensions.width}:${imageDimensions.height}`);
        }
        break;
        
      case 'weighted':
        // Weighted crossfade between frames - smooth transitions with controlled overlap
        // Good balance between smoothness and clarity
        const overlapFrames = Math.max(2, Math.floor(GAME_FPS / spriteFps * WEIGHTED_BLEND_OVERLAP));
        filters.push(`tmix=frames=${overlapFrames}:weights='${this.generateWeightedBlendWeights(overlapFrames)}'`);
        filters.push('setpts=PTS-STARTPTS');
        break;
        
      case 'none':
      default:
        // No interpolation, just timestamp normalization
        filters.push('setpts=PTS-STARTPTS');
        break;
    }
    
    return filters.join(',');
  }

  // Generate gaussian-like weights for smoother blending
  generateWeightedBlendWeights(numFrames) {
    const weights = [];
    const center = (numFrames - 1) / 2;
    
    for (let i = 0; i < numFrames; i++) {
      // Gaussian-like weighting (bell curve)
      const distance = Math.abs(i - center);
      const weight = Math.exp(-(distance * distance) / (numFrames / 2));
      weights.push(weight.toFixed(3));
    }
    
    return weights.join(' ');
  }

  // ---------------- MAIN ----------------

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
        const totalFrames = sequence.reduce((s, f) => s + f.repeat, 0);
        if (totalFrames <= 0) continue;

        const listFile = path.join(dir, `._${baseName}_frames.txt`);
        await fs.writeFile(listFile, this.createConcatFile(sequence, dir));

        const outName = this.sanitizeFilename(baseName);
        const outputPath = path.join(dir, `${outName}.avif`);

        let interpolationMode = options.interpolation || INTERPOLATION_MODE;
        let imageDimensions = null;
        
        // Check if we need to pad for minterpolate due to size constraints
        if (interpolationMode === 'minterpolate') {
          try {
            // Probe the first image to get dimensions
            const { stdout } = await execFileAsync('ffprobe', [
              '-v', 'error',
              '-select_streams', 'v:0',
              '-show_entries', 'stream=width,height',
              '-of', 'csv=p=0',
              path.join(dir, seqFiles[0])
            ]);
            const [width, height] = stdout.trim().split(',').map(Number);
            imageDimensions = { width, height };
            
            if (width < 32 || height < 32) {
              console.log(
                `▶ ${path.relative(imagesRoot, dir)}/${baseName} | fps=${spriteFps} | mode=${interpolationMode} (padding ${width}x${height} → ${Math.max(width, 32)}x${Math.max(height, 32)})`
              );
            } else {
              console.log(
                `▶ ${path.relative(imagesRoot, dir)}/${baseName} | fps=${spriteFps} | mode=${interpolationMode}`
              );
            }
          } catch (probeError) {
            // If probe fails, fall back to framerate
            interpolationMode = 'framerate';
            console.log(
              `▶ ${path.relative(imagesRoot, dir)}/${baseName} | fps=${spriteFps} | mode=${interpolationMode} (fallback from minterpolate)`
            );
          }
        } else {
          console.log(
            `▶ ${path.relative(imagesRoot, dir)}/${baseName} | fps=${spriteFps} | mode=${interpolationMode}`
          );
        }

        const ffmpegArgs = [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listFile,
          '-fps_mode', 'cfr',
          '-r', String(GAME_FPS),
          '-vf', this.buildInterpolationFilter(interpolationMode, spriteFps, imageDimensions, seqFiles.length),
          '-c:v', 'libaom-av1',
          '-crf', String(options.crf ?? 40),
          '-cpu-used', String(options.speed ?? 6),
          '-pix_fmt', 'yuv420p',
          '-still-picture', '0',
          '-movflags', '+faststart',
          outputPath
        ];

        try {
          await execFileAsync('ffmpeg', ffmpegArgs);
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

    console.log(`\n✔ Done: ${converted} animated AVIFs, ${skipped} skipped`);
  }
}

module.exports = ImageConverter;