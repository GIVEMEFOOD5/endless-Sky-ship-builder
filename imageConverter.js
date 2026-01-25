const fs = require('fs').promises;
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { createContext } = require('gl');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const SEQ_REGEX = /^(.*?)(\d+)\.(png|jpg|jpeg)$/i;

// ---------------- CONFIG ----------------
const GAME_FPS = 60;
const MIN_LOGICAL_FPS = 0.1;
const MAX_HOLD_FRAMES = 600;
const DISABLE_PINGPONG_BELOW = 0.09;

// OpenGL rendering settings
const BLEND_MODE = 'gaussian'; // 'linear', 'gaussian', 'cubic', 'lanczos'
const MOTION_BLUR_SAMPLES = 8; // Number of sub-frame samples for motion blur
const ENABLE_MOTION_BLUR = true;
const ADAPTIVE_BLUR_STRENGTH = true; // Stronger blur for low frame counts

// Frame interpolation settings
const ADAPTIVE_LOW_FRAME_THRESHOLD = 15;
const LOW_FRAME_BLUR_MULTIPLIER = 2.0; // Extra blur for choppy animations
// ----------------------------------------

class OpenGLSpriteRenderer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    
    try {
      this.glContext = createContext(width, height, { preserveDrawingBuffer: true });
      
      if (!this.glContext) {
        throw new Error('Failed to create OpenGL context');
      }
      
      console.log(`✓ OpenGL context created: ${width}x${height}`);
    } catch (error) {
      throw new Error(`OpenGL initialization failed: ${error.message}. Ensure mesa libraries and Xvfb are installed.`);
    }
    
    this.textures = [];
    this.framebuffers = [];
    this.shaders = {};
    
    this.initShaders();
  }

  initShaders() {
    const gl = this.glContext;

    // Vertex shader (standard quad)
    const vertexShaderSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;

    // Fragment shader for Gaussian blur blending
    const gaussianFragmentSource = `
      precision mediump float;
      uniform sampler2D u_texture0;
      uniform sampler2D u_texture1;
      uniform sampler2D u_texture2;
      uniform sampler2D u_texture3;
      uniform sampler2D u_texture4;
      uniform sampler2D u_texture5;
      uniform sampler2D u_texture6;
      uniform sampler2D u_texture7;
      uniform float u_weights[8];
      uniform int u_numTextures;
      varying vec2 v_texCoord;
      
      void main() {
        vec4 color = vec4(0.0);
        float totalWeight = 0.0;
        
        for (int i = 0; i < 8; i++) {
          if (i >= u_numTextures) break;
          
          vec4 sample;
          if (i == 0) sample = texture2D(u_texture0, v_texCoord);
          else if (i == 1) sample = texture2D(u_texture1, v_texCoord);
          else if (i == 2) sample = texture2D(u_texture2, v_texCoord);
          else if (i == 3) sample = texture2D(u_texture3, v_texCoord);
          else if (i == 4) sample = texture2D(u_texture4, v_texCoord);
          else if (i == 5) sample = texture2D(u_texture5, v_texCoord);
          else if (i == 6) sample = texture2D(u_texture6, v_texCoord);
          else if (i == 7) sample = texture2D(u_texture7, v_texCoord);
          
          float weight = u_weights[i];
          color += sample * weight;
          totalWeight += weight;
        }
        
        if (totalWeight > 0.0) {
          color /= totalWeight;
        }
        
        gl_FragColor = color;
      }
    `;

    // Cubic interpolation shader
    const cubicFragmentSource = `
      precision mediump float;
      uniform sampler2D u_texture1;
      uniform sampler2D u_texture2;
      uniform float u_blend;
      varying vec2 v_texCoord;
      
      // Cubic interpolation
      float cubic(float t) {
        return t * t * (3.0 - 2.0 * t);
      }
      
      void main() {
        float t = cubic(u_blend);
        vec4 color1 = texture2D(u_texture1, v_texCoord);
        vec4 color2 = texture2D(u_texture2, v_texCoord);
        gl_FragColor = mix(color1, color2, t);
      }
    `;

    this.shaders.gaussian = this.createProgram(vertexShaderSource, gaussianFragmentSource);
    this.shaders.cubic = this.createProgram(vertexShaderSource, cubicFragmentSource);
    
    this.setupQuad();
  }

  createProgram(vertSource, fragSource) {
    const gl = this.glContext;
    
    const vertShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertShader, vertSource);
    gl.compileShader(vertShader);
    
    if (!gl.getShaderParameter(vertShader, gl.COMPILE_STATUS)) {
      console.error('Vertex shader compilation error:', gl.getShaderInfoLog(vertShader));
      throw new Error('Vertex shader compilation failed');
    }
    
    const fragShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragShader, fragSource);
    gl.compileShader(fragShader);
    
    if (!gl.getShaderParameter(fragShader, gl.COMPILE_STATUS)) {
      console.error('Fragment shader compilation error:', gl.getShaderInfoLog(fragShader));
      throw new Error('Fragment shader compilation failed');
    }
    
    const program = gl.createProgram();
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program linking error:', gl.getProgramInfoLog(program));
      throw new Error('Shader program linking failed');
    }
    
    return program;
  }

  setupQuad() {
    const gl = this.glContext;
    
    // Full-screen quad
    const vertices = new Float32Array([
      -1, -1,  0, 1,
       1, -1,  1, 1,
      -1,  1,  0, 0,
       1,  1,  1, 0
    ]);
    
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  }

  async loadTexture(imagePath) {
    const gl = this.glContext;
    const image = await loadImage(imagePath);
    
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    
    // Create canvas and draw image
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    
    const imageData = ctx.getImageData(0, 0, image.width, image.height);
    
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      image.width,
      image.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(imageData.data.buffer)
    );
    
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    return { texture, width: image.width, height: image.height };
  }

  calculateGaussianWeights(numSamples, sigma = 1.0) {
    const weights = [];
    const center = (numSamples - 1) / 2;
    let sum = 0;
    
    for (let i = 0; i < numSamples; i++) {
      const x = i - center;
      const weight = Math.exp(-(x * x) / (2 * sigma * sigma));
      weights.push(weight);
      sum += weight;
    }
    
    // Normalize
    return weights.map(w => w / sum);
  }

  renderBlendedFrame(textures, weights) {
    const gl = this.glContext;
    const program = this.shaders.gaussian;
    
    gl.useProgram(program);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    // Enable blending for transparency
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    
    // Bind textures to texture units
    for (let i = 0; i < Math.min(textures.length, 8); i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, textures[i]);
      const loc = gl.getUniformLocation(program, `u_texture${i}`);
      if (loc !== null) {
        gl.uniform1i(loc, i);
      }
    }
    
    // Set weights
    const weightLoc = gl.getUniformLocation(program, 'u_weights');
    if (weightLoc !== null) {
      gl.uniform1fv(weightLoc, new Float32Array(weights));
    }
    
    const numLoc = gl.getUniformLocation(program, 'u_numTextures');
    if (numLoc !== null) {
      gl.uniform1i(numLoc, textures.length);
    }
    
    // Setup attributes
    const posLoc = gl.getAttribLocation(program, 'a_position');
    const texLoc = gl.getAttribLocation(program, 'a_texCoord');
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    
    if (posLoc !== -1) {
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    }
    
    if (texLoc !== -1) {
      gl.enableVertexAttribArray(texLoc);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 16, 8);
    }
    
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    // Read pixels - flip Y because OpenGL is bottom-up
    const pixels = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    
    // Flip the image vertically
    const flipped = new Uint8Array(this.width * this.height * 4);
    const rowSize = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      const srcRow = (this.height - 1 - y) * rowSize;
      const dstRow = y * rowSize;
      flipped.set(pixels.subarray(srcRow, srcRow + rowSize), dstRow);
    }
    
    return flipped;
  }

  getFrameAsCanvas(pixels) {
    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(this.width, this.height);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  cleanup() {
    const gl = this.glContext;
    this.textures.forEach(t => gl.deleteTexture(t));
    this.framebuffers.forEach(f => gl.deleteFramebuffer(f));
    
    // Destroy the GL context
    if (gl.getExtension('STACKGL_destroy_context')) {
      gl.getExtension('STACKGL_destroy_context').destroy();
    }
  }
}

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

  shouldRewind(spriteData) {
    if (!spriteData) return false;
    const desc = spriteData.description || '';
    return desc.includes('rewind');
  }

  buildSpriteDataMap(sprites) {
    const map = new Map();
    for (const s of sprites) {
      const key = s.path.replace(/\\/g, '/').replace(/\.(png|jpg|jpeg)$/i, '');
      const fps = this.getFrameRate(s.spriteData);
      const rewind = this.shouldRewind(s.spriteData);
      if (fps || rewind) map.set(key, { fps, rewind });
    }
    return map;
  }

  findSpriteDataForImage(imagePath, imagesRoot, spriteDataMap) {
    const rel = path
      .relative(imagesRoot, imagePath)
      .replace(/\\/g, '/')
      .replace(/\.(png|jpg|jpeg)$/i, '')
      .replace(/[-+]\d+$/, '');

    return spriteDataMap.get(rel) || { fps: null, rewind: false };
  }

  generateSequence(seqFiles, logicalFps, shouldRewind = false) {
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

    const usePingpong = shouldRewind || (fps >= DISABLE_PINGPONG_BELOW && sorted.length >= 2);
    
    if (usePingpong) {
      const reverse = sequence.slice(1, -1).reverse();
      return [...sequence, ...reverse];
    }

    return sequence;
  }

  async renderSequenceWithOpenGL(dir, sequence, spriteFps, isLowFrameCount) {
    // Load all unique frames
    const uniqueFiles = [...new Set(sequence.map(s => s.file))];
    const firstImagePath = path.join(dir, uniqueFiles[0]);
    const firstImage = await loadImage(firstImagePath);
    
    const renderer = new OpenGLSpriteRenderer(firstImage.width, firstImage.height);
    
    // Load all textures
    const textureMap = new Map();
    for (const file of uniqueFiles) {
      const texData = await renderer.loadTexture(path.join(dir, file));
      textureMap.set(file, texData.texture);
    }

    const frames = [];
    const blurSamples = ENABLE_MOTION_BLUR ? MOTION_BLUR_SAMPLES : 1;
    const blurMultiplier = (ADAPTIVE_BLUR_STRENGTH && isLowFrameCount) ? LOW_FRAME_BLUR_MULTIPLIER : 1.0;
    
    // Build frame timeline
    const frameTimeline = [];
    for (const item of sequence) {
      for (let rep = 0; rep < item.repeat; rep++) {
        frameTimeline.push(item.file);
      }
    }
    
    for (let frameIndex = 0; frameIndex < frameTimeline.length; frameIndex++) {
      const currentFile = frameTimeline[frameIndex];
      const texture = textureMap.get(currentFile);
      
      if (ENABLE_MOTION_BLUR && blurSamples > 1) {
        // Multi-sample motion blur
        const samples = [];
        const weights = renderer.calculateGaussianWeights(blurSamples, 1.0 * blurMultiplier);
        
        // Collect nearby frames for blending
        const sampleRange = Math.floor(blurSamples / 2);
        for (let s = -sampleRange; s <= sampleRange; s++) {
          const sampleIdx = Math.max(0, Math.min(frameTimeline.length - 1, frameIndex + s));
          const sampleFile = frameTimeline[sampleIdx];
          const sampleTexture = textureMap.get(sampleFile);
          samples.push(sampleTexture);
        }
        
        const pixels = renderer.renderBlendedFrame(samples, weights);
        frames.push(renderer.getFrameAsCanvas(pixels));
      } else {
        // No motion blur - direct render
        const pixels = renderer.renderBlendedFrame([texture], [1.0]);
        frames.push(renderer.getFrameAsCanvas(pixels));
      }
    }

    renderer.cleanup();
    return frames;
  }

  async writeFramesToAVIF(frames, outputPath, options) {
    const tempDir = path.join(path.dirname(outputPath), '._temp_frames');
    await fs.mkdir(tempDir, { recursive: true });

    try {
      // Write frames as PNGs
      const framePaths = [];
      for (let i = 0; i < frames.length; i++) {
        const framePath = path.join(tempDir, `frame_${String(i).padStart(6, '0')}.png`);
        const buffer = frames[i].toBuffer('image/png');
        await fs.writeFile(framePath, buffer);
        framePaths.push(framePath);
      }

      // Create concat file
      const listFile = path.join(tempDir, 'frames.txt');
      const frameDuration = 1 / GAME_FPS;
      const lines = framePaths.map(p => `file '${p}'\nduration ${frameDuration.toFixed(6)}`).join('\n');
      await fs.writeFile(listFile, lines + `\nfile '${framePaths[framePaths.length - 1]}'`);

      // Encode to AVIF
      const ffmpegArgs = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-fps_mode', 'cfr',
        '-r', String(GAME_FPS),
        '-c:v', 'libaom-av1',
        '-crf', String(options.crf ?? 40),
        '-cpu-used', String(options.speed ?? 6),
        '-pix_fmt', 'yuv420p',
        '-still-picture', '0',
        '-movflags', '+faststart',
        outputPath
      ];

      await execFileAsync('ffmpeg', ffmpegArgs);
    } finally {
      // Cleanup temp files
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

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
        const spriteData = this.findSpriteDataForImage(firstImagePath, imagesRoot, spriteDataMap);
        const spriteFps = spriteData.fps || options.fps || 10;
        const shouldRewind = spriteData.rewind;

        const sequence = this.generateSequence(seqFiles, spriteFps, shouldRewind);
        const isLowFrameCount = seqFiles.length <= ADAPTIVE_LOW_FRAME_THRESHOLD;

        const outName = this.sanitizeFilename(baseName);
        const outputPath = path.join(dir, `${outName}.avif`);

        const blurTag = ENABLE_MOTION_BLUR 
          ? ` | blur=${MOTION_BLUR_SAMPLES}x${isLowFrameCount ? ' (enhanced)' : ''}`
          : '';
        
        console.log(
          `▶ ${path.relative(imagesRoot, dir)}/${baseName} | fps=${spriteFps} | frames=${seqFiles.length}${blurTag}`
        );

        try {
          const renderedFrames = await this.renderSequenceWithOpenGL(dir, sequence, spriteFps, isLowFrameCount);
          await this.writeFramesToAVIF(renderedFrames, outputPath, options);
          converted++;
        } catch (e) {
          console.error(`✖ Failed: ${outputPath}`, e.message);
          console.error(e.stack);
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