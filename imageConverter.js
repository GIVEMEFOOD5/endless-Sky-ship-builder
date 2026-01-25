const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

// name + digits + extension
const SEQ_REGEX = /^(.*?)(\d+)\.(png|jpg|jpeg)$/i;

class ImageConverter {
  /**
   * Sanitize filename by removing ALL special characters from the end
   * (including dashes and underscores)
   */
  sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9]+$/, '').trim();
  }

  /**
   * Collect all sprite paths and their metadata (spriteData)
   * Returns an array of objects with path and metadata
   */
  async collectSpritesWithData(pluginDir, parsedData) {
    const imagesRoot = path.join(pluginDir, 'images');
    const sprites = [];

    // Helper function to extract sprite info from ships/variants/outfits
    const extractSpriteInfo = (item) => {
      const info = [];
      
      if (item.sprite) {
        info.push({
          path: item.sprite,
          spriteData: item.spriteData || null,
          type: 'sprite',
          itemName: item.name || item.displayName
        });
      }
      
      if (item.thumbnail) {
        info.push({
          path: item.thumbnail,
          spriteData: null, // Thumbnails typically don't have spriteData
          type: 'thumbnail',
          itemName: item.name || item.displayName
        });
      }

      // Handle weapon sprites for outfits
      if (item.weapon) {
        if (item.weapon.sprite) {
          info.push({
            path: item.weapon.sprite,
            spriteData: item.weapon.spriteData || null,
            type: 'weapon-sprite',
            itemName: item.name || item.displayName
          });
        }
        if (item.weapon['hardpoint sprite']) {
          info.push({
            path: item.weapon['hardpoint sprite'],
            spriteData: item.weapon.spriteData || null,
            type: 'hardpoint-sprite',
            itemName: item.name || item.displayName
          });
        }
      }
      
      return info;
    };

    // Collect from ships
    if (parsedData.ships) {
      for (const ship of parsedData.ships) {
        sprites.push(...extractSpriteInfo(ship));
      }
    }

    // Collect from variants
    if (parsedData.variants) {
      for (const variant of parsedData.variants) {
        sprites.push(...extractSpriteInfo(variant));
      }
    }

    // Collect from outfits
    if (parsedData.outfits) {
      for (const outfit of parsedData.outfits) {
        sprites.push(...extractSpriteInfo(outfit));
      }
    }

    return sprites;
  }

  /**
   * Get frame rate from spriteData
   * Returns the FPS value to use for the animation
   */
  getFrameRate(spriteData) {
    if (!spriteData) return null;
    
    // Check for "frame rate" - this is directly in FPS
    if (spriteData['frame rate']) {
      return parseFloat(spriteData['frame rate']);
    }
    
    // Check for "frame time" - this is in 1/60ths of a second
    if (spriteData['frame time']) {
      const frameTime = parseFloat(spriteData['frame time']);
      return 60 / frameTime; // Convert to FPS
    }
    
    return null;
  }

  /**
   * Build a lookup map of sprite paths to their frame rates
   * This allows us to quickly find the frame rate for any sprite path
   */
  buildSpriteDataMap(spritesWithData) {
    const map = new Map();
    
    for (const sprite of spritesWithData) {
      // Normalize the path (remove leading/trailing slashes, use forward slashes)
      const normalizedPath = sprite.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      
      // Get the frame rate
      const frameRate = this.getFrameRate(sprite.spriteData);
      
      if (frameRate) {
        map.set(normalizedPath, frameRate);
      }
    }
    
    return map;
  }

  /**
   * Find the frame rate for a specific image file path
   * Matches the file's directory and base name against sprite paths
   */
  findFrameRateForImage(imagePath, imagesRoot, spriteDataMap) {
    // Get relative path from images directory
    const relativePath = path.relative(imagesRoot, imagePath).replace(/\\/g, '/');
    
    // Remove the file extension and any frame number suffix
    // e.g., "ship/kestrel-0.png" -> "ship/kestrel"
    const withoutExt = relativePath.replace(/\.(png|jpg|jpeg)$/i, '');
    const basePath = withoutExt.replace(/[-+]\d+$/, '');
    
    // Look up in the sprite data map
    return spriteDataMap.get(basePath) || null;
  }

  /**
   * Generate frame sequence with transition modifiers
   * @param {string[]} seqFiles - Array of frame filenames
   * @param {string} transition - Transition type: 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'smooth', 'bounce'
   * @param {number} transitionFrames - Number of interpolated frames to add between original frames (0 = no interpolation)
   * @returns {Array} Array of {file, duration} objects
   */
  generateTransitionSequence(seqFiles, transition = 'smooth') {
    const sorted = [...seqFiles].sort((a, b) => {
      const na = parseInt(a.match(SEQ_REGEX)[2], 10);
      const nb = parseInt(b.match(SEQ_REGEX)[2], 10);
      return na - nb;
    });

    const easingFunctions = {
      linear: t => t,
      'ease-in': t => t * t,
      'ease-out': t => t * (2 - t),
      'ease-in-out': t => t < 0.5
        ? 2 * t * t
        : -1 + (4 - 2 * t) * t,
      smooth: t => t * t * (3 - 2 * t),
    };

    const ease = easingFunctions[transition] ?? easingFunctions.smooth;

    const sequence = [];
    const baseRepeats = 1;
    const maxRepeats = 4; // controls smoothness

    const total = sorted.length - 1;

    for (let i = 0; i < sorted.length; i++) {
      const t = i / total;
      const w = ease(t);

      const repeats = Math.round(
        baseRepeats + w * maxRepeats
      );

      sequence.push({
        file: sorted[i],
        repeat: Math.max(1, repeats)
      });
    }

    // ping-pong
    const reverse = sequence.slice(1, -1).reverse();
    return [...sequence, ...reverse];
  }


  /**
   * Create ffmpeg concat file with frame durations
   * @param {Array} sequence - Array of {file, duration} objects
   * @param {string} dir - Directory containing the files
   * @param {number} baseFps - Base frames per second
   * @returns {string} Content for concat file
   */
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

  async processAllImages(pluginDir, parsedData, options = {}) {
    const imagesRoot = path.join(pluginDir, 'images');

    // Extract transition options
    const transition = options.transition || 'linear'; // 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'smooth', 'bounce'
    const transitionFrames = options.transitionFrames || 0; // Number of interpolated frames (0 = disabled)

    // First, collect all sprite data and build a lookup map
    const spritesWithData = await this.collectSpritesWithData(pluginDir, parsedData);
    const spriteDataMap = this.buildSpriteDataMap(spritesWithData);
    
    console.log(`Built sprite data map with ${spriteDataMap.size} entries`);
    console.log(`Using transition: ${transition}`);

    let converted = 0;
    let skipped = 0;

    const walkDir = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      // Collect files in this directory
      const files = entries
        .filter(e => e.isFile())
        .map(e => e.name);

      /** @type {Map<string, string[]>} */
      const sequences = new Map();

      for (const file of files) {
        if (!SEQ_REGEX.test(file)) continue;

        const [, base] = file.match(SEQ_REGEX);
        const key = base.trim();

        if (!sequences.has(key)) {
          sequences.set(key, []);
        }
        sequences.get(key).push(file);
      }

      // Convert each sequence
      for (const [baseName, seqFiles] of sequences.entries()) {
        if (seqFiles.length < 2) {
          skipped++;
          continue;
        }

        // Generate transition sequence with dynamic timing
        const transitionSequence = this.generateTransitionSequence(seqFiles, transition, transitionFrames);

        const listFile = path.join(dir, `._${baseName}_frames.txt`);
        
        // Find the frame rate for this specific image sequence
        const firstImagePath = path.join(dir, seqFiles[0]);
        const spriteFrameRate = this.findFrameRateForImage(firstImagePath, imagesRoot, spriteDataMap);
        
        // Use sprite's frame rate if available, otherwise use options.fps or default to 10
        const fps = spriteFrameRate || options.fps || 10;
        
        // Create concat file with durations based on transition
        const listContent = this.createConcatFile(transitionSequence, dir);
        await fs.writeFile(listFile, listContent);

        // Sanitize the output filename - removes ALL special characters from end
        const sanitizedName = this.sanitizeFilename(baseName);
        const outputPath = path.join(dir, `${sanitizedName}.avif`);
        
        console.log(`Processing ${path.relative(imagesRoot, dir)}/${baseName} at ${fps} fps with ${transition} transition`);

        try {
          await execFileAsync('ffmpeg', [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', listFile,
            '-vsync', 'cfr',
            '-r', String(fps),
            '-c:v', 'libaom-av1',
            '-crf', String(options.crf ?? 40),
            '-cpu-used', String(options.speed ?? 6),
            '-pix_fmt', 'yuv420p',
            outputPath
          ]);


          console.log(`✔ ${path.relative(imagesRoot, outputPath)} (${fps} fps, ${transition})`);
          converted++;
        } catch (err) {
          console.error(`✖ Failed: ${outputPath}`, err.message);
        } finally {
          await fs.unlink(listFile);
        }
      }

      // Recurse
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await walkDir(path.join(dir, entry.name));
        }
      }
    };

    await walkDir(imagesRoot);

    console.log(
      `\nConversion complete: ${converted} animated AVIFs, ${skipped} skipped`
    );
  }
}

module.exports = ImageConverter;
