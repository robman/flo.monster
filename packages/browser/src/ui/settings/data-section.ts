/**
 * Data settings section
 */

import type { PersistenceLayer } from '../../shell/persistence.js';

export function createDataSection(persistence: PersistenceLayer): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-data';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn';
  exportBtn.textContent = 'Export Data';
  exportBtn.addEventListener('click', async () => {
    try {
      const data = await persistence.exportData();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flo-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      window.alert('Export failed: ' + String(err));
    }
  });

  const importBtn = document.createElement('button');
  importBtn.className = 'btn';
  importBtn.textContent = 'Import Data';
  importBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        await persistence.importData(text);
        window.alert('Data imported successfully. Reload the page to see changes.');
      } catch (err) {
        window.alert('Import failed: ' + String(err));
      }
    });
    input.click();
  });

  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn settings-data__clear';
  clearBtn.textContent = 'Clear All Data';
  clearBtn.addEventListener('click', async () => {
    if (window.confirm('This will delete all saved data. Are you sure?')) {
      try {
        await persistence.clearAll();
        window.alert('All data cleared. Reload the page.');
      } catch (err) {
        window.alert('Clear failed: ' + String(err));
      }
    }
  });

  el.appendChild(exportBtn);
  el.appendChild(importBtn);
  el.appendChild(clearBtn);
  return el;
}
