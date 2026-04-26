import { App, PluginSettingTab, Setting } from 'obsidian';
import MetadataWranglerPlugin from './main';

export interface MetadataWranglerSettings {
  /** Vault folder where field definition notes are stored. */
  definitionFolder: string;
  /** If true, the sidebar field search also matches aliases and descriptions. */
  searchAliasesAndDescriptions: boolean;
  /** If true, hover tooltips are shown in the sidebar list. */
  enableSidebarTooltips: boolean;
  /** If true, a CodeMirror hover extension adds tooltips over inline fields in the editor. */
  enableEditorTooltips: boolean;
  /** Whether inline field insertion appends a trailing space after ":: ". */
  insertionTrailingSpace: boolean;
  /** Hold this key while hovering to show field definition tooltips. Default: Alt. */
  tooltipModifierKey: 'Alt' | 'Control' | 'Meta' | 'Shift';
}

export const DEFAULT_SETTINGS: MetadataWranglerSettings = {
  definitionFolder: 'metadata',
  searchAliasesAndDescriptions: true,
  enableSidebarTooltips: true,
  enableEditorTooltips: true,
  insertionTrailingSpace: true,
  tooltipModifierKey: 'Alt',
};

export class MetadataWranglerSettingTab extends PluginSettingTab {
  plugin: MetadataWranglerPlugin;

  constructor(app: App, plugin: MetadataWranglerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Metadata Wrangler Settings' });

    new Setting(containerEl)
      .setName('Definition folder')
      .setDesc('Vault folder where field definition notes are stored (default: metadata).')
      .addText((text) =>
        text
          .setPlaceholder('metadata')
          .setValue(this.plugin.settings.definitionFolder)
          .onChange(async (value) => {
            this.plugin.settings.definitionFolder = value.trim() || 'metadata';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Tooltip modifier key')
      .setDesc('Hold this key while hovering to show field definition tooltips. Default: Alt.')
      .addDropdown(drop =>
        drop
          .addOption('Alt', 'Alt')
          .addOption('Control', 'Ctrl')
          .addOption('Meta', 'Meta (Cmd)')
          .addOption('Shift', 'Shift')
          .setValue(this.plugin.settings.tooltipModifierKey)
          .onChange(async val => {
            this.plugin.settings.tooltipModifierKey = val as any;
            await this.plugin.saveSettings();
            this.plugin.rebuildEditorExtension();
          })
      );

    new Setting(containerEl)
      .setName('Search aliases and descriptions')
      .setDesc('Include field aliases and description text when filtering in the sidebar.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.searchAliasesAndDescriptions)
          .onChange(async (value) => {
            this.plugin.settings.searchAliasesAndDescriptions = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Sidebar hover tooltips')
      .setDesc('Show field description and aliases when hovering over sidebar rows.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSidebarTooltips)
          .onChange(async (value) => {
            this.plugin.settings.enableSidebarTooltips = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Editor hover tooltips')
      .setDesc('Show tooltips over inline fields in the note editor (CodeMirror extension).')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableEditorTooltips)
          .onChange(async (value) => {
            this.plugin.settings.enableEditorTooltips = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Trailing space after insertion')
      .setDesc('Append a space after ":: " when inserting an inline field.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.insertionTrailingSpace)
          .onChange(async (value) => {
            this.plugin.settings.insertionTrailingSpace = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
