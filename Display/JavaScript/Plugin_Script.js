let allData = {};
let currentPlugin = null;
let currentTab = 'ships';
let filteredData = [];

async function loadData() {
    const repoUrl = document.getElementById('repoUrl').value.trim();
            
    if (!repoUrl) {
        showError('Please enter a GitHub repository URL');
        return;
    }

    const loadingIndicator = document.getElementById('loadingIndicator');
    const errorContainer = document.getElementById('errorContainer');
    const mainContent = document.getElementById('mainContent');

    loadingIndicator.style.display = 'block';
    errorContainer.innerHTML = '';
    mainContent.style.display = 'none';

    try {
        const apiServerUrl = `https://api.github.com`

        const baseUrl = `https://raw.githubusercontent.com/${repoUrl}/main/data`;
        
        const pluginsResponse = await fetch(`https://raw.githubusercontent.com/${repoUrl}/main/plugins.json`);
                
        if (!pluginsResponse.ok) {
            throw new Error('Could not find plugins.json in repository');
        }

        const pluginsConfig = await pluginsResponse.json();
        allData = {};

        for (const plugin of pluginsConfig.plugins) {
            const pluginData = {
                repository: plugin.repository,
                ships: [],
                variants: [],
                outfits: []
            };
        
            let loadedSomething = false;
        
            try {
                const shipsResponse = await fetch(`${baseUrl}/${plugin.name}/ships.json`);
                if (shipsResponse.ok) {
                    const rawText = await shipsResponse.text();
                    if (rawText.includes("version")) {
                        hardFindPluginFolder = await fetch(`${apiServerUrl}/repos/${repoUrl}/contents/data/${plugin.name}?ref=main`)
                        extractHardFindPluginFolder = await hardFindPluginFolder.json();

                        const shipsUrl = extractHardFindPluginFolder.find(f => f.name === 'ships.json')?.download_url;

                        if (!shipsUrl) {
                            console.warn('ships.json not found');
                        } else {
                            fetchedShipsData = await fetch(shipsUrl);
                            pluginData.ships = await fetchedShipsData.json();
                            loadedSomething = true;
                        }

                    } else {
                        pluginData.ships = await shipsResponse.json();
                        loadedSomething = true;
                    }

                } else {
                    console.warn(`${plugin.name}: ships.json not found (${shipsResponse.status})`);
                }
            
                const variantsResponse = await fetch(`${baseUrl}/${plugin.name}/variants.json`);
                if (variantsResponse.ok) {
                    const rawText = await variantsResponse.text();
                    if (rawText.includes("version")) {
                        hardFindPluginFolder = await fetch(`${apiServerUrl}/repos/${repoUrl}/contents/data/${plugin.name}?ref=main`)
                        extractHardFindPluginFolder = await hardFindPluginFolder.json();

                        const variantsUrl = extractHardFindPluginFolder.find(f => f.name === 'variants.json')?.download_url;

                        if (!variantsUrl) {
                            console.warn('variants.json not found');
                        } else {
                            fetchedVariantsData = await fetch(variantsUrl);
                            pluginData.variants = await fetchedVariantsData.json();
                            loadedSomething = true;
                        }

                    } else {
                        pluginData.variants = await variantsResponse.json();
                        loadedSomething = true;
                    }
                } else {
                    console.warn(`${plugin.name}: variants.json not found (${variantsResponse.status})`);
                }
            
                const outfitsResponse = await fetch(`${baseUrl}/${plugin.name}/outfits.json`);
                if (outfitsResponse.ok) {
                    const rawText = await outfitsResponse.text();
                    if (rawText.includes("version")) {
                        hardFindPluginFolder = await fetch(`${apiServerUrl}/repos/${repoUrl}/contents/data/${plugin.name}?ref=main`)
                        extractHardFindPluginFolder = await hardFindPluginFolder.json();

                        const outfitsUrl = extractHardFindPluginFolder.find(f => f.name === 'outfits.json')?.download_url;

                        if (!outfitsUrl) {
                            console.warn('outfits.json not found');
                        } else {
                            fetchedOutfitData = await fetch(outfitsUrl);
                            pluginData.outfits = await fetchedOutfitData.json();
                            loadedSomething = true;
                        }

                    } else {
                        pluginData.outfits = await outfitsResponse.json();
                        loadedSomething = true;
                    }
                } else {
                    console.warn(`${plugin.name}: outfits.json not found (${outfitsResponse.status})`);
                }
            
                // Only add plugin if at least ONE file loaded
                if (loadedSomething) {
                    allData[plugin.name] = pluginData;
                } else {
                    console.warn(`${plugin.name}: no data files found, skipping plugin`);
                }
            
            } catch (err) {
                console.warn(`Failed loading plugin ${plugin.name}`, err);
            }
        }

        const hasAnyData = Object.values(allData).some(plugin =>
            (plugin.ships && plugin.ships.length > 0) ||
            (plugin.variants && plugin.variants.length > 0) ||
            (plugin.outfits && plugin.outfits.length > 0)
        );

        if (!hasAnyData) {
            throw new Error('No plugin data files could be loaded');
        }

        loadingIndicator.style.display = 'none';
        mainContent.style.display = 'block';
        
        renderPluginSelector();
        currentPlugin = Object.keys(allData)[0];
        updateStats();
        renderCards();

    } catch (error) {
        loadingIndicator.style.display = 'none';
        showError(`Error loading data: ${error.message}`);
    }
}

function renderPluginSelector() {
    const selector = document.getElementById('pluginSelector');
    selector.innerHTML = '';

    Object.keys(allData).forEach(pluginName => {
        const btn = document.createElement('button');
        btn.className = 'plugin-btn';
        btn.textContent = pluginName;
        btn.onclick = () => selectPlugin(pluginName);
        selector.appendChild(btn);
    });

    if (selector.firstChild) {
        selector.firstChild.classList.add('active');
    }
}

function selectPlugin(pluginName) {
    currentPlugin = pluginName;
            
    document.querySelectorAll('.plugin-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === pluginName);
    });

    updateStats();
    renderCards();
}

function updateStats() {
    if (!currentPlugin || !allData[currentPlugin]) return;

    const data = allData[currentPlugin];
    const statsContainer = document.getElementById('stats');
    
    const totalShips = (data.ships ? data.ships.length : 0) + (data.variants ? data.variants.length : 0);
    const totalOutfits = data.outfits ? data.outfits.length : 0;
    
    statsContainer.innerHTML = `
        <div class="stat-card">
            <div class="stat-value">${data.ships ? data.ships.length : 0}</div>
            <div class="stat-label">Base Ships</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${data.variants ? data.variants.length : 0}</div>
            <div class="stat-label">Variants</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${totalOutfits}</div>
            <div class="stat-label">Outfits</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${totalShips + totalOutfits}</div>
            <div class="stat-label">Total Items</div>
        </div>
    `;
}

function switchTab(tab) {
    currentTab = tab;
            
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.textContent.toLowerCase() === tab);
    });

    renderCards();
}

function renderCards() {
    if (!currentPlugin || !allData[currentPlugin]) return;

    const container = document.getElementById('cardsContainer');
    const data = allData[currentPlugin];
    
    let items = [];
    if (currentTab === 'ships') {
        items = data.ships || [];
    } else if (currentTab === 'variants') {
        items = data.variants || [];
    } else {
        items = data.outfits || [];
    }

    filteredData = items;
    filterItems();
}

function filterItems() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const container = document.getElementById('cardsContainer');

    const filtered = filteredData.filter(item => 
        item.name && item.name.toLowerCase().includes(searchTerm)
    );

    container.innerHTML = '';

    if (filtered.length === 0) {
        container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #94a3b8; padding: 40px;">No items found</p>';
        return;
    }

    filtered.forEach(item => {
        const card = createCard(item);
        container.appendChild(card);
    });
}

function createCard(item) {
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => showDetails(item);

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.name || 'Unknown';

    const details = document.createElement('div');
    details.className = 'card-details';

    if (currentTab === 'ships' || currentTab === 'variants') {
        details.innerHTML = `
            <div class="detail-item">
                <div class="detail-label">Category</div>
                <div class="detail-value">${item.attributes?.category || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Cost</div>
                <div class="detail-value">${formatNumber(item.attributes?.cost) || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Hull</div>
                <div class="detail-value">${formatNumber(item.attributes?.hull) || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Shields</div>
                <div class="detail-value">${formatNumber(item.attributes?.shields) || 'N/A'}</div>
            </div>
        `;
    } else {
        details.innerHTML = `
            <div class="detail-item">
                <div class="detail-label">Category</div>
                <div class="detail-value">${item.category || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Cost</div>
                <div class="detail-value">${formatNumber(item.cost) || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Mass</div>
                <div class="detail-value">${item.mass || 'N/A'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Outfit Space</div>
                <div class="detail-value">${item['outfit space'] || 'N/A'}</div>
            </div>
        `;
    }

    card.appendChild(title);
    card.appendChild(details);

    return card;
}

function showDetails(item) {
    const modal = document.getElementById('detailModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');

    modalTitle.textContent = item.name || 'Unknown';

    let html = '';

    if (currentTab === 'ships' || currentTab === 'variants') {
        if (currentTab === 'variants' && item.baseShip) {
            html += `<p style="color: #93c5fd; margin-bottom: 20px;">Base Ship: ${item.baseShip}</p>`;
        }
        
        html += '<h3 style="color: #93c5fd; margin-top: 20px;">Attributes</h3>';
        html += '<div class="attribute-grid">';
        
        if (item.attributes) {
            Object.entries(item.attributes).forEach(([key, value]) => {
                if (typeof value !== 'object') {
                    html += `
                        <div class="attribute">
                            <div class="attribute-name">${key}</div>
                            <div class="attribute-value">${formatValue(value)}</div>
                        </div>
                    `;
                }
            });
        }
        
        html += '</div>';

        // Show hardpoint counts
        html += '<h3 style="color: #93c5fd; margin-top: 20px;">Hardpoints</h3>';
        html += '<div class="attribute-grid">';
        html += `
            <div class="attribute">
                <div class="attribute-name">Guns</div>
                <div class="attribute-value">${item.guns ? item.guns.length : 0}</div>
            </div>
            <div class="attribute">
                <div class="attribute-name">Turrets</div>
                <div class="attribute-value">${item.turrets ? item.turrets.length : 0}</div>
            </div>
            <div class="attribute">
                <div class="attribute-name">Bays</div>
                <div class="attribute-value">${item.bays ? item.bays.length : 0}</div>
            </div>
            <div class="attribute">
                <div class="attribute-name">Engines</div>
                <div class="attribute-value">${item.engines ? item.engines.length : 0}</div>
            </div>
        `;
        html += '</div>';

        if (item.description) {
            html += `<h3 style="color: #93c5fd; margin-top: 20px;">Description</h3>`;
            html += `<p style="margin-top: 10px; line-height: 1.6;">${item.description}</p>`;
        }
    } else {
        html += '<div class="attribute-grid">';
        
        Object.entries(item).forEach(([key, value]) => {
            if (key !== 'name' && typeof value !== 'object' && key !== 'description') {
                html += `
                    <div class="attribute">
                        <div class="attribute-name">${key}</div>
                        <div class="attribute-value">${formatValue(value)}</div>
                    </div>
                `;
            }
        });
        
        html += '</div>';

        if (item.description) {
            html += `<h3 style="color: #93c5fd; margin-top: 20px;">Description</h3>`;
            html += `<p style="margin-top: 10px; line-height: 1.6;">${item.description}</p>`;
        }
    }

    modalBody.innerHTML = html;
    modal.classList.add('active');
}

function closeModal() {
    document.getElementById('detailModal').classList.remove('active');
}

function formatNumber(num) {
    if (num === undefined || num === null) return 'N/A';
    return num.toLocaleString();
}

function formatValue(value) {
    if (typeof value === 'number') {
        return formatNumber(value);
    }
    return value;
}

function showError(message) {
    const errorContainer = document.getElementById('errorContainer');
    errorContainer.innerHTML = `<div class="error">${message}</div>`;
}

function clearData() {
    document.getElementById('repoUrl').value = '';
    document.getElementById('mainContent').style.display = 'none';
    document.getElementById('errorContainer').innerHTML = '';
    allData = {};
    currentPlugin = null;
}

document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target.id === 'detailModal') {
        closeModal();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
    }
});