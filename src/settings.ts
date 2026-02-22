import {App, PluginSettingTab} from "obsidian";
import MetadataWranglerPlugin from "./main";

export class MetadataWranglerSettingTab extends PluginSettingTab {
	plugin: MetadataWranglerPlugin;

	constructor(app: App, plugin: MetadataWranglerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.createEl('p', {text: 'No settings available yet.'});
	}
}
