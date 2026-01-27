// imageConverter.js - OpenGL-based sprite animation converter (like Endless Sky)
const fs = require('fs').promises;
const path = require('path');
const { createCanvas, loadImage, Image } = require('canvas');
const { exec: execCallback } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execCallback);
const gl = require('gl'); // headless-gl for OpenGL rendering

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
      // Ignore cleanup errors
    }
  }

  // Create OpenGL context (headless)
  createGLContext(width, height) {
    return gl(width, height, { preserveDrawingBuffer: true });
  }

  // Compile shader (like Endless Sky does)
  compileShader(glContext, type, source) {
    const shader = glContext.createShader(type);
    glContext.shaderSource(shader, source);
    glContext.compileShader(shader);
    
    if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
      console.error('Shader compilation error:', glContext.getShaderInfoLog(shader));
      glContext.deleteShader(shader);
      return null;
    }
    
    return shader;
  }

  // Create shader program for frame blending (Endless Sky's method)
  createBlendShaderProgram(glContext) {
    // Vertex shader - same as Endless Sky
    const vertexShaderSource = `
      attribute vec2 aPosition;
      attribute vec2 aTexCoord;
      varying vec2 vTexCoord;
      
      void main() {
        gl_Position = vec4(aPosition, 0.0, 1.0);
        vTexCoord = aTexCoord;
      }
    `;
    
    // Fragment shader - Endless Sky's frame blending shader
    const fragmentShaderSource = `
      precision mediump float;
      
      uniform sampler2D tex0;      // First frame
      uniform sampler2D tex1;      // Second frame
      uniform float fade;          // Blend amount (0.0 to 1.0)
      uniform int blendMode;       // 0=normal, 1=additive, 2=half-additive
      
      varying vec2 vTexCoord;
      
      void main() {
        vec4 color0 = texture2D(tex0, vTexCoord);
        vec4 color1 = texture2D(tex1, vTexCoord);
        
        vec4 finalColor;
        
        if (blendMode == 1) {
          // Additive blending (for glowing effects)
          finalColor.rgb = color0.rgb * (1.0 - fade) + color1.rgb * fade;
          finalColor.a = max(color0.a, color1.a);
        } else if (blendMode == 2) {
          // Half-additive blending
          finalColor.rgb = color0.rgb * (1.0 - fade) + color1.rgb * (fade * 0.5);
          finalColor.a = max(color0.a, color1.a);
        } else {
          // Normal blending (Endless Sky's default mix)
          finalColor = mix(color0, color1, fade);
        }
        
        gl_FragColor = finalColor;
      }
    `;
    
    const vertexShader = this.compileShader(glContext, glContext.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = this.compileShader(glContext, glContext.FRAGMENT_SHADER, fragmentShaderSource);
    
    const program = glContext.createProgram();
    glContext.attachShader(program, vertexShader);
    glContext.attachShader(program, fragmentShader);
    glContext.linkProgram(program);
    
    if (!glContext.getProgramParameter(program, glContext.LINK_STATUS)) {
      console.error('Shader program linking error:', glContext.getProgramInfoLog(program));
      return null;
    }
    
    return program;
  }

  // Detect if image has a solid background color (corners method)
  detectBackgroundColor(imageData) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    
    // Sample the four corners
    const corners = [
      { x: 0, y: 0 },                           // Top-left
      { x: width - 1, y: 0 },                   // Top-right
      { x: 0, y: height - 1 },                  // Bottom-left
      { x: width - 1, y: height - 1 }           // Bottom-right
    ];
    
    const cornerColors = corners.map(({ x, y }) => {
      const index = (y * width + x) * 4;
      return {
        r: data[index],
        g: data[index + 1],
        b: data[index + 2],
        a: data[index + 3]
      };
    });
    
    // Check if all corners have the same color
    const firstColor = cornerColors[0];
    const allCornersMatch = cornerColors.every(color => 
      color.r === firstColor.r &&
      color.g === firstColor.g &&
      color.b === firstColor.b
    );
    
    if (!allCornersMatch) {
      return null; // No solid background detected
    }
    
    // If corners already have transparency, no need to remove background
    if (firstColor.a < 255) {
      return null;
    }
    
    // Count how many pixels match this color
    let matchCount = 0;
    const totalPixels = width * height;
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        if (data[index] === firstColor.r &&
            data[index + 1] === firstColor.g &&
            data[index + 2] === firstColor.b) {
          matchCount++;
        }
      }
    }
    
    // If more than 20% of pixels match corner color, it's likely a background
    const matchPercentage = (matchCount / totalPixels) * 100;
    if (matchPercentage > 20) {
      return {
        r: firstColor.r,
        g: firstColor.g,
        b: firstColor.b,
        confidence: matchPercentage
      };
    }
    
    return null;
  }

  // Convert 24-bit texture data to 32-bit with alpha transparency
  // Based on StackOverflow solution - processes BEFORE interpolation
  convertToAlphaTexture(imageData, backgroundColor = { r: 0, g: 0, b: 0 }) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        
        // Check if pixel matches background color
        if (r === backgroundColor.r && 
            g === backgroundColor.g && 
            b === backgroundColor.b) {
          data[index + 3] = 0;   // Make transparent
        } else {
          data[index + 3] = 255; // Keep opaque
        }
      }
    }
    
    return imageData;
  }

  // Load image as OpenGL texture with optional background removal
  async loadTextureFromImage(glContext, imagePath, removeBackground = 'auto', bgColor = null) {
    const img = await loadImage(imagePath);
    
    const texture = glContext.createTexture();
    glContext.bindTexture(glContext.TEXTURE_2D, texture);
    
    // Create a canvas to get pixel data
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    let imageData = ctx.getImageData(0, 0, img.width, img.height);
    
    // *** BACKGROUND REMOVAL - BEFORE uploading to GPU ***
    // This happens BEFORE interpolation to prevent background colors from bleeding
    
    let actuallyRemoveBackground = false;
    let backgroundColorToRemove = bgColor;
    
    if (removeBackground === 'auto') {
      // Auto-detect if there's a solid background
      const detected = this.detectBackgroundColor(imageData);
      if (detected) {
        actuallyRemoveBackground = true;
        backgroundColorToRemove = detected;
      }
    } else if (removeBackground === true) {
      actuallyRemoveBackground = true;
      if (!backgroundColorToRemove) {
        // Try to detect, fallback to black
        const detected = this.detectBackgroundColor(imageData);
        backgroundColorToRemove = detected || { r: 0, g: 0, b: 0 };
      }
    }
    
    if (actuallyRemoveBackground && backgroundColorToRemove) {
      imageData = this.convertToAlphaTexture(imageData, backgroundColorToRemove);
    }
    
    glContext.texImage2D(
      glContext.TEXTURE_2D,
      0,
      glContext.RGBA,
      img.width,
      img.height,
      0,
      glContext.RGBA,
      glContext.UNSIGNED_BYTE,
      imageData.data
    );
    
    // Set texture parameters (like Endless Sky)
    glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_S, glContext.CLAMP_TO_EDGE);
    glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_T, glContext.CLAMP_TO_EDGE);
    glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MIN_FILTER, glContext.LINEAR);
    glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MAG_FILTER, glContext.LINEAR);
    
    return { 
      texture, 
      width: img.width, 
      height: img.height,
      backgroundRemoved: actuallyRemoveBackground,
      detectedBackground: backgroundColorToRemove
    };
  }

  // Blend two frames using OpenGL shader (Endless Sky's method)
  async blendFramesWithGL(frame1Path, frame2Path, fadeAmount, blendMode, removeBackground = 'auto', bgColor = null) {
    // Load both images to get dimensions
    const img1 = await loadImage(frame1Path);
    const width = img1.width;
    const height = img1.height;
    
    // Create OpenGL context
    const glContext = this.createGLContext(width, height);
    
    // Create shader program
    const program = this.createBlendShaderProgram(glContext);
    glContext.useProgram(program);
    
    // Load textures with optional background removal
    const tex0 = await this.loadTextureFromImage(glContext, frame1Path, removeBackground, bgColor);
    const tex1 = await this.loadTextureFromImage(glContext, frame2Path, removeBackground, bgColor);
    
    // Set up geometry (full-screen quad)
    const vertices = new Float32Array([
      -1, -1,  0, 1,  // Bottom-left (position, texcoord)
       1, -1,  1, 1,  // Bottom-right
      -1,  1,  0, 0,  // Top-left
       1,  1,  1, 0   // Top-right
    ]);
    
    const buffer = glContext.createBuffer();
    glContext.bindBuffer(glContext.ARRAY_BUFFER, buffer);
    glContext.bufferData(glContext.ARRAY_BUFFER, vertices, glContext.STATIC_DRAW);
    
    // Set up attributes
    const aPosition = glContext.getAttribLocation(program, 'aPosition');
    const aTexCoord = glContext.getAttribLocation(program, 'aTexCoord');
    
    glContext.enableVertexAttribArray(aPosition);
    glContext.vertexAttribPointer(aPosition, 2, glContext.FLOAT, false, 16, 0);
    
    glContext.enableVertexAttribArray(aTexCoord);
    glContext.vertexAttribPointer(aTexCoord, 2, glContext.FLOAT, false, 16, 8);
    
    // Set up uniforms
    const tex0Location = glContext.getUniformLocation(program, 'tex0');
    const tex1Location = glContext.getUniformLocation(program, 'tex1');
    const fadeLocation = glContext.getUniformLocation(program, 'fade');
    const blendModeLocation = glContext.getUniformLocation(program, 'blendMode');
    
    // Bind textures
    glContext.activeTexture(glContext.TEXTURE0);
    glContext.bindTexture(glContext.TEXTURE_2D, tex0.texture);
    glContext.uniform1i(tex0Location, 0);
    
    glContext.activeTexture(glContext.TEXTURE1);
    glContext.bindTexture(glContext.TEXTURE_2D, tex1.texture);
    glContext.uniform1i(tex1Location, 1);
    
    // Set blend mode
    let blendModeValue = 0; // normal
    if (blendMode === 'additive') blendModeValue = 1;
    else if (blendMode === 'half-additive') blendModeValue = 2;
    
    glContext.uniform1f(fadeLocation, fadeAmount);
    glContext.uniform1i(blendModeLocation, blendModeValue);
    
    // Enable blending for transparency
    glContext.enable(glContext.BLEND);
    glContext.blendFunc(glContext.SRC_ALPHA, glContext.ONE_MINUS_SRC_ALPHA);
    
    // Clear and render
    glContext.clearColor(0, 0, 0, 0);
    glContext.clear(glContext.COLOR_BUFFER_BIT);
    glContext.viewport(0, 0, width, height);
    glContext.drawArrays(glContext.TRIANGLE_STRIP, 0, 4);
    
    // Read pixels back
    const pixels = new Uint8Array(width * height * 4);
    glContext.readPixels(0, 0, width, height, glContext.RGBA, glContext.UNSIGNED_BYTE, pixels);
    
    // Convert to canvas for saving
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    
    // Flip Y (OpenGL renders upside-down)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = ((height - 1 - y) * width + x) * 4;
        const dstIdx = (y * width + x) * 4;
        imageData.data[dstIdx] = pixels[srcIdx];
        imageData.data[dstIdx + 1] = pixels[srcIdx + 1];
        imageData.data[dstIdx + 2] = pixels[srcIdx + 2];
        imageData.data[dstIdx + 3] = pixels[srcIdx + 3];
      }
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    // Cleanup
    glContext.deleteTexture(tex0.texture);
    glContext.deleteTexture(tex1.texture);
    glContext.deleteBuffer(buffer);
    glContext.deleteProgram(program);
    
    return {
      canvas,
      backgroundRemoved: tex0.backgroundRemoved,
      detectedBackground: tex0.detectedBackground
    };
  }

  // Find all animated sprite sequences
  async findAnimatedSprites(imagesDir) {
    const sprites = new Map();
    
    async function scanDirectory(dir) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            await scanDirectory(fullPath);
          } else if (entry.name.endsWith('.png')) {
            const match = entry.name.match(/^(.+?)([-+~^])(\d+)\.png$/);
            
            if (match) {
              const baseName = match[1];
              const specialChar = match[2];
              const frameNum = parseInt(match[3]);
              
              const relativePath = path.relative(imagesDir, dir);
              const spriteKey = path.join(relativePath, baseName);
              
              if (!sprites.has(spriteKey)) {
                sprites.set(spriteKey, {
                  baseName: baseName,
                  directory: dir,
                  relativePath: relativePath,
                  frames: [],
                  blendMode: 'normal'
                });
              }
              
              const sprite = sprites.get(spriteKey);
              
              if (specialChar === '+') sprite.blendMode = 'additive';
              else if (specialChar === '~' || specialChar === '^') sprite.blendMode = 'half-additive';
              
              sprite.frames.push({
                num: frameNum,
                path: fullPath,
                filename: entry.name
              });
            }
          }
        }
      } catch (error) {
        console.error(`Error scanning ${dir}:`, error.message);
      }
    }
    
    await scanDirectory(imagesDir);
    
    for (const sprite of sprites.values()) {
      sprite.frames.sort((a, b) => a.num - b.num);
    }
    
    return sprites;
  }

  // Helper method to get sprite metadata from data
  getSpriteMetadata(data, spriteKey, defaultFps = 10) {
    const metadata = {
      frameRate: defaultFps,
      rewind: false,
      removeBackground: 'auto',  // Changed from false to 'auto' - will auto-detect
      backgroundColor: null      // null means auto-detect
    };

    // Search through data to find matching sprite
    const checkSpriteData = (spriteData) => {
      if (!spriteData) return false;
      
      if (spriteData["frame rate"] !== undefined) {
        metadata.frameRate = spriteData["frame rate"];
      }
      if (spriteData["rewind"] !== undefined) {
        metadata.rewind = spriteData["rewind"];
      }
      if (spriteData["remove background"] !== undefined) {
        // Can be true, false, or 'auto'
        metadata.removeBackground = spriteData["remove background"];
      }
      if (spriteData["background color"] !== undefined) {
        const bgColor = spriteData["background color"];
        if (Array.isArray(bgColor) && bgColor.length >= 3) {
          metadata.backgroundColor = {
            r: bgColor[0],
            g: bgColor[1],
            b: bgColor[2]
          };
        }
      }
      return true;
    };

    // Check outfits
    if (data.outfits) {
      for (const outfit of Object.values(data.outfits)) {
        // Check weapon sprite
        if (outfit.weapon?.sprite === spriteKey) {
          if (checkSpriteData(outfit.weapon.spriteData)) return metadata;
        }
        // Check regular sprite (for non-weapon outfits)
        if (outfit.sprite === spriteKey) {
          if (checkSpriteData(outfit.spriteData)) return metadata;
        }
      }
    }

    // Check ships
    if (data.ships) {
      for (const ship of Object.values(data.ships)) {
        if (ship.sprite === spriteKey) {
          if (checkSpriteData(ship.spriteData)) return metadata;
        }
      }
    }

    // Check variants
    if (data.variants) {
      for (const variant of Object.values(data.variants)) {
        if (variant.sprite === spriteKey) {
          if (checkSpriteData(variant.spriteData)) return metadata;
        }
      }
    }

    return metadata;
  }

  // Generate interpolated frames using OpenGL
  async generateInterpolatedFrames(sprite, fps, metadata) {
    const frames = sprite.frames;
    if (frames.length === 0) return [];
    
    const frameOutputDir = path.join(this.tempDir, sprite.relativePath.replace(/[\/\\]/g, '_') + '_' + sprite.baseName);
    await fs.mkdir(frameOutputDir, { recursive: true });
    
    const interpolatedFrames = [];
    const framesPerAnimFrame = Math.max(1, Math.round(fps / metadata.frameRate));
    
    let outputFrameNum = 0;
    let detectedBackgroundInfo = null;
    
    console.log(`    Using OpenGL shader-based blending (${sprite.blendMode} mode)`);
    
    if (metadata.removeBackground === 'auto') {
      console.log(`    Auto-detecting background color...`);
    } else if (metadata.removeBackground === true) {
      if (metadata.backgroundColor) {
        const bg = metadata.backgroundColor;
        console.log(`    Removing background color: RGB(${bg.r}, ${bg.g}, ${bg.b})`);
      } else {
        console.log(`    Background removal enabled with auto-detection`);
      }
    } else if (metadata.removeBackground === false) {
      console.log(`    Background removal disabled`);
    }
    
    if (metadata.rewind) {
      console.log(`    Rewind mode enabled - animation will play forward then reverse`);
    }
    
    // Generate forward frames
    for (let i = 0; i < frames.length; i++) {
      const currentFrame = frames[i];
      const nextFrame = frames[(i + 1) % frames.length];
      
      for (let step = 0; step < framesPerAnimFrame; step++) {
        const fade = step / framesPerAnimFrame;
        
        let canvas;
        let backgroundRemoved = false;
        let detectedBg = null;
        
        if (fade < 0.01 || i === frames.length - 1) {
          const img = await loadImage(currentFrame.path);
          canvas = createCanvas(img.width, img.height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          
          // Apply background removal even to non-interpolated frames
          let imageData = ctx.getImageData(0, 0, img.width, img.height);
          
          // Check if we should remove background
          if (metadata.removeBackground === 'auto') {
            detectedBg = this.detectBackgroundColor(imageData);
            if (detectedBg) {
              imageData = this.convertToAlphaTexture(imageData, detectedBg);
              backgroundRemoved = true;
            }
          } else if (metadata.removeBackground === true) {
            const bgToRemove = metadata.backgroundColor || this.detectBackgroundColor(imageData) || { r: 0, g: 0, b: 0 };
            imageData = this.convertToAlphaTexture(imageData, bgToRemove);
            backgroundRemoved = true;
            detectedBg = bgToRemove;
          }
          
          if (backgroundRemoved) {
            ctx.putImageData(imageData, 0, 0);
          }
        } else {
          // Use OpenGL shader blending (Endless Sky's method)
          const result = await this.blendFramesWithGL(
            currentFrame.path,
            nextFrame.path,
            fade,
            sprite.blendMode,
            metadata.removeBackground,
            metadata.backgroundColor
          );
          canvas = result.canvas;
          backgroundRemoved = result.backgroundRemoved;
          detectedBg = result.detectedBackground;
        }
        
        // Store detection info from first frame
        if (!detectedBackgroundInfo && backgroundRemoved && detectedBg) {
          detectedBackgroundInfo = detectedBg;
        }
        
        const outputPath = path.join(frameOutputDir, `frame_${String(outputFrameNum).padStart(6, '0')}.png`);
        const buffer = canvas.toBuffer('image/png');
        await fs.writeFile(outputPath, buffer);
        
        interpolatedFrames.push(outputPath);
        outputFrameNum++;
      }
    }
    
    // Report what was detected
    if (detectedBackgroundInfo) {
      if (metadata.removeBackground === 'auto') {
        console.log(`    ✓ Auto-detected and removed background: RGB(${detectedBackgroundInfo.r}, ${detectedBackgroundInfo.g}, ${detectedBackgroundInfo.b})`);
        if (detectedBackgroundInfo.confidence) {
          console.log(`      Confidence: ${detectedBackgroundInfo.confidence.toFixed(1)}% of pixels matched`);
        }
      } else {
        console.log(`    ✓ Removed background successfully`);
      }
    } else if (metadata.removeBackground === 'auto') {
      console.log(`    ℹ No solid background detected - keeping original transparency`);
    }
    
    // If rewind is enabled, add reversed frames (excluding first and last to avoid duplication)
    if (metadata.rewind && interpolatedFrames.length > 2) {
      const reverseStartCount = interpolatedFrames.length;
      
      // Copy frames in reverse order, excluding the last frame (to avoid duplication)
      // and stopping before the first frame (to avoid duplication on loop)
      for (let i = interpolatedFrames.length - 2; i > 0; i--) {
        const sourcePath = interpolatedFrames[i];
        const outputPath = path.join(frameOutputDir, `frame_${String(outputFrameNum).padStart(6, '0')}.png`);
        
        // Copy the frame
        await fs.copyFile(sourcePath, outputPath);
        interpolatedFrames.push(outputPath);
        outputFrameNum++;
      }
      
      console.log(`    ✓ Added ${outputFrameNum - reverseStartCount} reverse frames for rewind`);
    }
    
    return { frames: interpolatedFrames, outputDir: frameOutputDir };
  }

  // Create APNG
  async createAPNG(frameDir, outputPath, fps) {
    const framePattern = path.join(frameDir, 'frame_%06d.png');
    const command = `ffmpeg -y -framerate ${fps} -i "${framePattern}" -plays 0 -f apng "${outputPath}"`;
    
    try {
      await exec(command);
      console.log(`    ✓ Created APNG with OpenGL-blended frames`);
    } catch (error) {
      console.error(`    ✗ Error creating APNG: ${error.message}`);
      throw error;
    }
  }

  // Process all images
  async processAllImages(pluginDir, data, options = {}) {

    var { 
      fps = null,  // null means auto-calculate based on frame rate
      fpsMultiplier = 6,  // Multiplier for auto-calculation (frame_rate * multiplier = output fps)
      defaultAnimationFps = 10 
    } = options;

    await this.init();
    
    const imagesDir = path.join(pluginDir, 'images');
    
    console.log('\n' + '='.repeat(60));
    console.log('Scanning for animated sprites (OpenGL mode)...');
    console.log('='.repeat(60));
    
    const sprites = await this.findAnimatedSprites(imagesDir);
    
    console.log(`Found ${sprites.size} animated sprites\n`);
    
    let processed = 0;
    
    for (const [spriteKey, sprite] of sprites) {
      try {
        processed++;
        console.log(`[${processed}/${sprites.size}] Processing: ${spriteKey}`);
        console.log(`  Frames: ${sprite.frames.length}`);
        console.log(`  Blend mode: ${sprite.blendMode}`);
        
        // Extract metadata for THIS specific sprite from data
        const metadata = this.getSpriteMetadata(data, spriteKey, defaultAnimationFps);
        console.log(`  Animation FPS: ${metadata.frameRate}`);

        // Calculate output FPS for this sprite
        let outputFps;
        if (fps !== null) {
          // User specified a fixed FPS for all sprites
          outputFps = fps;
        } else {
          // Auto-calculate based on the sprite's frame rate
          outputFps = metadata.frameRate * fpsMultiplier;
        }
        
        console.log(`  Output FPS: ${outputFps} ${fps === null ? '(auto-calculated: ' + metadata.frameRate + ' × ' + fpsMultiplier + ')' : '(fixed)'}`);

        console.log(`  Generating interpolated animation with OpenGL shaders...`);
        const result = await this.generateInterpolatedFrames(sprite, outputFps, metadata);
        console.log(`  Generated ${result.frames.length} total frames`);
        
        const outputPath = path.join(sprite.directory, `${sprite.baseName}.png`);
        
        console.log(`  Creating APNG...`);
        await this.createAPNG(result.outputDir, outputPath, outputFps);
        
        await fs.rm(result.outputDir, { recursive: true, force: true });
        
      } catch (error) {
        console.error(`  ✗ Error: ${error.message}`);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log(`OpenGL animation processing complete! Processed ${processed} sprites.`);
    console.log('='.repeat(60) + '\n');
    
    await this.cleanup();
  }
}

module.exports = ImageConverter;