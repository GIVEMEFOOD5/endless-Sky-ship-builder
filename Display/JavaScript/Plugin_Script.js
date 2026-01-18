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
        // Fetch the data directory structure
        const baseUrl = `https://raw.githubusercontent.com/${repoUrl}/main/data`;
                
        // Try to fetch plugins.json to get list of plugins
        const pluginsResponse = await fetch(`https://raw.githubusercontent.com/${repoUrl}/main/plugins.json`);
        
        if (!pluginsResponse.ok) {
            throw new Error('Could not find plugins.json in repository');
        }

        const pluginsConfig = await pluginsResponse.json();
        allData = {};

        // Load data for each plugin
        for (const plugin of pluginsConfig.plugins) {
            try {
                const shipsResponse = await fetch(`${baseUrl}/${plugin.name}/ships.json`);
                const outfitsResponse = await fetch(`${baseUrl}/${plugin.name}/outfits.json`);
                const variantsResponse = await fetch(`${baseUrl}/${plugin.name}/variants.json`);

                if (shipsResponse.ok && outfitsResponse.ok && variantsResponse.ok) {
                    allData[plugin.name] = {
                        repository: plugin.repository
                    };

                    if (shipsResponse.ok) {
                        allData[plugin.name].ships = await shipsResponse.json();
                    }

                    if (outfitsResponse.ok) {
                        allData[plugin.name].outfits = await outfitsResponse.json();
                    }

                    if (variantsResponse.ok) {
                        allData[plugin.name].variants = await variantsResponse.json();
                    }
                }
            } catch (err) {
                console.warn(`Could not load data for plugin: ${plugin.name}`, err);
            }
        }

        if (Object.keys(allData).length === 0) {
            throw new Error('No plugin data found in repository');
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

    // Select first plugin by default
    if (selector.firstChild) {
        selector.firstChild.classList.add('active');
    }
}

function selectPlugin(pluginName) {
    currentPlugin = pluginName;
    
    // Update button states
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
    
    statsContainer.innerHTML = `
        <div class="stat-card">
            <div class="stat-value">${data.ships.length + data.varients.length}</div>
            <div class="stat-label">Ships</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${data.outfits.length}</div>
            <div class="stat-label">Outfits</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${data.ships.length + data.varients.length + data.outfits.length}</div>
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
    const items = currentTab === 'ships' ? data.ships + data.varients : data.outfits;

    filteredData = items;
    filterItems(); // Apply any active search
}

function filterItems() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const container = document.getElementById('cardsContainer');

    const filtered = filteredData.filter(item => 
        item.name.toLowerCase().includes(searchTerm)
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
    title.textContent = item.name;

    const details = document.createElement('div');
    details.className = 'card-details';

    if (currentTab === 'ships') {
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

    modalTitle.textContent = item.name;

    let html = '';

    if (currentTab === 'ships') {
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

// Close modal when clicking outside
document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target.id === 'detailModal') {
        closeModal();
    }
});

// Close modal with Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
    }
});