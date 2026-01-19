import { filterItems } from '../JavaScript/Plugin_Data.js'

// Function to extract unique categories from JSON data
function extractCategories(data) {
    const categories = new Set();
            
    // Assuming data is an array of objects
    if (Array.isArray(data)) {
        data.forEach(item => {
            if (item.category) {
                categories.add(item.category);
            }
        });
    } else if (typeof data === 'object') {
        // If data is an object, check all values
        Object.values(data).forEach(item => {
            if (item && item.category) {
                categories.add(item.category);
            }
        });
    }
            
    return Array.from(categories).sort();
}

// Function to populate filter checkboxes
function populateFilters(data) {
    const categories = extractCategories(data);
    const filterOptions = document.getElementById('filterOptions');
    const filterSection = document.getElementById('filterSection');
            
    if (categories.length === 0) {
        filterSection.style.display = 'none';
        return;
    }
            
    filterSection.style.display = 'block';
    filterOptions.innerHTML = '';
            
    categories.forEach(category => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'filter-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `filter-${category}`;
        checkbox.value = category;
        checkbox.checked = true;
        checkbox.onchange = filterItems;
                
        const label = document.createElement('label');
        label.htmlFor = `filter-${category}`;
        label.textContent = category;
                
        optionDiv.appendChild(checkbox);
        optionDiv.appendChild(label);
        filterOptions.appendChild(optionDiv);
    });
}

// Function to get selected categories
function getSelectedCategories() {
    const checkboxes = document.querySelectorAll('#filterOptions input[type="checkbox"]');
    const selected = [];
            
    checkboxes.forEach(cb => {
        if (cb.checked) {
            selected.push(cb.value);
        }
    });
            
    return selected;
}
        
// Function to clear all filters
function clearFilters() {
    const checkboxes = document.querySelectorAll('#filterOptions input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = true;
    });
    filterItems();
}
