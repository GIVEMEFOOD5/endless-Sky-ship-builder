// parser.js - Endless Sky data parser for GitHub Actions
// This script parses Endless Sky game data files from GitHub repositories
// It extracts ship, variant, and outfit information and downloads associated images

// Import required Node.js modules
const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const ImageConverter = require('./imageConverter');
const { exec: execCallback } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execCallback);

/**
 * Performs a sparse Git clone to download only the images directory
 * This is more efficient than cloning the entire repository
 * @param {string} owner - GitHub repository owner
 * @param {string} repo - GitHub repository name
 * @param {string} branch - Git branch to clone from
 * @param {string} targetDir - Local directory to clone into
 */
async function sparseCloneImages(owner, repo, branch, targetDir) {
  console.log(`Sparse cloning images from ${owner}/${repo}...`);
  
  // Clean up any existing directory to start fresh
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  const repoUrl = `https://github.com/${owner}/${repo}.git`;

  try {
    // Initialize sparse checkout - only downloads file metadata, not content
    await exec(`git clone --filter=blob:none --no-checkout --depth 1 --single-branch --branch ${branch} ${repoUrl} "${targetDir}"`);
    
    // Configure sparse checkout to use cone mode (more efficient)
    await exec(`git -C "${targetDir}" sparse-checkout init --cone`);
    
    // Specify that we only want the images directory
    await exec(`git -C "${targetDir}" sparse-checkout set images`);
    
    // Checkout only the images directory content
    await exec(`git -C "${targetDir}" checkout ${branch}`);
    
    console.log(`✓ Successfully cloned images directory`);
  } catch (error) {
    console.error(`Error during sparse clone: ${error.message}`);
    throw error;
  }
}

/**
 * Main parser class for Endless Sky data files
 * Handles parsing of ships, variants, and outfits from game data files
 */
class EndlessSkyParser {
  constructor() {
    // Arrays to store parsed game objects
    this.ships = [];
    this.variants = [];
    this.outfits = [];
    this.pendingVariants = []; // Temporary storage for variants until base ships are parsed
  }

  /**
   * Fetches text content from a URL using HTTPS
   * Adds GitHub authentication if token is available
   * @param {string} url - URL to fetch
   * @returns {Promise<string>} - Response text
   */
  fetchUrl(url) {
    return new Promise((resolve, reject) => {
      const options = { headers: {} };
      
      // Add GitHub token authentication if available to avoid rate limiting
      if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) {
        options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
        options.headers['User-Agent'] = 'endless-sky-parser';
      }
      
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { resolve(data); });
      }).on('error', reject);
    });
  }

  /**
   * Fetches binary content from a URL using HTTPS
   * Used for downloading image files
   * @param {string} url - URL to fetch
   * @returns {Promise<Buffer>} - Response as binary buffer
   */
  fetchBinaryUrl(url) {
    return new Promise((resolve, reject) => {
      const options = { headers: {} };

      // Add GitHub token authentication if available
      if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) {
        options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
        options.headers['User-Agent'] = 'endless-sky-parser';
      }

      https.get(url, options, (res) => {
        // Check for successful response
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        // Collect binary data chunks
        const chunks = [];
        res.on('data', (chunk) => { chunks.push(chunk); });
        res.on('end', () => { resolve(Buffer.concat(chunks)); });
      }).on('error', reject);
    });
  }

  /**
   * Recursively copies a directory and all its contents
   * @param {string} source - Source directory path
   * @param {string} destination - Destination directory path
   */
  async copyDirectory(source, destination) {
    // Create destination directory if it doesn't exist
    await fs.mkdir(destination, { recursive: true });
    
    // Read all entries in source directory
    const entries = await fs.readdir(source, { withFileTypes: true });
    
    // Process each entry
    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const destPath = path.join(destination, entry.name);
      
      if (entry.isDirectory()) {
        // Recursively copy subdirectories
        await this.copyDirectory(sourcePath, destPath);
      } else {
        // Copy files
        await fs.copyFile(sourcePath, destPath);
      }
    }
  }

  /**
   * Fetches the file tree from a GitHub repository
   * Uses GitHub API to get list of all files in the repository
   * @param {string} owner - GitHub repository owner
   * @param {string} repo - GitHub repository name
   * @param {string} branch - Git branch to fetch from
   * @returns {Promise<Array>} - Array of file objects with path and content
   */
  async fetchGitHubRepo(owner, repo, branch) {
    // Default to master branch if not specified
    if (!branch) branch = 'master';
    
    // Construct API URL to get recursive file tree
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    
    console.log(`Fetching repository tree for ${owner}/${repo}...`);
    
    // Fetch the tree data
    const data = await this.fetchUrl(apiUrl);
    const tree = JSON.parse(data);
    
    // Check for API errors
    if (tree.message) throw new Error(`GitHub API Error: ${tree.message}`);
    if (!tree.tree) throw new Error(`No tree data found. API may have rate limited the request.`);
    
    // Filter for .txt files in the data/ directory (game data files)
    const dataFiles = tree.tree.filter((file) => {
      return file.path.includes('data/') && file.path.endsWith('.txt') && file.type === 'blob';
    });
    
    console.log(`Found ${dataFiles.length} .txt files in data/ directory`);
    
    // Fetch content of each data file
    const fileContents = [];
    for (const file of dataFiles) {
      // Construct raw file URL
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
      console.log(`  Fetching ${file.path}...`);
      try {
        const content = await this.fetchUrl(rawUrl);
        fileContents.push({ path: file.path, content: content });
      } catch (error) {
        console.error(`  Error fetching ${file.path}:`, error.message);
      }
    }
    
    return fileContents;
  }

  /**
   * UNIFIED PARSER - Parses an indented block of text (nested data structure)
   * This single method handles all parsing for ships, variants, and outfits
   * Endless Sky uses tab indentation to represent nested data
   * 
   * @param {Array<string>} lines - Array of text lines
   * @param {number} startIdx - Starting line index
   * @param {Object} options - Parsing options for special handling
   * @returns {Array} - [parsed data object, next line index]
   */
  parseBlock(lines, startIdx, options = {}) {
    const data = {};
    let i = startIdx;
    
    // Calculate base indentation level
    const baseIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    let descriptionLines = [];

    while (i < lines.length) {
      const line = lines[i];
      
      // Skip empty lines
      if (!line.trim()) { 
        i++; 
        continue; 
      }

      // Calculate current line's indentation
      const currentIndent = line.length - line.replace(/^\t+/, '').length;
      
      // If we've outdented below base level, we're done with this block
      if (currentIndent < baseIndent) break;

      // Only process lines at our base indentation level
      // Lines with deeper indentation are handled by nested parseBlock() calls
      if (currentIndent === baseIndent) {
        const stripped = line.trim();

        // === SPECIAL HANDLING FOR HARDPOINTS (ships only) ===
        if (options.parseHardpoints) {
          const hardpointResult = this.parseHardpoint(stripped, lines, i, currentIndent);
          if (hardpointResult) {
            const [hardpointType, hardpointData, nextIdx] = hardpointResult;
            if (!data[hardpointType]) data[hardpointType] = [];
            data[hardpointType].push(hardpointData);
            i = nextIdx;
            continue;
          }
        }

        // === SPECIAL HANDLING FOR SKIP BLOCKS ===
        if (options.skipBlocks && options.skipBlocks.includes(stripped)) {
          i = this.skipIndentedBlock(lines, i, currentIndent);
          continue;
        }

        // === DESCRIPTION HANDLING ===
        if (stripped === 'description' || stripped.startsWith('description ')) {
          const [desc, nextIdx] = this.parseDescription(lines, i, currentIndent);
          if (desc) descriptionLines.push(...desc);
          i = nextIdx;
          continue;
        }

        // === SPRITE HANDLING (with optional nested data) ===
        if (stripped.startsWith('sprite ')) {
          const [spriteData, nextIdx] = this.parseSpriteWithData(lines, i, currentIndent);
          Object.assign(data, spriteData);
          i = nextIdx;
          continue;
        }

        // === NESTED BLOCK HANDLING ===
        if (i + 1 < lines.length) {
          const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (nextIndent > currentIndent) {
            const key = stripped.replace(/["`]/g, ''); // Remove quotes/backticks
            
            // Recursively parse nested block
            const result = this.parseBlock(lines, i + 1, options);
            const nestedData = result[0];
            const nextI = result[1];
            
            // Handle multiple nested blocks with same key
            if (key in data) {
              if (!Array.isArray(data[key])) data[key] = [data[key]];
              data[key].push(nestedData);
            } else {
              data[key] = nestedData;
            }
            
            // nextI points to the line that outdented from the nested block
            // This could be:
            // 1. Another line at our base level (continue processing)
            // 2. A line that outdented even further (will break on next iteration)
            i = nextI;
            continue;
          }
        }

        // === KEY-VALUE PAIR PARSING ===
        const kvResult = this.parseKeyValue(stripped);
        if (kvResult) {
          const [key, value] = kvResult;
          
          // Handle multiple values for same key (convert to array)
          if (key in data) {
            if (!Array.isArray(data[key])) data[key] = [data[key]];
            data[key].push(value);
          } else {
            data[key] = value;
          }
          i++;
          continue;
        }

        // === FALLBACK: Treat as description text ===
        descriptionLines.push(stripped);
      }
      
      i++;
    }
    
    // Combine description lines if any were collected
    if (descriptionLines.length > 0) {
      data.description = descriptionLines.join(' ');
    }
    
    return [data, i];
  }

  /**
   * Parses a key-value pair in any format
   * Handles: "key" "value", `key` `value`, key value, and all combinations
   * @param {string} stripped - Trimmed line text
   * @returns {Array|null} - [key, value] or null if no match
   */
  parseKeyValue(stripped) {
    // Try all quote/backtick combinations
    const patterns = [
      // "key" "value"
      { regex: /"([^"]+)"\s+"([^"]+)"/, keyIdx: 1, valueIdx: 2, isString: true },
      // "key" `value`
      { regex: /"([^"]+)"\s+`([^`]+)`/, keyIdx: 1, valueIdx: 2, isString: true },
      // `key` "value"
      { regex: /`([^`]+)`\s+"([^"]+)"/, keyIdx: 1, valueIdx: 2, isString: true },
      // `key` `value`
      { regex: /`([^`]+)`\s+`([^`]+)`/, keyIdx: 1, valueIdx: 2, isString: true },
      // "key" value (no quotes on value)
      { regex: /"([^"]+)"\s+([^"`\s][^"`]*)/, keyIdx: 1, valueIdx: 2, isString: false },
      // `key` value (no quotes on value)
      { regex: /`([^`]+)`\s+([^"`\s][^"`]*)/, keyIdx: 1, valueIdx: 2, isString: false },
      // key "value" (no quotes on key)
      { regex: /^(\S+)\s+"([^"]+)"$/, keyIdx: 1, valueIdx: 2, isString: true },
      // key `value` (no quotes on key)
      { regex: /^(\S+)\s+`([^`]+)`$/, keyIdx: 1, valueIdx: 2, isString: true },
      // key value (no quotes at all) - must not contain quotes/backticks
      { regex: /^(\S+)\s+(.+)$/, keyIdx: 1, valueIdx: 2, isString: false, noQuotes: true }
    ];

    for (const pattern of patterns) {
      // Skip patterns that require no quotes if quotes are present
      if (pattern.noQuotes && (stripped.includes('"') || stripped.includes('`'))) {
        continue;
      }

      const match = stripped.match(pattern.regex);
      if (match) {
        const key = match[pattern.keyIdx];
        const valueStr = match[pattern.valueIdx].trim();
        
        // Try to parse as number if not explicitly a string
        let value = valueStr;
        if (!pattern.isString) {
          const num = parseFloat(valueStr);
          value = isNaN(num) ? valueStr : num;
        }
        
        return [key, value];
      }
    }

    // Quoted or backticked single-word keys (like "repeat" or `no repeat`) - set to true
    const quotedKeyMatch = stripped.match(/^["'`]([^"'`]+)["'`]$/);
    if (quotedKeyMatch) {
      return [quotedKeyMatch[1], true];
    }

    // Unquoted single-word keys (like "repeat") - set to boolean true
    if (!stripped.includes(' ') && !stripped.includes('"') && !stripped.includes('`')) {
      return [stripped, true];
    }

    return null;
  }

  /**
   * Parses description field (can be single or multi-line)
   * @param {Array<string>} lines - Array of text lines
   * @param {number} i - Current line index
   * @param {number} baseIndent - Base indentation level
   * @returns {Array} - [description lines array, next line index]
   */
  parseDescription(lines, i, baseIndent) {
    const stripped = lines[i].trim();
    const descLines = [];

    // Single line: description "text" or description `text`
    const singleLineMatch = stripped.match(/description\s+[`"](.+)[`"]$/);
    if (singleLineMatch) {
      return [[singleLineMatch[1]], i + 1];
    }

    // Multi-line starting on same line: description "text...
    const startMatch = stripped.match(/description\s+[`"](.*)$/);
    if (startMatch) {
      const startText = startMatch[1];
      
      // Check if it ends on same line
      if (startText.endsWith('`') || startText.endsWith('"')) {
        return [[startText.slice(0, -1)], i + 1];
      }
      
      // Multi-line - collect until closing quote/backtick
      if (startText) descLines.push(startText);
      i++;
      
      while (i < lines.length) {
        const descLine = lines[i];
        const descStripped = descLine.trim();
        
        // Check if this line ends the description
        if (descStripped.endsWith('`') || descStripped.endsWith('"')) {
          const finalText = descStripped.slice(0, -1);
          if (finalText) descLines.push(finalText);
          return [descLines, i + 1];
        }
        
        // Check if we've outdented
        const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
        if (descIndent <= baseIndent && descLine.trim()) break;
        
        if (descStripped) descLines.push(descStripped);
        i++;
      }
      return [descLines, i];
    }

    // Old format: indented description lines (no quotes)
    i++;
    while (i < lines.length) {
      const descLine = lines[i];
      const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
      if (descIndent <= baseIndent) break;
      const descStripped = descLine.trim();
      if (descStripped) descLines.push(descStripped);
      i++;
    }
    
    return [descLines, i];
  }

  /**
   * Parses sprite with optional nested data (frame rate, etc.)
   * @param {Array<string>} lines - Array of text lines
   * @param {number} i - Current line index
   * @param {number} baseIndent - Base indentation level
   * @returns {Array} - [sprite data object, next line index]
   */
  parseSpriteWithData(lines, i, baseIndent) {
    const stripped = lines[i].trim();
    const result = {};

    // Extract sprite path
    const spriteMatch = stripped.match(/sprite\s+["'`]([^"'`]+)["'`]/) || 
                       stripped.match(/sprite\s+(\S+)/);
    
    if (spriteMatch) {
      result.sprite = spriteMatch[1];

      // Check for nested sprite data
      if (i + 1 < lines.length) {
        const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
        if (nextIndent > baseIndent) {
          const [spriteData, nextIdx] = this.parseBlock(lines, i + 1);
          result.spriteData = spriteData;
          return [result, nextIdx];
        }
      }
    }

    return [result, i + 1];
  }

  /**
   * Parses hardpoint definitions (engines, guns, turrets, bays)
   * @param {string} stripped - Trimmed line text
   * @param {Array<string>} lines - Array of text lines
   * @param {number} i - Current line index
   * @param {number} baseIndent - Base indentation level
   * @returns {Array|null} - [hardpoint type, data, next index] or null
   */
  parseHardpoint(stripped, lines, i, baseIndent) {
    // Engine: "engine" x y [zoom]
    if (stripped.match(/^["'`]?engine["'`]?\s+(-?\d+)/)) {
      const parts = stripped.replace(/["'`]/g, '').split(/\s+/).slice(1);
      const data = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
      if (parts[2]) data.zoom = parseFloat(parts[2]);
      return ['engines', data, i + 1];
    }

    // Reverse Engine: "reverse engine" x y [zoom] [position]
    if (stripped.match(/^["'`]?reverse engine["'`]?\s+(-?\d+)/)) {
      const parts = stripped.replace(/["'`]/g, '').split(/\s+/).slice(2);
      const data = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
      if (parts[2]) data.zoom = parseFloat(parts[2]);
      
      // Check for nested position property
      const nextIdx = this.parseOptionalNestedProperty(lines, i, baseIndent, data, 'position');
      return ['reverseEngines', data, nextIdx];
    }

    // Steering Engine: "steering engine" x y [zoom] [position]
    if (stripped.match(/^["'`]?steering engine["'`]?\s+(-?\d+)/)) {
      const parts = stripped.replace(/["'`]/g, '').split(/\s+/).slice(2);
      const data = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
      if (parts[2]) data.zoom = parseFloat(parts[2]);
      
      // Check for nested position property
      const nextIdx = this.parseOptionalNestedProperty(lines, i, baseIndent, data, 'position');
      return ['steeringEngines', data, nextIdx];
    }

    // Gun: "gun" x y
    if (stripped.match(/^["'`]?gun["'`]?\s+(-?\d+)/)) {
      const parts = stripped.replace(/["'`]/g, '').split(/\s+/).slice(1);
      const data = { x: parseFloat(parts[0]), y: parseFloat(parts[1]), gun: "" };
      return ['guns', data, i + 1];
    }

    // Turret: "turret" x y
    if (stripped.match(/^["'`]?turret["'`]?\s+(-?\d+)/)) {
      const parts = stripped.replace(/["'`]/g, '').split(/\s+/).slice(1);
      const data = { x: parseFloat(parts[0]), y: parseFloat(parts[1]), turret: "" };
      return ['turrets', data, i + 1];
    }

    // Bay: bay "type" x y [position]
    const bayMatch = stripped.match(/^["'`]?bay["'`]?\s+["'`]?([^"'`\s]+)["'`]?\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)(?:\s+(.+))?/);
    if (bayMatch) {
      const data = { 
        type: bayMatch[1], 
        x: parseFloat(bayMatch[2]), 
        y: parseFloat(bayMatch[3]) 
      };
      if (bayMatch[4]) data.position = bayMatch[4];
      
      // Check for nested bay properties
      if (i + 1 < lines.length) {
        const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
        if (nextIndent > baseIndent) {
          i++;
          while (i < lines.length) {
            const bayLine = lines[i];
            const bayLineIndent = bayLine.length - bayLine.replace(/^\t+/, '').length;
            if (bayLineIndent <= baseIndent) break;
            
            const bayLineStripped = bayLine.trim();
            const kvResult = this.parseKeyValue(bayLineStripped);
            if (kvResult) {
              data[kvResult[0]] = kvResult[1];
            }
            i++;
          }
          return ['bays', data, i];
        }
      }
      
      return ['bays', data, i + 1];
    }

    return null;
  }

  /**
   * Parses optional nested property (like position for engines)
   * @param {Array<string>} lines - Array of text lines
   * @param {number} i - Current line index
   * @param {number} baseIndent - Base indentation level
   * @param {Object} data - Data object to add property to
   * @param {string} propertyName - Name of the property to add
   * @returns {number} - Next line index
   */
  parseOptionalNestedProperty(lines, i, baseIndent, data, propertyName) {
    if (i + 1 < lines.length) {
      const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
      if (nextIndent > baseIndent) {
        i++;
        while (i < lines.length) {
          const propLine = lines[i];
          const propIndent = propLine.length - propLine.replace(/^\t+/, '').length;
          if (propIndent <= baseIndent) break;
          const propStripped = propLine.trim();
          if (propStripped) data[propertyName] = propStripped;
          i++;
        }
        return i;
      }
    }
    return i + 1;
  }

  /**
   * Skips an indented block (used for blocks we don't need to parse)
   * @param {Array<string>} lines - Array of text lines
   * @param {number} i - Current line index
   * @param {number} baseIndent - Base indentation level
   * @returns {number} - Next line index after block
   */
  skipIndentedBlock(lines, i, baseIndent) {
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= baseIndent) break;
      i++;
    }
    return i;
  }

  /**
   * Parses a ship definition from game data
   * @param {Array<string>} lines - Array of text lines
   * @param {number} startIdx - Starting line index
   * @returns {Array} - [parsed ship object, next line index]
   */
  parseShip(lines, startIdx) {
    const line = lines[startIdx].trim();
    
    // Match ship definition: ship "base name" or ship "base name" "variant name"
    const match = line.match(/^ship\s+["'`]([^"'`]+)["'`](?:\s+["'`]([^"'`]+)["'`])?/);
    if (!match) return [null, startIdx + 1];
    
    const baseName = match[1];
    const variantName = match[2];
    
    // Check if next line is indented - if not, this is an incomplete ship definition
    if (startIdx + 1 >= lines.length) {
      return [null, startIdx + 1]; // No next line, skip
    }
    
    const nextLine = lines[startIdx + 1];
    if (nextLine.trim()) { // If next line has content
      const nextIndent = nextLine.length - nextLine.replace(/^\t+/, '').length;
      if (nextIndent === 0) {
        // Next line is not indented, this ship has no data
        console.log(`  Skipping ship "${baseName}" - no indented content`);
        return [null, startIdx + 1];
      }
    }
    
    // If variant, store for later processing
    if (variantName) {
      this.pendingVariants.push({
        baseName: baseName,
        variantName: variantName,
        startIdx: startIdx,
        lines: lines
      });
      
      // Skip variant block
      return [null, this.skipIndentedBlock(lines, startIdx, 0)];
    }
    
    // Initialize ship with hardpoint arrays
    const shipData = { 
      name: baseName,
      engines: [],
      reverseEngines: [],
      steeringEngines: [],
      guns: [],
      turrets: [],
      bays: []
    };
    
    // Parse ship block with hardpoint and skip options
    const [parsedData, nextIdx] = this.parseBlock(lines, startIdx + 1, {
      parseHardpoints: true,
      skipBlocks: ['add attributes', 'outfits']
    });
    
    // Merge parsed data into ship data
    Object.assign(shipData, parsedData);
    
    // Only return ships with descriptions and some data
    const hasData = shipData.description && (
      shipData.attributes || 
      shipData.engines.length > 0 || 
      shipData.guns.length > 0 || 
      shipData.turrets.length > 0 || 
      shipData.bays.length > 0
    );
    
    return [hasData ? shipData : null, nextIdx];
  }

  /**
   * Parses a ship variant definition
   * Variants modify a base ship (different sprite, hardpoints, etc.)
   * @param {Object} variantInfo - Variant information including base ship name
   * @returns {Object|null} - Parsed variant ship or null if no significant changes
   */
  parseShipVariant(variantInfo) {
    // Find the base ship
    const baseShip = this.ships.find(s => s.name === variantInfo.baseName);
    if (!baseShip) {
      console.warn(`Warning: Base ship "${variantInfo.baseName}" not found`);
      return null;
    }
    
    // Check if variant has any indented content
    const startIdx = variantInfo.startIdx;
    if (startIdx + 1 >= variantInfo.lines.length) {
      console.log(`  Skipping variant "${variantInfo.variantName}" - no content`);
      return null; // No next line
    }
    
    const nextLine = variantInfo.lines[startIdx + 1];
    if (nextLine.trim()) { // If next line has content
      const nextIndent = nextLine.length - nextLine.replace(/^\t+/, '').length;
      if (nextIndent === 0) {
        // Next line is not indented, this variant has no modifications
        console.log(`  Skipping variant "${variantInfo.variantName}" - no indented content`);
        return null;
      }
    }
    
    // Deep copy base ship
    const variantShip = JSON.parse(JSON.stringify(baseShip));
    variantShip.name = `${variantInfo.baseName} (${variantInfo.variantName})`;
    variantShip.variant = variantInfo.variantName;
    variantShip.baseShip = variantInfo.baseName;
    
    // Parse variant modifications
    const [parsedData, nextIdx] = this.parseBlock(variantInfo.lines, variantInfo.startIdx + 1, {
      parseHardpoints: true,
      skipBlocks: ['outfits']
    });
    
    // Track significant changes
    let hasSignificantChanges = false;
    
    // Check for display name
    if (parsedData.displayName) {
      variantShip.displayName = parsedData.displayName;
      hasSignificantChanges = true;
    }
    
    // Check for sprite/thumbnail changes
    if (parsedData.sprite && parsedData.sprite !== baseShip.sprite) {
      variantShip.sprite = parsedData.sprite;
      if (parsedData.spriteData) variantShip.spriteData = parsedData.spriteData;
      hasSignificantChanges = true;
    }
    
    if (parsedData.thumbnail && parsedData.thumbnail !== baseShip.thumbnail) {
      variantShip.thumbnail = parsedData.thumbnail;
      hasSignificantChanges = true;
    }
    
    // Replace hardpoints if any were specified
    const hardpointTypes = ['engines', 'reverseEngines', 'steeringEngines', 'guns', 'turrets', 'bays'];
    for (const type of hardpointTypes) {
      if (parsedData[type] && parsedData[type].length > 0) {
        variantShip[type] = parsedData[type];
        hasSignificantChanges = true;
      }
    }
    
    // Handle "add attributes"
    if (parsedData['add attributes']) {
      hasSignificantChanges = true;
      if (!variantShip.attributes) variantShip.attributes = {};
      
      for (const [key, value] of Object.entries(parsedData['add attributes'])) {
        // Add to existing numeric values, otherwise replace
        if (key in variantShip.attributes && 
            typeof variantShip.attributes[key] === 'number' && 
            typeof value === 'number') {
          variantShip.attributes[key] += value;
        } else {
          variantShip.attributes[key] = value;
        }
      }
    }
    
    // Only return if has description and significant changes
    if (!variantShip.description) return null;
    return hasSignificantChanges ? variantShip : null;
  }

  /**
   * Processes all pending ship variants
   * Must be called after all base ships are parsed
   */
  processVariants() {
    console.log(`Processing ${this.pendingVariants.length} ship variants...`);
    
    for (const variantInfo of this.pendingVariants) {
      const variantShip = this.parseShipVariant(variantInfo);
      if (variantShip) {
        this.variants.push(variantShip);
        console.log(`  Added variant: ${variantShip.name}`);
      } else {
        console.log(`  Skipped variant: ${variantInfo.baseName} (${variantInfo.variantName})`);
      }
    }
  }

  /**
   * Parses an outfit (equipment) definition from game data
   * @param {Array<string>} lines - Array of text lines
   * @param {number} startIdx - Starting line index
   * @returns {Array} - [parsed outfit object, next line index]
   */
  parseOutfit(lines, startIdx) {
    const line = lines[startIdx].trim();
    
    // Match outfit name (backticks can contain any character, quotes cannot contain quotes)
    const match = line.match(/^outfit\s+["'`]([^"'`]+)["'`]\s*$/);
    if (!match) return [null, startIdx + 1];
    
    const outfitName = match[1];
    
    // Check if next line is indented - if not, this is an incomplete outfit definition
    if (startIdx + 1 >= lines.length) {
      return [null, startIdx + 1]; // No next line, skip
    }
    
    const nextLine = lines[startIdx + 1];
    if (nextLine.trim()) { // If next line has content
      const nextIndent = nextLine.length - nextLine.replace(/^\t+/, '').length;
      if (nextIndent === 0) {
        // Next line is not indented, this outfit has no data
        console.log(`  Skipping outfit "${outfitName}" - no indented content`);
        return [null, startIdx + 1];
      }
    }
    
    console.log('Matched outfit:', outfitName);
    
    const outfitData = { name: outfitName };
    
    // Parse outfit block (no hardpoints, no skip blocks)
    const [parsedData, nextIdx] = this.parseBlock(lines, startIdx + 1, {
      parseHardpoints: false
    });
    
    // Merge parsed data
    Object.assign(outfitData, parsedData);
    
    // Only return outfits with descriptions
    return [outfitData.description ? outfitData : null, nextIdx];
  }

  /**
   * Parses a single data file's content
   * Extracts all ships and outfits from the file
   * @param {string} content - File content as text
   */
  parseFileContent(content) {
    const lines = content.split('\n');
    let i = 0;
  
    while (i < lines.length) {
      const line = lines[i].trim();
    
      // Check for ship definition
      if (line.startsWith('ship "') || line.startsWith('ship `')) {
        const [shipData, nextI] = this.parseShip(lines, i);
        if (shipData) this.ships.push(shipData);
        i = nextI;
      } 
      // Check for outfit definition
      else if (line.startsWith('outfit "') || line.startsWith('outfit `')) {
        const [outfitData, nextI] = this.parseOutfit(lines, i);
        if (outfitData) this.outfits.push(outfitData);
        i = nextI;
      } 
      else {
        i++;
      }
    }
  }
  
  /**
   * Parses an entire GitHub repository
   * Fetches all data files and processes them
   * @param {string} repoUrl - GitHub repository URL
   * @returns {Promise<Object>} - Object containing ships, variants, and outfits
   */
  async parseRepository(repoUrl) {
    // Reset all data arrays
    this.ships = [];
    this.variants = [];
    this.outfits = [];
    this.pendingVariants = [];
    
    // Extract owner and repo from URL
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) throw new Error('Invalid GitHub URL: ' + repoUrl);
    
    const owner = match[1];
    const repo = match[2].replace('.git', '');
    
    // Extract branch if specified
    let branch = 'master';
    const branchMatch = repoUrl.match(/\/tree\/([^\/]+)/);
    if (branchMatch) branch = branchMatch[1];
    
    console.log(`Parsing repository: ${owner}/${repo} (branch: ${branch})`);
    
    // Fetch and parse all data files
    const files = await this.fetchGitHubRepo(owner, repo, branch);
    console.log(`Parsing ${files.length} files...`);
    
    for (const file of files) {
      this.parseFileContent(file.content);
    }
    
    // Process variants after all base ships are parsed
    this.processVariants();
    
    console.log(`Found ${this.ships.length} ships, ${this.variants.length} variants, and ${this.outfits.length} outfits`);
    
    return {
      ships: this.ships,
      variants: this.variants,
      outfits: this.outfits
    };
  }

  /**
   * Downloads images from the repository
   * Uses sparse checkout for efficiency and filters to only needed images
   * @param {string} owner - GitHub repository owner
   * @param {string} repo - GitHub repository name
   * @param {string} branch - Git branch
   * @param {string} pluginDir - Local plugin directory
   */
  async downloadImages(owner, repo, branch, pluginDir) {
    console.log('\nDownloading images (via sparse checkout)...');

    const tempRepoDir = path.join(pluginDir, '.tmp-images-repo');
    const imageDir = path.join(pluginDir, 'images');
    await fs.mkdir(imageDir, { recursive: true });

    try {
      // Sparse clone images directory
      await sparseCloneImages(owner, repo, branch, tempRepoDir);
      const sourceImagesDir = path.join(tempRepoDir, 'images');

      // Check if images directory exists
      try {
        await fs.access(sourceImagesDir);
      } catch (error) {
        console.log('No images directory found in repository');
        return;
      }

      // Collect all image paths from parsed objects
      const imagePaths = new Set();
      const addImagePath = (pathStr) => {
        if (pathStr) {
          // Remove last component (frame number) to get base path
          const basePath = pathStr.replace(/\/[^/]*$(?=.*\/)/, '');
          imagePaths.add(basePath);
        }
      };

      // Extract paths from ships, variants, and outfits
      for (const ship of this.ships) {
        addImagePath(ship.sprite);
        addImagePath(ship.thumbnail);
      }

      for (const variant of this.variants) {
        addImagePath(variant.sprite);
        addImagePath(variant.thumbnail);
      }

      for (const outfit of this.outfits) {
        addImagePath(outfit.sprite);
        addImagePath(outfit.thumbnail);
        addImagePath(outfit['flare sprite']);
        addImagePath(outfit['steering flare sprite']);
        addImagePath(outfit['reverse flare sprite']);
        addImagePath(outfit['afterburner effect']);
        
        if (outfit.weapon) {
          addImagePath(outfit.weapon['hardpoint sprite']);
          addImagePath(outfit.weapon.sprite);
        }
      }

      console.log(`Found ${imagePaths.size} unique image paths to process`);

      // Copy matching images
      for (const imagePath of imagePaths) {
        await this.copyMatchingImages(sourceImagesDir, imageDir, imagePath);
      }

      console.log(`✓ Successfully copied images to ${imageDir}`);

      // Clean up temporary repo
      await fs.rm(tempRepoDir, { recursive: true, force: true });
      console.log(`✓ Cleaned up temporary repository`);

    } catch (error) {
      console.error(`Error downloading images: ${error.message}`);
      try {
        await fs.rm(tempRepoDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Copies all matching image files for a given base path
   * @param {string} sourceDir - Source images directory
   * @param {string} destDir - Destination directory
   * @param {string} imagePath - Base image path to match
   */
  async copyMatchingImages(sourceDir, destDir, imagePath) {
    const normalizedPath = imagePath.replace(/\\/g, '/');
    const pathParts = normalizedPath.split('/');
    const basenamePattern = pathParts[pathParts.length - 1];
    const parentDir = pathParts.slice(0, -1).join('/');

    // Try both parent directory and subdirectory with basename
    const searchPaths = [
      { dir: path.join(sourceDir, parentDir), relative: parentDir },
      { dir: path.join(sourceDir, normalizedPath), relative: normalizedPath }
    ];
  
    for (const searchPath of searchPaths) {
      try {
        const stats = await fs.stat(searchPath.dir);
        if (!stats.isDirectory()) continue;

        const files = await fs.readdir(searchPath.dir);
        const escapedPattern = basenamePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Match various filename patterns (base, base-0, base.0, etc.)
        const matchingFiles = files.filter(fileName => {
          const fileExt = path.extname(fileName).toLowerCase();
          const fileBase = path.basename(fileName, fileExt);

          const patterns = [
            new RegExp(`^${escapedPattern}$`),              // exact match
            new RegExp(`^${escapedPattern}-\\d+$`),         // base-0
            new RegExp(`^${escapedPattern}\\.\\d+$`),       // base.0
            new RegExp(`^${escapedPattern}-.+\\d+$`),       // base-text0
            new RegExp(`^${escapedPattern}.+\\d+$`),        // base+0
            new RegExp(`^${escapedPattern}.$`),             // base+
            new RegExp(`^${escapedPattern}-.+$`),           // base-text
            new RegExp(`^${escapedPattern}.+$`)             // base+text
          ];

          const matches = patterns.some(p => fileBase.match(p));
          const validExt = ['.png', '.jpg', '.jpeg', '.gif', '.avif', '.webp'].includes(fileExt);
          
          return matches && validExt;
        });

        if (matchingFiles.length > 0) {
          const outputDir = path.join(destDir, searchPath.relative);
          await fs.mkdir(outputDir, { recursive: true });

          for (const fileName of matchingFiles) {
            const sourceFile = path.join(searchPath.dir, fileName);
            const destFile = path.join(outputDir, fileName);
            await fs.copyFile(sourceFile, destFile);
            console.log(`  ✓ Copied: ${searchPath.relative}/${fileName}`);
          }
          return; // Found files, done
        }
      } catch (error) {
        continue; // Try next path
      }
    }

    console.log(`  ✗ No files found for: ${normalizedPath}`);
  }
}

/**
 * Main execution function
 * Reads plugin configuration and processes each plugin
 */
async function main() {
  try {
    // Read plugin configuration
    const configPath = path.join(process.cwd(), 'plugins.json');
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    console.log(`Found ${config.plugins.length} plugins to process\n`);
    
    // Process each plugin
    for (const plugin of config.plugins) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing plugin: ${plugin.name}`);
      console.log(`${'='.repeat(60)}`);
      
      const parser = new EndlessSkyParser();
      const data = await parser.parseRepository(plugin.repository); 
      
      // Create output directories
      const pluginDir = path.join(process.cwd(), 'data', plugin.name);
      const dataFilesDir = path.join(pluginDir, 'dataFiles');
      await fs.mkdir(dataFilesDir, { recursive: true });
      
      // Download images
      const repoMatch = plugin.repository.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (repoMatch) {
        const owner = repoMatch[1];
        const repo = repoMatch[2].replace('.git', '');
        const branchMatch = plugin.repository.match(/\/tree\/([^\/]+)/);
        const branch = branchMatch ? branchMatch[1] : 'master';
        
        await parser.downloadImages(owner, repo, branch, pluginDir);

        // Convert image sequences to APNG
        const converter = new ImageConverter();
        await converter.processAllImages(pluginDir, data, { fps: null });
      }
      
      // Save JSON files
      await fs.writeFile(
        path.join(dataFilesDir, 'ships.json'), 
        JSON.stringify(data.ships, null, 2)
      );
      console.log(`✓ Saved ${data.ships.length} ships`);
      
      await fs.writeFile(
        path.join(dataFilesDir, 'variants.json'), 
        JSON.stringify(data.variants, null, 2)
      );
      console.log(`✓ Saved ${data.variants.length} variants`);
      
      await fs.writeFile(
        path.join(dataFilesDir, 'outfits.json'), 
        JSON.stringify(data.outfits, null, 2)
      );
      console.log(`✓ Saved ${data.outfits.length} outfits`);
      
      await fs.writeFile(
        path.join(dataFilesDir, 'complete.json'),
        JSON.stringify({
          plugin: plugin.name,
          repository: plugin.repository,
          ships: data.ships,
          variants: data.variants,
          outfits: data.outfits,
          parsedAt: new Date().toISOString()
        }, null, 2)
      );
      console.log(`✓ Saved complete data`);
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log('✓ All plugins processed successfully!');
    console.log(`${'='.repeat(60)}\n`);
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run main if executed directly
if (require.main === module) {
  main();
}

module.exports = EndlessSkyParser;