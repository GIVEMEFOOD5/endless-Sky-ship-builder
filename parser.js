// parser.js - Endless Sky data parser for GitHub Actions
const https = require('https');
const fs = require('fs').promises;
const path = require('path');

class EndlessSkyParser {
  constructor() {
    this.ships = [];
    this.variants = [];
    this.outfits = [];
    this.pendingVariants = [];
  }

  fetchUrl(url) {
    return new Promise((resolve, reject) => {
      const options = { headers: {} };
      
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

  async fetchGitHubRepo(owner, repo, branch) {
    if (!branch) branch = 'master';
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    
    console.log(`Fetching repository tree for ${owner}/${repo}...`);
    
    const data = await this.fetchUrl(apiUrl);
    const tree = JSON.parse(data);
    
    if (tree.message) throw new Error(`GitHub API Error: ${tree.message}`);
    if (!tree.tree) throw new Error(`No tree data found. API may have rate limited the request.`);
    
    const dataFiles = tree.tree.filter((file) => {
      return file.path.includes('data/') && file.path.endsWith('.txt') && file.type === 'blob';
    });
    
    console.log(`Found ${dataFiles.length} .txt files in data/ directory`);
    
    const fileContents = [];
    for (const file of dataFiles) {
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

  parseIndentedBlock(lines, startIdx) {
    const data = {};
    let i = startIdx;
    const baseIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    let descriptionLines = [];
    
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      
      const currentIndent = line.length - line.replace(/^\t+/, '').length;
      if (currentIndent < baseIndent) break;
      
      if (currentIndent === baseIndent) {
        const stripped = line.trim();
        
        const unquotedKeyMatch = stripped.match(/^([a-z\s]+)\s+"([^"]+)"$/i);
        if (unquotedKeyMatch) {
          data[unquotedKeyMatch[1].trim()] = unquotedKeyMatch[2];
          i++;
          continue;
        }
        
        if (stripped.includes('"')) {
          const match = stripped.match(/"([^"]+)"(?:\s+(.*))?/);
          if (match) {
            const key = match[1];
            const valueStr = (match[2] || '').trim().replace(/^["'`]|["'`]$/g, '');
            let value = !valueStr ? true : (isNaN(parseFloat(valueStr)) ? valueStr : parseFloat(valueStr));
            
            if (key in data) {
              if (!Array.isArray(data[key])) data[key] = [data[key]];
              data[key].push(value);
            } else {
              data[key] = value;
            }
            i++;
            continue;
          }
        }
        
        if (stripped.includes('`')) {
          const match = stripped.match(/`([^`]+)`(?:\s+(.*))?/);
          if (match) {
            const key = match[1];
            const valueStr = (match[2] || '').trim().replace(/^["'`]|["'`]$/g, '');
            let value = !valueStr ? true : (isNaN(parseFloat(valueStr)) ? valueStr : parseFloat(valueStr));
            
            if (key in data) {
              if (!Array.isArray(data[key])) data[key] = [data[key]];
              data[key].push(value);
            } else {
              data[key] = value;
            }
            i++;
            continue;
          }
        }
        
        const simpleMatch = stripped.match(/^(\S+)\s+(.+)$/);
        if (simpleMatch && !stripped.includes('"') && !stripped.includes('`')) {
          const num = parseFloat(simpleMatch[2].trim());
          data[simpleMatch[1]] = isNaN(num) ? simpleMatch[2].trim() : num;
          i++;
          continue;
        }
        
        if (i + 1 < lines.length) {
          const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (nextIndent > currentIndent) {
            const key = stripped.replace(/"/g, '').replace(/`/g, '');
            const result = this.parseIndentedBlock(lines, i + 1);
            const nestedData = result[0];
            const nextI = result[1];
            
            if (key in data) {
              if (!Array.isArray(data[key])) data[key] = [data[key]];
              data[key].push(nestedData);
            } else {
              data[key] = nestedData;
            }
            
            i = nextI;
            continue;
          } else {
            descriptionLines.push(stripped);
          }
        } else {
          descriptionLines.push(stripped);
        }
      }
      
      i++;
    }
    
    if (descriptionLines.length > 0) {
      data.description = descriptionLines.join(' ');
    }
    
    return [data, i];
  }

  parseShip(lines, startIdx) {
    const line = lines[startIdx].trim();
    const matchQuotes = line.match(/^ship\s+"([^"]+)"(?:\s+"([^"]+)")?/);
    const matchBackticks = line.match(/^ship\s+`([^`]+)`(?:\s+`([^`]+)`)?/);
    const match = matchBackticks || matchQuotes;
    
    if (!match) return [null, startIdx + 1];
    
    const baseName = match[1];
    const variantName = match[2];
    
    if (variantName) {
      this.pendingVariants.push({
        baseName: baseName,
        variantName: variantName,
        startIdx: startIdx,
        lines: lines
      });
      
      let i = startIdx + 1;
      while (i < lines.length) {
        const currentLine = lines[i];
        if (!currentLine.trim()) { i++; continue; }
        const indent = currentLine.length - currentLine.replace(/^\t+/, '').length;
        if (indent === 0) break;
        i++;
      }
      return [null, i];
    }
    
    const shipData = { 
      name: baseName,
      engines: [],
      reverseEngines: [],
      steeringEngines: [],
      guns: [],
      turrets: [],
      bays: []
    };
    
    let descriptionLines = [];
    let i = startIdx + 1;
    
    while (i < lines.length) {
      const currentLine = lines[i];
      if (!currentLine.trim()) { i++; continue; }
      
      const indent = currentLine.length - currentLine.replace(/^\t+/, '').length;
      if (indent === 0 && currentLine.trim()) break;
      
      const stripped = currentLine.trim();
      
      if (indent === 1) {
        if (stripped.startsWith('"engine"') || stripped.startsWith('engine') || stripped.startsWith('`engine`')) {
          const parts = stripped.substring(7).trim().split(/\s+/);
          const engineData = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
          if (parts[2]) engineData.zoom = parseFloat(parts[2]);
          shipData.engines.push(engineData);
          i++;
          continue;
        }
        
        if (stripped.startsWith('"reverse engine"') || stripped.startsWith('reverse engine') || stripped.startsWith('`reverse engine`')) {
          const parts = stripped.replace(/"/g, '').replace(/`/g, '').substring(14).trim().split(/\s+/);
          const reverseEngineData = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
          if (parts[2]) reverseEngineData.zoom = parseFloat(parts[2]);
          
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i++;
              while (i < lines.length) {
                const propLine = lines[i];
                const propIndent = propLine.length - propLine.replace(/^\t+/, '').length;
                if (propIndent <= indent) break;
                const propStripped = propLine.trim();
                if (propStripped) reverseEngineData.position = propStripped;
                i++;
              }
              shipData.reverseEngines.push(reverseEngineData);
              continue;
            }
          }
          
          shipData.reverseEngines.push(reverseEngineData);
          i++;
          continue;
        }
        
        if (stripped.startsWith('"steering engine"') || stripped.startsWith('steering engine') || stripped.startsWith('`steering engine`')) {
          const parts = stripped.replace(/"/g, '').replace(/`/g, '').substring(15).trim().split(/\s+/);
          const steeringEngineData = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
          if (parts[2]) steeringEngineData.zoom = parseFloat(parts[2]);
          
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i++;
              while (i < lines.length) {
                const propLine = lines[i];
                const propIndent = propLine.length - propLine.replace(/^\t+/, '').length;
                if (propIndent <= indent) break;
                const propStripped = propLine.trim();
                if (propStripped) steeringEngineData.position = propStripped;
                i++;
              }
              shipData.steeringEngines.push(steeringEngineData);
              continue;
            }
          }
          
          shipData.steeringEngines.push(steeringEngineData);
          i++;
          continue;
        }
        
        if (stripped.startsWith('"gun"') || stripped.startsWith('gun') || stripped.startsWith('`gun`')) {
          const parts = stripped.substring(4).trim().split(/\s+/);
          shipData.guns.push({ x: parseFloat(parts[0]), y: parseFloat(parts[1]), gun: "" });
          i++;
          continue;
        }
        
        if (stripped.startsWith('"turret"') || stripped.startsWith('turret') || stripped.startsWith('`turret`')) {
          const parts = stripped.substring(7).trim().split(/\s+/);
          shipData.turrets.push({ x: parseFloat(parts[0]), y: parseFloat(parts[1]), turret: "" });
          i++;
          continue;
        }
        
        if (stripped.startsWith('"bay"') || stripped.startsWith('bay') || stripped.startsWith('`bay`')) {
          const bayMatchQuotes = stripped.match(/bay\s+"([^"]+)"\s+([^\s]+)\s+([^\s]+)(?:\s+(.+))?/);
          const bayMatchBackticks = stripped.match(/bay\s+`([^`]+)`\s+([^\s]+)\s+([^\s]+)(?:\s+(.+))?/);
          const bayMatch = bayMatchBackticks || bayMatchQuotes;
          if (bayMatch) {
            const bayData = { type: bayMatch[1], x: parseFloat(bayMatch[2]), y: parseFloat(bayMatch[3]) };
            if (bayMatch[4]) bayData.position = bayMatch[4];
            
            if (i + 1 < lines.length) {
              const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
              if (nextIndent > indent) {
                i++;
                while (i < lines.length) {
                  const bayLine = lines[i];
                  const bayLineIndent = bayLine.length - bayLine.replace(/^\t+/, '').length;
                  if (bayLineIndent <= indent) break;
                  const bayLineStripped = bayLine.trim();
                  const effectMatchQuotes = bayLineStripped.match(/"([^"]+)"\s+"([^"]+)"/);
                  const effectMatchBackticks = bayLineStripped.match(/`([^`]+)`\s+`([^`]+)`/);
                  const effectMatch = effectMatchBackticks || effectMatchQuotes;
                  if (effectMatch) bayData[effectMatch[1]] = effectMatch[2];
                  i++;
                }
                shipData.bays.push(bayData);
                continue;
              }
            }
            
            shipData.bays.push(bayData);
            i++;
            continue;
          }
        }
        
        if (stripped === 'add attributes') {
          i++;
          while (i < lines.length) {
            const attrLine = lines[i];
            const attrIndent = attrLine.length - attrLine.replace(/^\t+/, '').length;
            if (attrIndent <= indent) break;
            i++;
          }
          continue;
        }
        
        if (stripped === 'outfits') {
          i++;
          while (i < lines.length) {
            const nextLine = lines[i];
            const nextIndent = nextLine.length - nextLine.replace(/^\t+/, '').length;
            if (nextIndent <= indent && nextLine.trim()) break;
            i++;
          }
          continue;
        }
        
        if (stripped === 'description' || stripped.startsWith('description ')) {
          const descMatch = stripped.match(/description\s+[`"](.+)[`"]$/);
          if (descMatch) {
            descriptionLines.push(descMatch[1]);
            i++;
            continue;
          }
          
          const startMatch = stripped.match(/description\s+[`"](.*)$/);
          if (startMatch) {
            const startText = startMatch[1];
            if (startText.endsWith('`') || startText.endsWith('"')) {
              descriptionLines.push(startText.slice(0, -1));
              i++;
              continue;
            }
            if (startText) descriptionLines.push(startText);
            i++;
            
            while (i < lines.length) {
              const descLine = lines[i];
              const descStripped = descLine.trim();
              
              if (descStripped.endsWith('`') || descStripped.endsWith('"')) {
                const finalText = descStripped.slice(0, -1);
                if (finalText) descriptionLines.push(finalText);
                i++;
                break;
              }
              
              const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
              if (descIndent <= indent && descLine.trim()) break;
              
              if (descStripped) descriptionLines.push(descStripped);
              i++;
            }
            continue;
          }
          
          i++;
          while (i < lines.length) {
            const descLine = lines[i];
            const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
            if (descIndent <= indent) break;
            const descStripped = descLine.trim();
            if (descStripped) descriptionLines.push(descStripped);
            i++;
          }
          continue;
        }

        // Handle sprite
        if (stripped.startsWith('sprite ')) {
          const spriteMatchQuotes = stripped.match(/sprite\s+"([^"]+)"/);
          const spriteMatchBackticks = stripped.match(/sprite\s+`([^`]+)`/);
          const spriteMatch = spriteMatchBackticks || spriteMatchQuotes;
          if (spriteMatch) {
            shipData.sprite = spriteMatch[1];
          }
          i++;
          continue;
        }
        
        // Handle thumbnail
        if (stripped.startsWith('thumbnail ')) {
          const thumbMatchQuotes = stripped.match(/thumbnail\s+"([^"]+)"/);
          const thumbMatchBackticks = stripped.match(/thumbnail\s+`([^`]+)`/);
          const thumbMatch = thumbMatchBackticks || thumbMatchQuotes;
          if (thumbMatch) {
            shipData.thumbnail = thumbMatch[1];
          }
          i++;
          continue;
        }
        
        if (stripped.includes('"')) {
          const matchResult = stripped.match(/"([^"]+)"(?:\s+(.*))?/);
          if (matchResult) {
            const key = matchResult[1];
            const value = (matchResult[2] || '').trim();
            shipData[key] = value || true;
          }
        } else if (stripped.includes('`')) {
          const matchResult = stripped.match(/`([^`]+)`(?:\s+(.*))?/);
          if (matchResult) {
            const key = matchResult[1];
            const value = (matchResult[2] || '').trim();
            shipData[key] = value || true;
          }
        } else if (i + 1 < lines.length) {
          const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (nextIndent > indent) {
            const key = stripped.replace(/"/g, '').replace(/`/g, '');
            if (key === 'leak' || key === 'explode' || key === 'final explode') { i++; continue; }
            
            const result = this.parseIndentedBlock(lines, i + 1);
            shipData[key] = result[0];
            i = result[1];
            continue;
          }
        }
      }
      
      i++;
    }
    
    if (descriptionLines.length > 0) {
      shipData.description = descriptionLines.join(' ');
    }

    if (shipData.description == null || shipData.description == "") {
      return [null, i];
    }
    
    return [shipData, i];
  }

  parseShipVariant(variantInfo) {
    const baseShip = this.ships.find(s => s.name === variantInfo.baseName);
    
    if (!baseShip) {
      console.warn(`Warning: Base ship "${variantInfo.baseName}" not found for variant "${variantInfo.variantName}"`);
      return null;
    }
    
    const variantShip = JSON.parse(JSON.stringify(baseShip));
    variantShip.name = `${variantInfo.baseName} (${variantInfo.variantName})`;
    variantShip.variant = variantInfo.variantName;
    variantShip.baseShip = variantInfo.baseName;
    
    let replaceGuns = false, replaceTurrets = false, replaceBays = false;
    let replaceEngines = false, replaceReverseEngines = false, replaceSteeringEngines = false;
    let newGuns = [], newTurrets = [], newBays = [];
    let newEngines = [], newReverseEngines = [], newSteeringEngines = [];
    let hasSignificantChanges = false;
    
    let i = variantInfo.startIdx + 1;
    const lines = variantInfo.lines;
    
    // Check if the first indented line is a display name for the variant
    if (i < lines.length) {
      const firstLine = lines[i];
      const firstIndent = firstLine.length - firstLine.replace(/^\t+/, '').length;
      if (firstIndent === 1) {
        const firstStripped = firstLine.trim();

        // "display name" can use quotes or backticks, value can also use quotes or backticks
        const displayMatch1 = firstStripped.match(/^"display name"\s+"([^"]+)"$/);
        const displayMatch2 = firstStripped.match(/^"display name"\s+`(.+)`$/);
        const displayMatch3 = firstStripped.match(/^`display name`\s+"([^"]+)"$/);
        const displayMatch4 = firstStripped.match(/^`display name`\s+`(.+)`$/);
        const displayMatch = displayMatch1 || displayMatch2 || displayMatch3 || displayMatch4;
        if (displayMatch) {
          variantShip.displayName = displayMatch[1];
          hasSignificantChanges = true;
          i++; // Move past the display name line
        }
      }
    }
    
    while (i < lines.length) {
      const currentLine = lines[i];
      if (!currentLine.trim()) { i++; continue; }
      
      const indent = currentLine.length - currentLine.replace(/^\t+/, '').length;
      if (indent === 0) break;
      
      const stripped = currentLine.trim();
      
      if (indent === 1) {
        if (stripped === 'outfits') {
          i++;
          while (i < lines.length) {
            const nextLine = lines[i];
            const nextIndent = nextLine.length - nextLine.replace(/^\t+/, '').length;
            if (nextIndent <= indent && nextLine.trim()) break;
            i++;
          }
          continue;
        }
        
        if (stripped.startsWith('sprite ')) {
          const spriteMatchQuotes = stripped.match(/sprite\s+"([^"]+)"/);
          const spriteMatchBackticks = stripped.match(/sprite\s+`([^`]+)`/);
          const spriteMatch = spriteMatchBackticks || spriteMatchQuotes;
          if (spriteMatch && spriteMatch[1] !== baseShip.sprite) {
            variantShip.sprite = spriteMatch[1];
            hasSignificantChanges = true;
          }
          i++;
          continue;
        }
                
        if (stripped.startsWith('thumbnail ')) {
          const thumbMatchQuotes = stripped.match(/thumbnail\s+"([^"]+)"/);
          const thumbMatchBackticks = stripped.match(/thumbnail\s+`([^`]+)`/);
          const thumbMatch = thumbMatchBackticks || thumbMatchQuotes;
          if (thumbMatch && thumbMatch[1] !== baseShip.thumbnail) {
            variantShip.thumbnail = thumbMatch[1];
            hasSignificantChanges = true;
          }
          i++;
          continue;
        }
        
        if (stripped === 'add attributes') {
          hasSignificantChanges = true;
          i++;
          if (!variantShip.attributes) variantShip.attributes = {};
          while (i < lines.length) {
            const attrLine = lines[i];
            const attrIndent = attrLine.length - attrLine.replace(/^\t+/, '').length;
            if (attrIndent <= indent) break;
            const attrStripped = attrLine.trim();
            
            const quotedMatchQuotes = attrStripped.match(/"([^"]+)"\s+(.+)/);
            const quotedMatchBackticks = attrStripped.match(/`([^`]+)`\s+(.+)/);
            const quotedMatch = quotedMatchBackticks || quotedMatchQuotes;
            if (quotedMatch) {
              const key = quotedMatch[1];
              const num = parseFloat(quotedMatch[2].trim());
              const value = isNaN(num) ? quotedMatch[2].trim() : num;
              
              if (key in variantShip.attributes && typeof variantShip.attributes[key] === 'number' && typeof value === 'number') {
                variantShip.attributes[key] += value;
              } else {
                variantShip.attributes[key] = value;
              }
            }
            i++;
          }
          continue;
        }
        
        if (stripped.match(/^["'`]?engine["'`]?\s+(-?\d+)/)) { //stripped.startsWith('"steering engine"') || stripped.startsWith(/steering engine\s+(-?\d+)/) || stripped.startsWith('`steering engine`')
          hasSignificantChanges = true;
          replaceEngines = true;
          const parts = stripped.substring(7).trim().split(/\s+/);
          const engineData = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
          if (parts[2]) engineData.zoom = parseFloat(parts[2]);
          newEngines.push(engineData);
          i++;
          continue;
        }
        
        if (stripped.match(/^["'`]?reverse engine["'`]?\s+(-?\d+)/)) {
          hasSignificantChanges = true;
          replaceReverseEngines = true;
          const parts = stripped.replace(/"/g, '').replace(/`/g, '').substring(14).trim().split(/\s+/);
          const reverseEngineData = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
          if (parts[2]) reverseEngineData.zoom = parseFloat(parts[2]);
          
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i++;
              while (i < lines.length) {
                const propLine = lines[i];
                const propIndent = propLine.length - propLine.replace(/^\t+/, '').length;
                if (propIndent <= indent) break;
                const propStripped = propLine.trim();
                if (propStripped) reverseEngineData.position = propStripped;
                i++;
              }
              newReverseEngines.push(reverseEngineData);
              continue;
            }
          }
          
          newReverseEngines.push(reverseEngineData);
          i++;
          continue;
        }
        
        if (stripped.match(/^["'`]?steering engine["'`]?\s+(-?\d+)/)) {
          hasSignificantChanges = true;
          replaceSteeringEngines = true;
          const parts = stripped.replace(/"/g, '').replace(/`/g, '').substring(15).trim().split(/\s+/);
          const steeringEngineData = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
          if (parts[2]) steeringEngineData.zoom = parseFloat(parts[2]);
          
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i++;
              while (i < lines.length) {
                const propLine = lines[i];
                const propIndent = propLine.length - propLine.replace(/^\t+/, '').length;
                if (propIndent <= indent) break;
                const propStripped = propLine.trim();
                if (propStripped) steeringEngineData.position = propStripped;
                i++;
              }
              newSteeringEngines.push(steeringEngineData);
              continue;
            }
          }
          
          newSteeringEngines.push(steeringEngineData);
          i++;
          continue;
        }
        
        if (stripped.match(/^["'`]?gun["'`]?\s+(-?\d+)/)) {
          hasSignificantChanges = true;
          replaceGuns = true;
          const parts = stripped.substring(4).trim().split(/\s+/);
          newGuns.push({ x: parseFloat(parts[0]), y: parseFloat(parts[1]), gun: "" });
          i++;
          continue;
        }
        
        if (stripped.match(/^["'`]?turret["'`]?\s+(-?\d+)/)) {
          hasSignificantChanges = true;
          replaceTurrets = true;
          const parts = stripped.substring(7).trim().split(/\s+/);
          newTurrets.push({ x: parseFloat(parts[0]), y: parseFloat(parts[1]), turret: "" });
          i++;
          continue;
        }

        const matchQuotes = stripped.match(/^["'`]?bay["'`]?\s+"([^"]+)"\s+(-?\d+\.?\d*)/);
        const matchBackticks = stripped.match(/^["'`]?bay["'`]?\s+`(.+?)`\s+(-?\d+\.?\d*)/);
        const matchUnquoted = stripped.match(/^["'`]?bay["'`]?\s+(\w+)\s+(-?\d+\.?\d*)/); ///^["'`]?engine["'`]?\s+(-?\d+)/
        const match = matchBackticks || matchQuotes || matchUnquoted;
        
        if (match) {
          hasSignificantChanges = true;
          replaceBays = true;
          const bayMatchQuotes = stripped.match(/bay\s+"([^"]+)"\s+([^\s]+)\s+([^\s]+)(?:\s+(.+))?/);
          const bayMatchBackticks = stripped.match(/bay\s+`([^`]+)`\s+([^\s]+)\s+([^\s]+)(?:\s+(.+))?/);
          const bayMatch = bayMatchBackticks || bayMatchQuotes;
          if (bayMatch) {
            const bayData = { type: bayMatch[1], x: parseFloat(bayMatch[2]), y: parseFloat(bayMatch[3]) };
            if (bayMatch[4]) bayData.position = bayMatch[4];
            
            if (i + 1 < lines.length) {
              const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
              if (nextIndent > indent) {
                i++;
                while (i < lines.length) {
                  const bayLine = lines[i];
                  const bayLineIndent = bayLine.length - bayLine.replace(/^\t+/, '').length;
                  if (bayLineIndent <= indent) break;
                  const bayLineStripped = bayLine.trim();
                  const effectMatchQuotes = bayLineStripped.match(/"([^"]+)"\s+"([^"]+)"/);
                  const effectMatchBackticks = bayLineStripped.match(/`([^`]+)`\s+`([^`]+)`/);
                  const effectMatch = effectMatchBackticks || effectMatchQuotes;
                  if (effectMatch) bayData[effectMatch[1]] = effectMatch[2];
                  i++;
                }
                newBays.push(bayData);
                continue;
              }
            }
            
            newBays.push(bayData);
            i++;
            continue;
          }
        }
      }
      
      i++;
    }
    
    if (replaceGuns) variantShip.guns = newGuns;
    if (replaceTurrets) variantShip.turrets = newTurrets;
    if (replaceBays) variantShip.bays = newBays;
    if (replaceEngines) variantShip.engines = newEngines;
    if (replaceReverseEngines) variantShip.reverseEngines = newReverseEngines;
    if (replaceSteeringEngines) variantShip.steeringEngines = newSteeringEngines;
    
    if (variantShip.description == null || variantShip.description == "") {
      return null;
    }

    return hasSignificantChanges ? variantShip : null;
  }

  processVariants() {
    console.log(`Processing ${this.pendingVariants.length} ship variants...`);
    
    for (const variantInfo of this.pendingVariants) {
      const variantShip = this.parseShipVariant(variantInfo);
      if (variantShip) {
        this.variants.push(variantShip);
        console.log(`  Added variant: ${variantShip.name}`);
      } else {
        console.log(`  Skipped variant (outfit-only): ${variantInfo.baseName} (${variantInfo.variantName})`);
      }
    }
  }

  parseOutfit(lines, startIdx) {
    const line = lines[startIdx].trim();
    
    // Debug: log lines that start with "outfit"
    if (line.startsWith('outfit')) {
      console.log('Parsing outfit line:', JSON.stringify(line));
    }
    
    // Match outfit names - backticks can contain any character including quotes and backticks
    // outfit `name` format - capture everything between first and last backtick
    const matchBackticks = line.match(/^outfit\s+`(.+)`\s*$/);
    // outfit "name" format - capture everything between quotes (no backticks inside)
    const matchQuotes = line.match(/^outfit\s+"([^"]+)"\s*$/);
    const match = matchBackticks || matchQuotes;
  
    if (!match) {
      if (line.startsWith('outfit')) {
        console.log('Failed to match outfit line:', JSON.stringify(line));
      }
      return [null, startIdx + 1];
    }
    
    console.log('Matched outfit:', match[1]);
    const outfitData = { name: match[1] };
    let descriptionLines = [];
    let i = startIdx + 1;
    
    // Check if the first indented line is a display name
    if (i < lines.length) {
      const firstLine = lines[i];
      const firstIndent = firstLine.length - firstLine.replace(/^\t+/, '').length;
      if (firstIndent === 1) {
        const firstStripped = firstLine.trim();
        // "display name" can use quotes or backticks, value can also use quotes or backticks
        const displayMatch1 = firstStripped.match(/^"display name"\s+"([^"]+)"$/);
        const displayMatch2 = firstStripped.match(/^"display name"\s+`(.+)`$/);
        const displayMatch3 = firstStripped.match(/^`display name`\s+"([^"]+)"$/);
        const displayMatch4 = firstStripped.match(/^`display name`\s+`(.+)`$/);
        const displayMatch = displayMatch1 || displayMatch2 || displayMatch3 || displayMatch4;
        if (displayMatch) {
          outfitData.displayName = displayMatch[1];
          i++; // Move past the display name line
        }
      }
    }
    
    while (i < lines.length) {
      const currentLine = lines[i];
      if (!currentLine.trim()) { i++; continue; }
      
      const indent = currentLine.length - currentLine.replace(/^\t+/, '').length;
      if (indent === 0 && currentLine.trim()) break;
      
      if (indent === 1) {
        const stripped = currentLine.trim();
        
        // Handle "key" "value" format (both quoted)
        const quotedBothMatch = stripped.match(/"([^"]+)"\s+"([^"]+)"/);
        if (quotedBothMatch) {
          outfitData[quotedBothMatch[1]] = quotedBothMatch[2];
          i++;
          continue;
        }

        // Handle "key" `value` format (quoted key, backtick value)
        const quotedKeyBacktickValueMatch = stripped.match(/"([^"]+)"\s+`([^`]+)`/);
        if (quotedKeyBacktickValueMatch) {
          outfitData[quotedKeyBacktickValueMatch[1]] = quotedKeyBacktickValueMatch[2];
          i++;
          continue;
        }

        // Handle `key` "value" format (backtick key, quoted value)
        const backtickKeyQuotedValueMatch = stripped.match(/`([^`]+)`\s+"([^"]+)"/);
        if (backtickKeyQuotedValueMatch) {
          outfitData[backtickKeyQuotedValueMatch[1]] = backtickKeyQuotedValueMatch[2];
          i++;
          continue;
        }

        // Handle `key` `value` format (both backticks)
        const backtickBothMatch = stripped.match(/`([^`]+)`\s+`([^`]+)`/);
        if (backtickBothMatch) {
          outfitData[backtickBothMatch[1]] = backtickBothMatch[2];
          i++;
          continue;
        }

        // Handle "key" value format (quoted key with unquoted value)
        const quotedKeyMatch = stripped.match(/"([^"]+)"\s+([^"`\s][^"`]*)/);
        if (quotedKeyMatch) {
          const valueStr = quotedKeyMatch[2].trim();
          const num = parseFloat(valueStr);
          outfitData[quotedKeyMatch[1]] = isNaN(num) ? valueStr : num;
          i++;
          continue;
        }

        // Handle `key` value format (backtick key with unquoted value)
        const backtickKeyMatch = stripped.match(/`([^`]+)`\s+([^"`\s][^"`]*)/);
        if (backtickKeyMatch) {
          const valueStr = backtickKeyMatch[2].trim();
          const num = parseFloat(valueStr);
          outfitData[backtickKeyMatch[1]] = isNaN(num) ? valueStr : num;
          i++;
          continue;
        }

        // Handle key "value" format (unquoted key with quoted value)
        const unquotedKeyQuotedValueMatch = stripped.match(/^(\S+)\s+"([^"]+)"$/);
        if (unquotedKeyQuotedValueMatch) {
          outfitData[unquotedKeyQuotedValueMatch[1]] = unquotedKeyQuotedValueMatch[2];
          i++;
          continue;
        }

        // Handle key `value` format (unquoted key with backtick value)
        const unquotedKeyBacktickValueMatch = stripped.match(/^(\S+)\s+`([^`]+)`$/);
        if (unquotedKeyBacktickValueMatch) {
          outfitData[unquotedKeyBacktickValueMatch[1]] = unquotedKeyBacktickValueMatch[2];
          i++;
          continue;
        }

        // Handle key value format (both unquoted) - must come last
        const simpleMatch = stripped.match(/^(\S+)\s+(.+)$/);
        if (simpleMatch && !stripped.startsWith('description')) {
          const key = simpleMatch[1];
          const valueStr = simpleMatch[2].trim();
          const num = parseFloat(valueStr);
          outfitData[key] = isNaN(num) ? valueStr : num;
          i++;
          continue;
        }

        
        // Handle description keyword (can use backticks or quotes)
        if (stripped === 'description' || stripped.startsWith('description ')) {
          // Check if description is on the same line (single line)
          const descMatch = stripped.match(/description\s+[`"](.+)[`"]$/);
          if (descMatch) {
            descriptionLines.push(descMatch[1]);
            i++;
            continue;
          }
          
          // Multi-line description starting with backtick or quote on same line
          const startMatch = stripped.match(/description\s+[`"](.*)$/);
          if (startMatch) {
            const startText = startMatch[1];
            // Check if it ends on the same line
            if (startText.endsWith('`') || startText.endsWith('"')) {
              descriptionLines.push(startText.slice(0, -1));
              i++;
              continue;
            }
            // Start of multi-line, add first part
            if (startText) {
              descriptionLines.push(startText);
            }
            i++;
            
            // Continue reading until we find the closing backtick/quote
            while (i < lines.length) {
              const descLine = lines[i];
              const descStripped = descLine.trim();
              
              // Check if this line ends the description
              if (descStripped.endsWith('`') || descStripped.endsWith('"')) {
                const finalText = descStripped.slice(0, -1);
                if (finalText) {
                  descriptionLines.push(finalText);
                }
                i++;
                break;
              }
              
              // Check if we've outdented (shouldn't happen in proper format)
              const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
              if (descIndent <= indent && descLine.trim()) {
                break;
              }
              
              if (descStripped) {
                descriptionLines.push(descStripped);
              }
              i++;
            }
            continue;
          }
          
          // Old format: indented description lines
          i++;
          while (i < lines.length) {
            const descLine = lines[i];
            const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
            if (descIndent <= indent) {
              break;
            }
            const descStripped = descLine.trim();
            if (descStripped) {
              descriptionLines.push(descStripped);
            }
            i++;
          }
          continue;
        }
        
        // Handle nested blocks (like weapon stats)
        if (i + 1 < lines.length) {
          const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (nextIndent > indent) {
            const key = stripped.replace(/"/g, '');
            const result = this.parseIndentedBlock(lines, i + 1);
            const nestedData = result[0];
            const nextI = result[1];
            outfitData[key] = nestedData;
            i = nextI;
            continue;
          }
        }
        
        // Single-word attributes (like series name)
        if (!stripped.includes(' ') && !stripped.includes('"')) {
          // This might be description text, collect it
          descriptionLines.push(stripped);
        }
      }
      
      i++;
    }
    
    // Combine description lines
    if (descriptionLines.length > 0) {
      outfitData.description = descriptionLines.join(' ');
    }

    if (outfitData.description == null || outfitData.description == "") {
      return [null, i];
    }
    
    return [outfitData, i];
  }

  parseFileContent(content) {
    var lines = content.split('\n');
    var i = 0;
  
    while (i < lines.length) {
      var line = lines[i].trim();
    
      if (line.startsWith('ship "') || line.startsWith('ship `')) {
        var result = this.parseShip(lines, i);
        var shipData = result[0];
        var nextI = result[1];
        if (shipData) {
          // Only add ships that have at least some attributes or hardpoints
          var hasData = shipData.attributes || 
                       shipData.engines.length > 0 || 
                       shipData.guns.length > 0 || 
                       shipData.turrets.length > 0 || 
                       shipData.bays.length > 0;
          if (hasData) {
            this.ships.push(shipData);
          }
        }
        i = nextI;
      } else if (line.startsWith('outfit "') || line.startsWith('outfit `')) {
        var result = this.parseOutfit(lines, i);
        var outfitData = result[0];
        var nextI = result[1];
        if (outfitData) {
          this.outfits.push(outfitData);
        }
        i = nextI;
      } else {
        i++;
      }
    }
  
    // DO NOT process variants here - it will be done once after all files are parsed
  }
  
  async parseRepository(repoUrl) {
    this.ships = [];
    this.variants = [];
    this.outfits = [];
    this.pendingVariants = []; // Reset pending variants
    
    var match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      throw new Error('Invalid GitHub URL: ' + repoUrl);
    }
    
    var owner = match[1];
    var repo = match[2].replace('.git', '');
    
    var branch = 'master';
    var branchMatch = repoUrl.match(/\/tree\/([^\/]+)/);
    if (branchMatch) {
      branch = branchMatch[1];
    }
    
    console.log('Parsing repository: ' + owner + '/' + repo + ' (branch: ' + branch + ')');
    
    var files = await this.fetchGitHubRepo(owner, repo, branch);
    
    console.log('Parsing ' + files.length + ' files...');
    for (var i = 0; i < files.length; i++) {
      this.parseFileContent(files[i].content);
    }
    
    // Process all variants ONCE after all files are parsed
    this.processVariants();
    
    console.log('Found ' + this.ships.length + ' ships, ' + this.variants.length + ' variants, and ' + this.outfits.length + ' outfits');
    
    return {
      ships: this.ships,
      variants: this.variants,
      outfits: this.outfits
    };
  }

  async downloadImages(owner, repo, branch, pluginDir) {
    console.log('\nDownloading images...');
    
    const imageDir = path.join(pluginDir, 'images');
    await fs.mkdir(imageDir, { recursive: true });
    
    const imagePaths = new Set();
    
    // Collect all sprite/thumbnail paths from ships
    for (const ship of this.ships) {
      if (ship.sprite) imagePaths.add(ship.sprite);
      if (ship.thumbnail) imagePaths.add(ship.thumbnail);
    }
    
    // Collect from variants
    for (const variant of this.variants) {
      if (variant.sprite) imagePaths.add(variant.sprite);
      if (variant.thumbnail) imagePaths.add(variant.thumbnail);
    }
    
    // Collect from outfits (if they have sprites)
    for (const outfit of this.outfits) {
      if (outfit.sprite) imagePaths.add(outfit.sprite);
      if (outfit.thumbnail) imagePaths.add(outfit.thumbnail);
    }
    
    console.log(`Found ${imagePaths.size} unique images to download`);
    
    let downloaded = 0;
    let failed = 0;
    
    // Download each image
    for (const imagePath of imagePaths) {
      // Try common image extensions
      let imageFound = false;
      for (const ext of ['.png', '.jpeg', '.avif']) {
        const fullPath = `${imagePath}${ext}`;
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fullPath}`;
        
        try {
          const imageData = await this.fetchUrl(rawUrl);
          
          // Save to local directory maintaining structure
          const localPath = path.join(imageDir, fullPath);
          await fs.mkdir(path.dirname(localPath), { recursive: true });
          await fs.writeFile(localPath, imageData);
          
          console.log(`  ✓ Downloaded ${fullPath}`);
          downloaded++;
          imageFound = true;
          break; // Found the image, stop trying extensions
        } catch (error) {
          // Image not found with this extension, try next
          continue;
        }
      }
      
      if (!imageFound) {
        console.log(`  ✗ Image not found: ${imagePath}`);
        failed++;
      }
    }
    
    console.log(`\nImage download complete: ${downloaded} downloaded, ${failed} not found`);
  }
}

async function main() {
  try {
    const configPath = path.join(process.cwd(), 'plugins.json');
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    console.log(`Found ${config.plugins.length} plugins to process\n`);
    
    for (const plugin of config.plugins) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing plugin: ${plugin.name}`);
      console.log(`${'='.repeat(60)}`);
      
      const parser = new EndlessSkyParser();
      const data = await parser.parseRepository(plugin.repository);
      
      // Create plugin directories
      const pluginDir = path.join(process.cwd(), 'data', plugin.name);
      const dataFilesDir = path.join(pluginDir, 'dataFiles');
      await fs.mkdir(dataFilesDir, { recursive: true });
      
      // Extract repo info for image downloading
      const repoMatch = plugin.repository.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (repoMatch) {
        const owner = repoMatch[1];
        const repo = repoMatch[2].replace('.git', '');
        const branchMatch = plugin.repository.match(/\/tree\/([^\/]+)/);
        const branch = branchMatch ? branchMatch[1] : 'master';
        
        // Download images to pluginDir/images/
        await parser.downloadImages(owner, repo, branch, pluginDir);
      }
      
      // Save JSON files to pluginDir/dataFiles/
      const shipsPath = path.join(dataFilesDir, 'ships.json');
      await fs.writeFile(shipsPath, JSON.stringify(data.ships, null, 2));
      console.log(`✓ Saved ${data.ships.length} ships to ${shipsPath}`);
      
      const variantsPath = path.join(dataFilesDir, 'variants.json');
      await fs.writeFile(variantsPath, JSON.stringify(data.variants, null, 2));
      console.log(`✓ Saved ${data.variants.length} variants to ${variantsPath}`);
      
      const outfitsPath = path.join(dataFilesDir, 'outfits.json');
      await fs.writeFile(outfitsPath, JSON.stringify(data.outfits, null, 2));
      console.log(`✓ Saved ${data.outfits.length} outfits to ${outfitsPath}`);
      
      const combinedPath = path.join(dataFilesDir, 'complete.json');
      await fs.writeFile(combinedPath, JSON.stringify({
        plugin: plugin.name,
        repository: plugin.repository,
        ships: data.ships,
        variants: data.variants,
        outfits: data.outfits,
        parsedAt: new Date().toISOString()
      }, null, 2));
      console.log(`✓ Saved complete data to ${combinedPath}`);
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

if (require.main === module) {
  main();
}

module.exports = EndlessSkyParser;
