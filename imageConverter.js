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

  async processAllImages(pluginDir, parsedData, options = {}) {
    const imagesRoot = path.join(pluginDir, 'images');

    // First, collect all sprite data and build a lookup map
    const spritesWithData = await this.collectSpritesWithData(pluginDir, parsedData);
    const spriteDataMap = this.buildSpriteDataMap(spritesWithData);
    
    console.log(`Built sprite data map with ${spriteDataMap.size} entries`);

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

        // Sort numerically (lowest to highest)
        seqFiles.sort((a, b) => {
          const na = parseInt(a.match(SEQ_REGEX)[2], 10);
          const nb = parseInt(b.match(SEQ_REGEX)[2], 10);
          return na - nb;
        });

        // Create ping-pong effect: lowest to highest, then highest to lowest
        // Exclude the last frame to avoid duplicate when reversing
        const reversedSeq = seqFiles.slice(0, -1).reverse();
        const pingPongSeq = [...seqFiles, ...reversedSeq];

        const listFile = path.join(dir, `._${baseName}_frames.txt`);
        const listContent = pingPongSeq
          .map(f => `file '${path.join(dir, f).replace(/\\/g, '/')}'`)
          .join('\n');

        await fs.writeFile(listFile, listContent);

        // Sanitize the output filename - removes ALL special characters from end
        const sanitizedName = this.sanitizeFilename(baseName);
        const outputPath = path.join(dir, `${sanitizedName}.avif`);

        // Find the frame rate for this specific image sequence
        const firstImagePath = path.join(dir, seqFiles[0]);
        const spriteFrameRate = this.findFrameRateForImage(firstImagePath, imagesRoot, spriteDataMap);
        
        // Use sprite's frame rate if available, otherwise use options.fps or default to 10
        const fps = spriteFrameRate || options.fps || 10;
        
        console.log(`Processing ${path.relative(imagesRoot, dir)}/${baseName} at ${fps} fps`);

        try {
          await execFileAsync('ffmpeg', [
            '-y',
            '-r', String(fps),
            '-f', 'concat',
            '-safe', '0',
            '-i', listFile,
            '-c:v', 'libaom-av1',
            '-crf', String(options.crf ?? 40),
            '-cpu-used', String(options.speed ?? 6),
            '-pix_fmt', 'yuv420p',
            outputPath
          ]);

          console.log(`✔ ${path.relative(imagesRoot, outputPath)} (${fps} fps)`);
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