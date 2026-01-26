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

  // Load image as OpenGL texture
  async loadTextureFromImage(glContext, imagePath) {
    const img = await loadImage(imagePath);
    
    const texture = glContext.createTexture();
    glContext.bindTexture(glContext.TEXTURE_2D, texture);
    
    // Create a canvas to get pixel data
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    
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
    
    return { texture, width: img.width, height: img.height };
  }

  // Blend two frames using OpenGL shader (Endless Sky's method)
  async blendFramesWithGL(frame1Path, frame2Path, fadeAmount, blendMode) {
    // Load both images to get dimensions
    const img1 = await loadImage(frame1Path);
    const width = img1.width;
    const height = img1.height;
    
    // Create OpenGL context
    const glContext = this.createGLContext(width, height);
    
    // Create shader program
    const program = this.createBlendShaderProgram(glContext);
    glContext.useProgram(program);
    
    // Load textures
    const tex0 = await this.loadTextureFromImage(glContext, frame1Path);
    const tex1 = await this.loadTextureFromImage(glContext, frame2Path);
    
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
    
    return canvas;
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
            const match = entry.name.match(/^(.+?)([-+~])(\d+)\.png$/);
            
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
              else if (specialChar === '~') sprite.blendMode = 'half-additive';
              
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

  // Helper method to find frame rate for a specific sprite
  getSpriteFrameRate(data, spriteKey, defaultFps = 10) {
    // Search through data to find matching sprite
    // spriteKey is like "projectile/grab-strike"
    
    // Check outfits
    if (data.outfits) {
      for (const outfit of Object.values(data.outfits)) {
        // Check weapon sprite
        if (outfit.weapon?.sprite === spriteKey) {
          return outfit.weapon.spriteData?.["frame rate"] || defaultFps;
        }
        // Check regular sprite (for non-weapon outfits)
        if (outfit.sprite === spriteKey) {
          return outfit.spriteData?.["frame rate"] || defaultFps;
        }
      }
    }
    
    // Check ships
    if (data.ships) {
      for (const ship of Object.values(data.ships)) {
        if (ship.sprite === spriteKey) {
          return ship.spriteData?.["frame rate"] || defaultFps;
        }
      }
    }
    
    // Check variants
    if (data.variants) {
      for (const variant of Object.values(data.variants)) {
        if (variant.sprite === spriteKey) {
          return variant.spriteData?.["frame rate"] || defaultFps;
        }
      }
    }
    
    return defaultFps;
  }

  // Generate interpolated frames using OpenGL
  async generateInterpolatedFrames(sprite, fps, animationFps) {
    const frames = sprite.frames;
    if (frames.length === 0) return [];
    
    const frameOutputDir = path.join(this.tempDir, sprite.relativePath.replace(/[\/\\]/g, '_') + '_' + sprite.baseName);
    await fs.mkdir(frameOutputDir, { recursive: true });
    
    const interpolatedFrames = [];
    const framesPerAnimFrame = Math.max(1, Math.round(fps / animationFps));
    
    let outputFrameNum = 0;
    
    console.log(`    Using OpenGL shader-based blending (${sprite.blendMode} mode)`);
    
    for (let i = 0; i < frames.length; i++) {
      const currentFrame = frames[i];
      const nextFrame = frames[(i + 1) % frames.length];
      
      for (let step = 0; step < framesPerAnimFrame; step++) {
        const fade = step / framesPerAnimFrame;
        
        let canvas;
        if (fade < 0.01 || i === frames.length - 1) {
          const img = await loadImage(currentFrame.path);
          canvas = createCanvas(img.width, img.height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
        } else {
          // Use OpenGL shader blending (Endless Sky's method)
          canvas = await this.blendFramesWithGL(
            currentFrame.path,
            nextFrame.path,
            fade,
            sprite.blendMode
          );
        }
        
        const outputPath = path.join(frameOutputDir, `frame_${String(outputFrameNum).padStart(6, '0')}.png`);
        const buffer = canvas.toBuffer('image/png');
        await fs.writeFile(outputPath, buffer);
        
        interpolatedFrames.push(outputPath);
        outputFrameNum++;
      }
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

    var { fps = 60, animationFps = 10 } = options;

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
        
        // Extract frame rate for THIS specific sprite from data
        const animationFps = this.getSpriteFrameRate(data, spriteKey, defaultAnimationFps);
        console.log(`  Animation FPS: ${animationFps}`);

        console.log(`  Generating ${fps} FPS animation with OpenGL shaders...`);
        const result = await this.generateInterpolatedFrames(sprite, fps, animationFps);
        console.log(`  Generated ${result.frames.length} interpolated frames`);
        
        const outputPath = path.join(sprite.directory, `${sprite.baseName}.png`);
        
        console.log(`  Creating APNG...`);
        await this.createAPNG(result.outputDir, outputPath, fps);
        
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
