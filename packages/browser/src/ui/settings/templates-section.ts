/**
 * Templates section for the settings panel
 */

import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import type { TemplateManager } from '../../shell/template-manager.js';
import { TemplateGallery } from '../template-gallery.js';

export function createTemplatesSection(
  settings: AppSettings,
  persistence: PersistenceLayer,
  templateManager: TemplateManager,
  onRerender: () => void,
): HTMLElement {
  // Note: settings param is reserved for future use (e.g., template preferences)
  void settings;

  const el = document.createElement('div');
  el.className = 'settings-templates';

  const description = document.createElement('p');
  description.className = 'settings-templates__description';
  description.textContent = 'Install and manage agent templates. Templates are reusable agent configurations with custom UI, tools, and settings.';
  el.appendChild(description);

  const galleryContainer = document.createElement('div');
  const gallery = new TemplateGallery(galleryContainer, templateManager, {
    onInstall: async (url) => {
      try {
        await templateManager.installFromUrl(url);

        // Save to persistence
        const current = await persistence.getSettings();
        current.installedTemplates = templateManager.exportEntries();
        await persistence.saveSettings(current);

        gallery.render();
      } catch (err) {
        window.alert(`Failed to install template: ${err}`);
      }
    },
    onRemove: async (name) => {
      // Save to persistence after removal
      const current = await persistence.getSettings();
      current.installedTemplates = templateManager.exportEntries();
      await persistence.saveSettings(current);

      // Note: name param could be used for additional cleanup
      void name;
      onRerender();
    },
  });
  el.appendChild(galleryContainer);

  return el;
}
