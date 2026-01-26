// imageConverter.js - Enhanced with Endless Sky animation support
const fs = require('fs').promises;
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const ffmpeg = require('fluent-ffmpeg');
const { exec: execCallback } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execCallback);

class ImageConverter {
  constructor() {
    this.tempDir = './temp_frames';
  }

  async init() {
    await fs.mkdir(this.tempDir, { recursive: true });
  }

  async cleanup() {
    try {
      await fs.rm(this.tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`Cleanup error: ${error.message}`);
    }
  }

  // Find all frame files for a sprite (handles -0.png, -00.png, +0.png, ~0.png patterns)
  async findSpriteFrames(imagesPath, spritePath) {
    const frames = [];
    
    try {
      const fullPath = path.join(imagesPath, spritePath);
      const dir = path.dirname(fullPath);
      const baseName = path.basename(spritePath);
      
      // Check if directory exists
      try {
        await fs.access(dir);
      } catch {
        console.log(`  Directory not found: ${dir}`);
        return frames;
      }
      
      const files = await fs.readdir(dir);
      
      // Match patterns for animation frames
      // sprite-0.png, sprite-00.png, sprite+0.png (additive), sprite~0.png (half-additive)
      const patterns = [
        { regex: new RegExp(`^${this.escapeRegex(baseName)}-(\\d+)\\.png$`), blend: 'normal' },
        { regex: new RegExp(`^${this.escapeRegex(baseName)}\\+(\\d+)\\.png$`), blend: 'additive' },
        { regex: new RegExp(`^${this.escapeRegex(baseName)}~(\\d+)\\.png$`), blend: 'half-additive' }
      ];
      
      for (const file of files) {
        for (const pattern of patterns) {
          const match = file.match(pattern.regex);
          if (match) {
            const frameNum = parseInt(match[1]);
            const fullPath = path.join(dir, file);
            
            frames.push({
              num: frameNum,
              path: fullPath,
              blendMode: pattern.blend
            });
            break;
          }
        }
      }
      
      // Sort by frame number
      frames.sort((a, b) => a.num - b.num);
      
    } catch (err) {
      console.error(`Error finding frames for ${spritePath}:`, err.message);
    }
    
    return frames;
  }

  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Helper function to strip quotes from strings
  stripQuotes(value) {
    if (typeof value !== 'string') return value;
    
    // Remove surrounding quotes or backticks
    value = value.trim();
    
    // Strip double quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith('`') && value.endsWith('`'))) {
      value = value.slice(1, -1);
    }
    
    // Handle escaped quotes inside the string
    value = value.replace(/\\"/g, '"').replace(/\\`/g, '`');
    
    return value;
  }

  // Helper function to get value from spriteData with or without quotes
  getSpriteDataValue(spriteData, key) {
    let value;
    
    // Try without quotes first
    if (spriteData[key] !== undefined) {
      value = spriteData[key];
    }
    // Try with double quotes in the key
    else if (spriteData[`"${key}"`] !== undefined) {
      value = spriteData[`"${key}"`];
    }
    // Try with backticks in the key
    else if (spriteData[`\`${key}\``] !== undefined) {
      value = spriteData[`\`${key}\``];
    }
    else {
      return undefined;
    }
    
    // Strip quotes from the value itself
    return this.stripQuotes(value);
  }

  // Extract animation parameters from spriteData
  getAnimationParams(spriteData, defaultFps = 10) {
    const params = {
      frameRate: defaultFps,
      frameTime: null,
      delay: 0,
      startFrame: 0,
      randomStartFrame: false,
      noRepeat: false,
      rewind: false
    };

    if (!spriteData) return params;

    // Debug: log the raw spriteData to see what we're working with
    // console.log('    Raw spriteData:', JSON.stringify(spriteData, null, 2));

    // Parse frame rate (handle both "frame rate" and frame rate)
    const frameRateVal = this.getSpriteDataValue(spriteData, 'frame rate');
    if (frameRateVal !== undefined) {
      params.frameRate = parseFloat(frameRateVal);
    }

    // Parse frame time (takes precedence over frame rate)
    const frameTimeVal = this.getSpriteDataValue(spriteData, 'frame time');
    if (frameTimeVal !== undefined) {
      params.frameTime = parseFloat(frameTimeVal);
      params.frameRate = 1.0 / params.frameTime;
    }

    // Parse delay
    const delayVal = this.getSpriteDataValue(spriteData, 'delay');
    if (delayVal !== undefined) {
      params.delay = parseFloat(delayVal);
    }

    // Parse start frame
    const startFrameVal = this.getSpriteDataValue(spriteData, 'start frame');
    if (startFrameVal !== undefined) {
      params.startFrame = parseInt(startFrameVal);
    }

    // Boolean flags - check if key exists (not just truthy value)
    const randomStartFrameVal = this.getSpriteDataValue(spriteData, 'random start frame');
    params.randomStartFrame = randomStartFrameVal !== undefined;
    
    const noRepeatVal = this.getSpriteDataValue(spriteData, 'no repeat');
    params.noRepeat = noRepeatVal !== undefined;
    
    const rewindVal = this.getSpriteDataValue(spriteData, 'rewind');
    params.rewind = rewindVal !== undefined;

    // Debug: log extracted params
    // console.log('    Extracted params:', params);

    return params;
  }

  // Blend two frames using Endless Sky's tweening method
  async blendFrames(frame1Path, frame2Path, fadeAmount, blendMode) {
    const img1 = await loadImage(frame1Path);
    const img2 = await loadImage(frame2Path);
    
    const canvas = createCanvas(img1.width, img1.height);
    const ctx = canvas.getContext('2d');
    
    // Draw first frame
    ctx.globalAlpha = 1.0 - fadeAmount;
    ctx.drawImage(img1, 0, 0);
    
    // Draw second frame with appropriate blending
    if (blendMode === 'additive') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = fadeAmount;
    } else if (blendMode === 'half-additive') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = fadeAmount * 0.5;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = fadeAmount;
    }
    
    ctx.drawImage(img2, 0, 0);
    
    return canvas;
  }

  // Generate interpolated frames for smooth animation
  async generateInterpolatedFrames(frames, animParams, outputFps = 60) {
    const interpolatedFrames = [];
    
    if (frames.length === 0) return interpolatedFrames;
    
    // Single frame = static sprite
    if (frames.length === 1) {
      interpolatedFrames.push(frames[0].path);
      return interpolatedFrames;
    }

    const frameOutputDir = path.join(this.tempDir, `anim_${Date.now()}`);
    await fs.mkdir(frameOutputDir, { recursive: true });
    
    // Calculate how many output frames per animation frame
    const framesPerAnimFrame = Math.max(1, Math.round(outputFps / animParams.frameRate));
    
    let outputFrameNum = 0;
    const totalAnimFrames = frames.length;
    
    // Generate forward animation
    for (let i = 0; i < totalAnimFrames; i++) {
      const currentFrame = frames[i];
      const nextFrame = frames[(i + 1) % totalAnimFrames];
      
      // Generate interpolated frames between current and next
      for (let step = 0; step < framesPerAnimFrame; step++) {
        const fade = step / framesPerAnimFrame;
        
        let canvas;
        if (fade < 0.01 || i === totalAnimFrames - 1) {
          // Use current frame directly
          const img = await loadImage(currentFrame.path);
          canvas = createCanvas(img.width, img.height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
        } else {
          // Blend frames with tweening
          canvas = await this.blendFrames(
            currentFrame.path,
            nextFrame.path,
            fade,
            currentFrame.blendMode
          );
        }
        
        const outputPath = path.join(frameOutputDir, `frame_${String(outputFrameNum).padStart(6, '0')}.png`);
        const buffer = canvas.toBuffer('image/png');
        await fs.writeFile(outputPath, buffer);
        
        interpolatedFrames.push(outputPath);
        outputFrameNum++;
        
        // Stop if no repeat and we're on the last frame
        if (animParams.noRepeat && i === totalAnimFrames - 1) break;
      }
      
      if (animParams.noRepeat && i === totalAnimFrames - 1) break;
    }
    
    // Handle rewind animation (plays forward then backward)
    if (animParams.rewind && !animParams.noRepeat && totalAnimFrames > 2) {
      // Add reverse frames (excluding first and last to avoid duplication)
      for (let i = totalAnimFrames - 2; i > 0; i--) {
        const currentFrame = frames[i];
        const prevFrame = frames[i - 1];
        
        for (let step = 0; step < framesPerAnimFrame; step++) {
          const fade = step / framesPerAnimFrame;
          
          const canvas = await this.blendFrames(
            currentFrame.path,
            prevFrame.path,
            fade,
            currentFrame.blendMode
          );
          
          const outputPath = path.join(frameOutputDir, `frame_${String(outputFrameNum).padStart(6, '0')}.png`);
          const buffer = canvas.toBuffer('image/png');
          await fs.writeFile(outputPath, buffer);
          
          interpolatedFrames.push(outputPath);
          outputFrameNum++;
        }
      }
    }
    
    return { frames: interpolatedFrames, outputDir: frameOutputDir };
  }

  // Convert image sequence to AVIF using FFmpeg
  async createAVIF(frameDir, outputPath, fps, options = {}) {
    const { crf = 15, speed = 4 } = options;
    
    return new Promise((resolve, reject) => {
      const framePattern = path.join(frameDir, 'frame_%06d.png');
      
      ffmpeg()
        .input(framePattern)
        .inputFPS(fps)
        .outputOptions([
          '-c:v libaom-av1',
          `-crf ${crf}`,
          `-cpu-used ${speed}`,
          '-pix_fmt yuv420p',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', (cmd) => {
          console.log(`    FFmpeg command: ${cmd}`);
        })
        .on('end', () => {
          console.log(`    ✓ Created AVIF: ${path.basename(outputPath)}`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`    ✗ FFmpeg error: ${err.message}`);
          reject(err);
        })
        .run();
    });
  }

  // Process all sprites for ships, variants, and outfits
  async processAllImages(pluginDir, data, options = {}) {
    const { fps = 60, crf = 15, speed = 4 } = options;
    
    await this.init();
    
    const imagesDir = path.join(pluginDir, 'images');
    const outputDir = path.join(pluginDir, 'animations');
    await fs.mkdir(outputDir, { recursive: true });
    
    console.log('\n' + '='.repeat(60));
    console.log('Processing sprite animations...');
    console.log('='.repeat(60));
    
    const spritesToProcess = new Map();
    
    // Collect unique sprites from ships
    for (const ship of data.ships) {
      if (ship.sprite && !spritesToProcess.has(ship.sprite)) {
        spritesToProcess.set(ship.sprite, {
          sprite: ship.sprite,
          spriteData: ship.spriteData,
          type: 'ship',
          name: ship.name
        });
      }
    }
    
    // Collect unique sprites from variants
    for (const variant of data.variants) {
      if (variant.sprite && !spritesToProcess.has(variant.sprite)) {
        spritesToProcess.set(variant.sprite, {
          sprite: variant.sprite,
          spriteData: variant.spriteData,
          type: 'variant',
          name: variant.name
        });
      }
    }
    
    // Collect unique sprites from outfits
    for (const outfit of data.outfits) {
      if (outfit.sprite && !spritesToProcess.has(outfit.sprite)) {
        spritesToProcess.set(outfit.sprite, {
          sprite: outfit.sprite,
          spriteData: outfit.spriteData,
          type: 'outfit',
          name: outfit.name
        });
      }
      
      // Also check weapon sprites
      if (outfit.weapon) {
        if (outfit.weapon.sprite && !spritesToProcess.has(outfit.weapon.sprite)) {
          spritesToProcess.set(outfit.weapon.sprite, {
            sprite: outfit.weapon.sprite,
            spriteData: outfit.weapon.spriteData,
            type: 'weapon',
            name: `${outfit.name} (weapon)`
          });
        }
        
        if (outfit.weapon['hardpoint sprite'] && !spritesToProcess.has(outfit.weapon['hardpoint sprite'])) {
          spritesToProcess.set(outfit.weapon['hardpoint sprite'], {
            sprite: outfit.weapon['hardpoint sprite'],
            spriteData: outfit.weapon.spriteData,
            type: 'hardpoint',
            name: `${outfit.name} (hardpoint)`
          });
        }
      }
    }
    
    console.log(`Found ${spritesToProcess.size} unique sprites to process\n`);
    
    let processed = 0;
    let animated = 0;
    let static = 0;
    
    for (const [spritePath, info] of spritesToProcess) {
      try {
        console.log(`\n[${++processed}/${spritesToProcess.size}] Processing: ${info.name}`);
        console.log(`  Type: ${info.type}`);
        console.log(`  Sprite: ${spritePath}`);
        
        // Find all frames for this sprite
        const frames = await this.findSpriteFrames(imagesDir, spritePath);
        
        if (frames.length === 0) {
          console.log(`  ✗ No frames found`);
          continue;
        }
        
        if (frames.length === 1) {
          console.log(`  ℹ Static sprite (single frame)`);
          static++;
          // Optionally copy single frame as static AVIF
          continue;
        }
        
        console.log(`  Found ${frames.length} frames`);
        
        // Get animation parameters
        const animParams = this.getAnimationParams(info.spriteData, 10);
        console.log(`  Animation: ${animParams.frameRate.toFixed(1)} fps${animParams.rewind ? ' (rewind)' : ''}${animParams.noRepeat ? ' (no repeat)' : ''}`);
        
        // Generate interpolated frames
        console.log(`  Generating interpolated frames...`);
        const result = await this.generateInterpolatedFrames(frames, animParams, fps);
        console.log(`  Generated ${result.frames.length} interpolated frames`);
        
        // Create AVIF animation
        const safeName = spritePath.replace(/[\/\\]/g, '_');
        const avifPath = path.join(outputDir, `${safeName}.avif`);
        
        console.log(`  Creating AVIF animation...`);
        await this.createAVIF(result.outputDir, avifPath, fps, { crf, speed });
        
        // Cleanup temp frames
        await fs.rm(result.outputDir, { recursive: true, force: true });
        
        animated++;
        
      } catch (error) {
        console.error(`  ✗ Error processing ${spritePath}: ${error.message}`);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('Animation processing complete!');
    console.log(`  Animated: ${animated}`);
    console.log(`  Static: ${static}`);
    console.log(`  Total: ${processed}`);
    console.log('='.repeat(60) + '\n');
    
    await this.cleanup();
  }
}

module.exports = ImageConverter;
