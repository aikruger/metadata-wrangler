import {
	App,
	ItemView,
	Modal,
	Notice,
	Plugin,
	TFile,
	WorkspaceLeaf,
	debounce,
} from 'obsidian';
import { MetadataWranglerSettingTab } from './settings';

// ─── Types ────────────────────────────────────────────────────────────────────

type FieldSource = 'frontmatter' | 'inline';
type FieldType = 'text' | 'number' | 'checkbox' | 'date' | 'datetime' | 'list' | 'unknown';

interface ValueInfo {
	files: Set<string>;
}

interface FieldInfo {
	name: string;
	source: FieldSource;
	files: Set<string>;
	values: Map<string, ValueInfo>;
	fieldType: FieldType;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = 'metadata-wrangler-view';

/** Matches Dataview-style inline fields: `key:: value` */
const INLINE_FIELD_RE = /^([A-Za-z0-9_][A-Za-z0-9_\- ]*)::\s*(.+?)\s*$/;

/** Valid Obsidian/Dataview property types for the type-change dropdown */
const PROPERTY_TYPES: FieldType[] = ['text', 'number', 'checkbox', 'date', 'datetime', 'list'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Safely converts an unknown vault value to a display string. */
function stringify(v: unknown): string {
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	if (v == null) return '';
	return JSON.stringify(v);
}

/** Returns the character index of the first body character (after frontmatter). */
function getFrontmatterEnd(content: string): number {
	if (!content.startsWith('---')) return 0;
	const m = /^---\r?\n[\s\S]*?\n---[ \t]*(?:\r?\n|$)/.exec(content);
	return m ? m[0].length : 0;
}

function detectTypeFromRawValue(v: unknown): FieldType {
	if (typeof v === 'boolean') return 'checkbox';
	if (typeof v === 'number') return 'number';
	if (Array.isArray(v)) return 'list';
	if (typeof v === 'string') return detectTypeFromString(v);
	return 'unknown';
}

function detectTypeFromString(s: string): FieldType {
	if (s === 'true' || s === 'false') return 'checkbox';
	if (DATETIME_RE.test(s)) return 'datetime';
	if (DATE_RE.test(s)) return 'date';
	if (s.trim() !== '' && !isNaN(Number(s))) return 'number';
	return 'text';
}

/**
 * Extracts inline fields from a single line, handling:
 *  - Normal lines:          `key:: value`
 *  - Callout/blockquote:   `> key:: value`
 *  - Table cells:           `| key:: value |`
 */
function extractInlineFieldsFromLine(line: string): Array<{ name: string; val: string }> {
	const results: Array<{ name: string; val: string }> = [];

	// Strip leading blockquote / callout markers (handles nested: "> > ")
	const stripped = line.replace(/^(?:>\s*)+/, '');

	// For table rows, examine each pipe-delimited cell separately
	if (stripped.includes('|')) {
		for (const cell of stripped.split('|')) {
			const m = INLINE_FIELD_RE.exec(cell.trim());
			if (m != null && m[1] != null && m[2] != null) {
				results.push({ name: m[1].trim(), val: m[2].trim() });
			}
		}
	} else {
		const m = INLINE_FIELD_RE.exec(stripped);
		if (m != null && m[1] != null && m[2] != null) {
			results.push({ name: m[1].trim(), val: m[2].trim() });
		}
	}

	return results;
}

// ─── Indexing ─────────────────────────────────────────────────────────────────

async function buildIndex(app: App): Promise<Map<string, FieldInfo>> {
	const index = new Map<string, FieldInfo>();

	const upsert = (key: string, name: string, source: FieldSource): FieldInfo => {
		if (!index.has(key)) {
			index.set(key, {
				name,
				source,
				files: new Set(),
				values: new Map(),
				fieldType: 'unknown',
			});
		}
		return index.get(key)!;
	};

	const addVal = (field: FieldInfo, value: string, path: string): void => {
		if (!field.values.has(value)) {
			field.values.set(value, { files: new Set() });
		}
		field.values.get(value)!.files.add(path);
	};

	const mergeType = (field: FieldInfo, detected: FieldType): void => {
		if (field.fieldType === 'unknown') {
			field.fieldType = detected;
		} else if (field.fieldType !== detected) {
			field.fieldType = 'text';
		}
	};

	for (const file of app.vault.getMarkdownFiles()) {
		// ── Frontmatter via metadata cache ──
		const cache = app.metadataCache.getFileCache(file);
		if (cache?.frontmatter) {
			for (const [key, rawValue] of Object.entries(cache.frontmatter)) {
				if (key === 'position') continue;
				const field = upsert(`fm::${key}`, key, 'frontmatter');
				field.files.add(file.path);
				const vals: unknown[] = Array.isArray(rawValue) ? rawValue : [rawValue];
				for (const v of vals) {
					addVal(field, stringify(v), file.path);
				}
				const detectedType = Array.isArray(rawValue)
					? 'list'
					: detectTypeFromRawValue(rawValue);
				mergeType(field, detectedType);
			}
		}

		// ── Inline fields via body scan ──
		const content = await app.vault.cachedRead(file);
		const fmEnd = getFrontmatterEnd(content);
		const body = content.slice(fmEnd);
		for (const line of body.split('\n')) {
			for (const { name, val } of extractInlineFieldsFromLine(line)) {
				const field = upsert(`il::${name}`, name, 'inline');
				field.files.add(file.path);
				addVal(field, val, file.path);
				mergeType(field, detectTypeFromString(val));
			}
		}
	}

	return index;
}

// ─── Vault Mutations ──────────────────────────────────────────────────────────

async function renameFrontmatterKey(
	app: App,
	files: string[],
	oldKey: string,
	newKey: string,
): Promise<void> {
	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		try {
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				if (oldKey in fm) {
					fm[newKey] = fm[oldKey];
					delete fm[oldKey];
				}
			});
		} catch (e) {
			console.warn(`metadata-wrangler: rename frontmatter key failed for ${path}`, e);
		}
	}
}

async function renameInlineKey(
	app: App,
	files: string[],
	oldKey: string,
	newKey: string,
): Promise<void> {
	const re = new RegExp(`^(${escapeRegex(oldKey)})(::\\s*)`, 'gm');
	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		try {
			const content = await app.vault.read(file);
			const fmEnd = getFrontmatterEnd(content);
			const newBody = content.slice(fmEnd).replace(re, `${newKey}$2`);
			if (newBody !== content.slice(fmEnd)) {
				await app.vault.modify(file, content.slice(0, fmEnd) + newBody);
			}
		} catch (e) {
			console.warn(`metadata-wrangler: rename inline key failed for ${path}`, e);
		}
	}
}

async function updateFrontmatterValue(
	app: App,
	files: string[],
	key: string,
	oldVal: string,
	newVal: string,
): Promise<void> {
	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		try {
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				if (!(key in fm)) return;
				if (Array.isArray(fm[key])) {
					fm[key] = (fm[key] as unknown[]).map((v) =>
						stringify(v) === oldVal ? newVal : v,
					);
				} else if (stringify(fm[key]) === oldVal) {
					fm[key] = newVal;
				}
			});
		} catch (e) {
			console.warn(`metadata-wrangler: update frontmatter value failed for ${path}`, e);
		}
	}
}

async function deleteFrontmatterValue(
	app: App,
	files: string[],
	key: string,
	val: string,
): Promise<void> {
	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		try {
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				if (!(key in fm)) return;
				if (Array.isArray(fm[key])) {
					const filtered = (fm[key] as unknown[]).filter(
						(v) => stringify(v) !== val,
					);
					if (filtered.length === 0) {
						delete fm[key];
					} else {
						fm[key] = filtered;
					}
				} else if (stringify(fm[key]) === val) {
					delete fm[key];
				}
			});
		} catch (e) {
			console.warn(`metadata-wrangler: delete frontmatter value failed for ${path}`, e);
		}
	}
}

async function updateInlineValue(
	app: App,
	files: string[],
	key: string,
	oldVal: string,
	newVal: string,
): Promise<void> {
	const re = new RegExp(
		`^(${escapeRegex(key)}::\\s*)${escapeRegex(oldVal)}(\\s*)$`,
		'gm',
	);
	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		try {
			const content = await app.vault.read(file);
			const fmEnd = getFrontmatterEnd(content);
			const newBody = content.slice(fmEnd).replace(re, `$1${newVal}$2`);
			if (newBody !== content.slice(fmEnd)) {
				await app.vault.modify(file, content.slice(0, fmEnd) + newBody);
			}
		} catch (e) {
			console.warn(`metadata-wrangler: update inline value failed for ${path}`, e);
		}
	}
}

async function deleteInlineValue(
	app: App,
	files: string[],
	key: string,
	val: string,
): Promise<void> {
	const re = new RegExp(
		`^${escapeRegex(key)}::\\s*${escapeRegex(val)}\\s*$\\n?`,
		'gm',
	);
	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		try {
			const content = await app.vault.read(file);
			const fmEnd = getFrontmatterEnd(content);
			const newBody = content.slice(fmEnd).replace(re, '');
			if (newBody !== content.slice(fmEnd)) {
				await app.vault.modify(file, content.slice(0, fmEnd) + newBody);
			}
		} catch (e) {
			console.warn(`metadata-wrangler: delete inline value failed for ${path}`, e);
		}
	}
}

// ─── Conversion Helpers ───────────────────────────────────────────────────────

/**
 * Convert or copy a frontmatter property to an inline field.
 * Inserts `key:: value` lines at the top of the body (right after frontmatter).
 * If `convert` is true, removes the key from frontmatter.
 */
async function frontmatterToInline(
	app: App,
	files: string[],
	key: string,
	convert: boolean,
): Promise<void> {
	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		try {
			// Collect frontmatter value before potential deletion
			const cache = app.metadataCache.getFileCache(file);
			const rawValue: unknown = cache?.frontmatter?.[key] as unknown;
			if (rawValue === undefined) continue;
			const vals: unknown[] = Array.isArray(rawValue) ? rawValue : [rawValue];
			const inlineLines = vals.map((v) => `${key}:: ${stringify(v)}`).join('\n');

			if (convert) {
				await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					delete fm[key];
				});
			}

			// Insert inline lines at top of body
			const content = await app.vault.read(file);
			const fmEnd = getFrontmatterEnd(content);
			const newContent = content.slice(0, fmEnd) + inlineLines + '\n' + content.slice(fmEnd);
			await app.vault.modify(file, newContent);
		} catch (e) {
			console.warn(`metadata-wrangler: frontmatter→inline failed for ${path}`, e);
		}
	}
}

/**
 * Convert or copy an inline field to a frontmatter property.
 * Collects all `key:: value` occurrences in the body and adds them to frontmatter.
 * If `convert` is true, removes the inline lines from the body.
 */
async function inlineToFrontmatter(
	app: App,
	files: string[],
	key: string,
	convert: boolean,
): Promise<void> {
	const lineRe = new RegExp(`^${escapeRegex(key)}::\\s*(.+?)\\s*$`, 'gm');
	const removeRe = new RegExp(`^${escapeRegex(key)}::\\s*.+?\\s*$\\n?`, 'gm');
	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		try {
			const content = await app.vault.read(file);
			const fmEnd = getFrontmatterEnd(content);
			const body = content.slice(fmEnd);

			const matches = [...body.matchAll(lineRe)];
			if (matches.length === 0) continue;
			const collectedValues = matches.map((m) => m[1]);

			// Add to frontmatter
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				const existing = fm[key];
				if (existing === undefined) {
					fm[key] = collectedValues.length === 1 ? collectedValues[0] : collectedValues;
				} else {
					const existingArr: unknown[] = Array.isArray(existing) ? existing : [existing];
					const merged = [
						...existingArr,
						...collectedValues.filter(
							(v) => !existingArr.some((e) => stringify(e) === v),
						),
					];
					fm[key] = merged.length === 1 ? merged[0] : merged;
				}
			});

			if (convert) {
				const updatedContent = await app.vault.read(file);
				const updatedFmEnd = getFrontmatterEnd(updatedContent);
				const updatedBody = updatedContent.slice(updatedFmEnd).replace(removeRe, '');
				await app.vault.modify(file, updatedContent.slice(0, updatedFmEnd) + updatedBody);
			}
		} catch (e) {
			console.warn(`metadata-wrangler: inline→frontmatter failed for ${path}`, e);
		}
	}
}

// ─── View ─────────────────────────────────────────────────────────────────────

class MetadataWranglerView extends ItemView {
	private plugin: MetadataWranglerPlugin;
	private index: Map<string, FieldInfo> = new Map();
	private loading = false;
	private searchQuery = '';
	private showFrontmatter = true;
	private showInline = true;
	private listContainer: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MetadataWranglerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE; }
	// eslint-disable-next-line obsidianmd/ui/sentence-case
	getDisplayText(): string { return 'metadata wrangler'; }
	getIcon(): string { return 'list-plus'; }

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	async onClose(): Promise<void> { /* nothing to clean up */ }

	async refresh(): Promise<void> {
		this.loading = true;
		this.render();
		try {
			this.index = await buildIndex(this.app);
		} catch (e) {
			console.error('metadata-wrangler: indexing failed', e);
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice('metadata wrangler: indexing failed');
		}
		this.loading = false;
		this.render();
	}

	private render(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('property-wrangler-view');

		// Header
		const header = containerEl.createDiv({ cls: 'pw-header' });
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		header.createEl('span', { cls: 'pw-title', text: 'metadata wrangler' });
		const refreshBtn = header.createEl('button', {
			cls: 'pw-refresh-btn',
			text: '↺',
			title: 'Refresh index',
		});
		refreshBtn.addEventListener('click', () => { void this.refresh(); });

		if (this.loading) {
			containerEl.createDiv({ cls: 'pw-loading', text: '⏳ Indexing vault…' });
			return;
		}

		// Search
		const searchRow = containerEl.createDiv({ cls: 'pw-search-row' });
		const searchInput = searchRow.createEl('input', {
			cls: 'pw-search',
			type: 'text',
			placeholder: 'Search fields…',
		});
		searchInput.value = this.searchQuery;

		const debouncedSearch = debounce((val: string) => {
			this.searchQuery = val;
			if (this.listContainer) {
				this.renderList(this.listContainer, this.getFilteredFields());
			}
		}, 200, true);

		searchInput.addEventListener('input', () => debouncedSearch(searchInput.value));

		// Filters
		const filters = containerEl.createDiv({ cls: 'property-filters' });
		this.addFilterCheckbox(filters, 'Properties (p)', this.showFrontmatter, (v) => {
			this.showFrontmatter = v;
			if (this.listContainer) this.renderList(this.listContainer, this.getFilteredFields());
		});
		this.addFilterCheckbox(filters, 'Inline (i)', this.showInline, (v) => {
			this.showInline = v;
			if (this.listContainer) this.renderList(this.listContainer, this.getFilteredFields());
		});

		// Stats
		containerEl.createDiv({
			cls: 'pw-stats',
			text: `${this.index.size} field${this.index.size !== 1 ? 's' : ''} indexed`,
		});

		// Field list
		this.listContainer = containerEl.createDiv({ cls: 'pw-field-list' });
		this.renderList(this.listContainer, this.getFilteredFields());
	}

	private addFilterCheckbox(
		parent: HTMLElement,
		label: string,
		checked: boolean,
		onChange: (v: boolean) => void,
	): void {
		const wrapper = parent.createEl('label', { cls: 'field-filter' });
		const cb = wrapper.createEl('input', { type: 'checkbox' });
		cb.checked = checked;
		wrapper.createEl('span', { text: label });
		cb.addEventListener('change', () => onChange(cb.checked));
	}

	private getFilteredFields(): FieldInfo[] {
		const fields: FieldInfo[] = [];
		for (const field of this.index.values()) {
			if (field.source === 'frontmatter' && !this.showFrontmatter) continue;
			if (field.source === 'inline' && !this.showInline) continue;
			if (
				this.searchQuery &&
				!field.name.toLowerCase().includes(this.searchQuery.toLowerCase())
			) continue;
			fields.push(field);
		}
		return fields.sort((a, b) => a.name.localeCompare(b.name));
	}

	private renderList(container: HTMLElement, fields: FieldInfo[]): void {
		container.empty();
		if (fields.length === 0) {
			container.createDiv({ cls: 'pw-empty', text: 'No fields found.' });
			return;
		}
		for (const field of fields) {
			const row = container.createDiv({ cls: 'pw-field-row' });
			// Source badge (p) or (i) next to each result entry
			row.createEl('span', {
				cls: `field-source-badge ${field.source === 'frontmatter' ? 'badge-p' : 'badge-i'}`,
				text: field.source === 'frontmatter' ? '(p)' : '(i)',
				title: field.source === 'frontmatter' ? 'Frontmatter property' : 'Inline field',
			});
			// Field type badge next to source badge
			row.createEl('span', {
				cls: `pw-type-badge pw-type-${field.fieldType}`,
				text: field.fieldType,
				title: `Field type: ${field.fieldType}`,
			});
			row.createEl('span', { cls: 'pw-field-name', text: field.name });
			row.createEl('span', {
				cls: 'pw-field-stats',
				text: `${field.files.size} file${field.files.size !== 1 ? 's' : ''}, ${field.values.size} value${field.values.size !== 1 ? 's' : ''}`,
			});
			row.addEventListener('click', () => {
				new FieldEditModal(this.app, field, () => { void this.refresh(); }).open();
			});
		}
	}
}

// ─── Field Edit Modal ─────────────────────────────────────────────────────────

class FieldEditModal extends Modal {
	private field: FieldInfo;
	private onRefresh: () => void;

	constructor(app: App, field: FieldInfo, onRefresh: () => void) {
		super(app);
		this.field = field;
		this.onRefresh = onRefresh;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('pw-modal');

		contentEl.createEl('h2', {
			cls: 'pw-modal-title',
			text: `Field: ${this.field.name}`,
		});

		contentEl.createEl('p', {
			cls: 'pw-source-info',
			text: `Source: ${this.field.source === 'frontmatter' ? 'Frontmatter [p]' : 'Inline field [i]'}  ·  Type: ${this.field.fieldType}  ·  ${this.field.files.size} file${this.field.files.size !== 1 ? 's' : ''}`,
		});

		// Rename section
		const renameSection = contentEl.createDiv({ cls: 'pw-rename-section' });
		renameSection.createEl('label', { cls: 'pw-label', text: 'Rename field:' });
		const renameRow = renameSection.createDiv({ cls: 'pw-rename-row' });
		const nameInput = renameRow.createEl('input', {
			cls: 'pw-name-input',
			type: 'text',
		});
		nameInput.value = this.field.name;
		const renameBtn = renameRow.createEl('button', {
			cls: 'pw-btn pw-btn-primary',
			text: 'Rename',
		});

		// Folder scope for rename
		let scopeMode: 'all' | 'folder' = 'all';
		let scopeFolder = '';

		const scopeSection = renameSection.createDiv({ cls: 'pw-scope-section' });
		scopeSection.createEl('label', { cls: 'pw-label', text: 'Apply rename to:' });
		const scopeRow = scopeSection.createDiv({ cls: 'pw-scope-row' });

		const folderInput = scopeSection.createEl('input', {
			cls: 'pw-folder-input',
			type: 'text',
			placeholder: 'Folder path, e.g. notes/work',
		});
		folderInput.addClass('pw-hidden');

		(['all', 'folder'] as const).forEach((val) => {
			const lbl = scopeRow.createEl('label', { cls: 'pw-radio-label' });
			const radio = lbl.createEl('input', { type: 'radio' });
			radio.name = 'pw-rename-scope';
			radio.value = val;
			radio.checked = val === 'all';
			lbl.createEl('span', { text: val === 'all' ? 'All files' : 'Specific folder:' });
			radio.addEventListener('change', () => {
				if (radio.checked) {
					scopeMode = val;
					folderInput.toggleClass('pw-hidden', val !== 'folder');
				}
			});
		});

		folderInput.addEventListener('input', () => { scopeFolder = folderInput.value.trim(); });

		renameBtn.addEventListener('click', () => {
			void this.handleRename(nameInput.value, scopeMode, scopeFolder);
		});

		// Values section
		contentEl.createEl('h3', { cls: 'pw-section-title', text: 'Values' });
		const valuesContainer = contentEl.createDiv({ cls: 'pw-values-container' });
		this.renderValues(valuesContainer);

		// Type change section
		contentEl.createEl('h3', { cls: 'pw-section-title', text: 'Property type' });
		this.renderTypeSection(contentEl);

		// Convert / Copy section
		contentEl.createEl('h3', { cls: 'pw-section-title', text: 'Convert / copy' });
		this.renderConvertSection(contentEl);
	}

	private renderTypeSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'pw-type-section' });
		const typeRow = section.createDiv({ cls: 'pw-type-row' });
		const typeSelect = typeRow.createEl('select', { cls: 'pw-type-select' });
		for (const t of PROPERTY_TYPES) {
			const option = typeSelect.createEl('option', { value: t, text: t });
			if (t === this.field.fieldType) option.selected = true;
		}
		const applyBtn = typeRow.createEl('button', {
			cls: 'pw-btn pw-btn-primary',
			text: 'Apply type',
		});
		applyBtn.addEventListener('click', () => {
			void this.handleChangeType(typeSelect.value as FieldType);
		});
	}

	private async handleChangeType(newType: FieldType): Promise<void> {
		if (newType === this.field.fieldType) return;
		if (this.field.source === 'frontmatter') {
			// 'unknown' is not selectable but required to satisfy Record<FieldType, string>
			const typeMap: Record<FieldType, string> = {
				text: 'text', number: 'number', checkbox: 'checkbox',
				date: 'date', datetime: 'datetime', list: 'multitext', unknown: 'text',
			};
			type MetadataTypeManager = { setType: (name: string, type: string) => void };
			const mtm = (this.app as App & { metadataTypeManager?: MetadataTypeManager }).metadataTypeManager;
			if (mtm) mtm.setType(this.field.name, typeMap[newType]);
		}
		this.field.fieldType = newType;
		new Notice(`Changed type of "${this.field.name}" to "${newType}"`);
		this.close();
		this.onRefresh();
	}

	private renderConvertSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: 'pw-convert-section' });

		let convertMode: 'convert' | 'copy' = 'convert';

		// Mode radio buttons
		const modeRow = section.createDiv({ cls: 'pw-convert-mode-row' });
		modeRow.createEl('span', { cls: 'pw-label', text: 'Action:' });

		const makeRadio = (value: 'convert' | 'copy', label: string): void => {
			const radioLabel = modeRow.createEl('label', { cls: 'pw-radio-label' });
			const radio = radioLabel.createEl('input', { type: 'radio' });
			radio.name = 'pw-convert-mode';
			radio.value = value;
			radio.checked = value === 'convert';
			radioLabel.createEl('span', { text: label });
			radio.addEventListener('change', () => {
				if (radio.checked) convertMode = value;
			});
		};

		makeRadio('convert', 'Convert (move)');
		makeRadio('copy', 'Copy (keep original)');

		// Action button
		const actionRow = section.createDiv({ cls: 'pw-convert-action-row' });
		if (this.field.source === 'frontmatter') {
			const toInlineBtn = actionRow.createEl('button', {
				cls: 'pw-btn pw-btn-secondary',
				text: 'To inline field ↓',
				title: 'Insert as inline field(s) at the top of the file body',
			});
			toInlineBtn.addEventListener('click', () => {
				void this.handleConvert('frontmatter-to-inline', () => convertMode);
			});
		} else {
			const toFrontmatterBtn = actionRow.createEl('button', {
				cls: 'pw-btn pw-btn-secondary',
				text: 'To frontmatter property ↑',
				title: 'Add as a frontmatter property',
			});
			toFrontmatterBtn.addEventListener('click', () => {
				void this.handleConvert('inline-to-frontmatter', () => convertMode);
			});
		}
	}

	private async handleConvert(
		direction: 'frontmatter-to-inline' | 'inline-to-frontmatter',
		getMode: () => 'convert' | 'copy',
	): Promise<void> {
		const mode = getMode();
		const isConvert = mode === 'convert';
		const files = [...this.field.files];
		if (direction === 'frontmatter-to-inline') {
			await frontmatterToInline(this.app, files, this.field.name, isConvert);
			new Notice(`${isConvert ? 'Converted' : 'Copied'} "${this.field.name}" to inline field`);
		} else {
			await inlineToFrontmatter(this.app, files, this.field.name, isConvert);
			new Notice(`${isConvert ? 'Converted' : 'Copied'} "${this.field.name}" to frontmatter property`);
		}
		this.close();
		this.onRefresh();
	}

	private async handleRename(newName: string, scopeMode: 'all' | 'folder' = 'all', scopeFolder = ''): Promise<void> {
		const trimmed = newName.trim();
		if (!trimmed || trimmed === this.field.name) return;
		let files = [...this.field.files];
		if (scopeMode === 'folder' && scopeFolder) {
			// Obsidian vault paths always use forward slashes
			const normalised = scopeFolder.replace(/\\/g, '/');
			const prefix = normalised.endsWith('/') ? normalised : `${normalised}/`;
			files = files.filter((p) => p.startsWith(prefix));
		}
		if (this.field.source === 'frontmatter') {
			await renameFrontmatterKey(this.app, files, this.field.name, trimmed);
		} else {
			await renameInlineKey(this.app, files, this.field.name, trimmed);
		}
		new Notice(`Renamed "${this.field.name}" → "${trimmed}"`);
		this.close();
		this.onRefresh();
	}

	private renderValues(container: HTMLElement): void {
		container.empty();
		if (this.field.values.size === 0) {
			container.createDiv({ cls: 'pw-empty', text: 'No values.' });
			return;
		}
		for (const [value, info] of this.field.values) {
			this.renderValueRow(container, value, info);
		}
	}

	private renderValueRow(
		container: HTMLElement,
		value: string,
		info: ValueInfo,
	): void {
		const row = container.createDiv({ cls: 'pw-value-row' });

		// Header row: value text + file count toggle
		const header = row.createDiv({ cls: 'pw-value-header' });
		header.createEl('span', {
			cls: 'pw-value-text',
			text: value === '' ? '(empty)' : value,
		});
		const toggle = header.createEl('button', {
			cls: 'pw-btn pw-btn-ghost',
			text: `${info.files.size} file${info.files.size !== 1 ? 's' : ''}`,
			title: 'Toggle file list',
		});

		// File list (hidden by default)
		const fileList = row.createDiv({ cls: 'pw-file-list pw-hidden' });
		toggle.addEventListener('click', () => {
			fileList.toggleClass('pw-hidden', !fileList.hasClass('pw-hidden'));
		});
		for (const path of info.files) {
			const entry = fileList.createDiv({ cls: 'pw-file-entry' });
			const link = entry.createEl('a', { cls: 'pw-file-link', text: path });
			link.addEventListener('click', () => {
				const f = this.app.vault.getAbstractFileByPath(path);
				if (f instanceof TFile) {
					void this.app.workspace.getLeaf().openFile(f);
					this.close();
				}
			});
		}

		// Action buttons
		const actions = row.createDiv({ cls: 'pw-value-actions' });
		const editBtn = actions.createEl('button', {
			cls: 'pw-btn pw-btn-secondary',
			text: 'Edit',
		});
		const deleteBtn = actions.createEl('button', {
			cls: 'pw-btn pw-btn-danger',
			text: 'Delete',
		});

		editBtn.addEventListener('click', () => {
			this.showEditInput(row, editBtn, value, info);
		});
		deleteBtn.addEventListener('click', () => {
			void this.handleDeleteValue(value, info);
		});
	}

	private showEditInput(
		row: HTMLElement,
		editBtn: HTMLButtonElement,
		value: string,
		info: ValueInfo,
	): void {
		editBtn.disabled = true;
		const editRow = row.createDiv({ cls: 'pw-edit-row' });
		const input = editRow.createEl('input', { cls: 'pw-edit-input', type: 'text' });
		input.value = value;
		const saveBtn = editRow.createEl('button', {
			cls: 'pw-btn pw-btn-primary',
			text: 'Save',
		});
		const cancelBtn = editRow.createEl('button', {
			cls: 'pw-btn',
			text: 'Cancel',
		});

		saveBtn.addEventListener('click', () => {
			void this.handleUpdateValue(input.value, value, info, editBtn, editRow);
		});
		cancelBtn.addEventListener('click', () => {
			editRow.remove();
			editBtn.disabled = false;
		});
	}

	private async handleUpdateValue(
		newVal: string,
		oldVal: string,
		info: ValueInfo,
		editBtn: HTMLButtonElement,
		editRow: HTMLElement,
	): Promise<void> {
		if (newVal === oldVal) {
			editRow.remove();
			editBtn.disabled = false;
			return;
		}
		const files = [...info.files];
		if (this.field.source === 'frontmatter') {
			await updateFrontmatterValue(this.app, files, this.field.name, oldVal, newVal);
		} else {
			await updateInlineValue(this.app, files, this.field.name, oldVal, newVal);
		}
		new Notice(`Updated value "${oldVal}" → "${newVal}"`);
		this.close();
		this.onRefresh();
	}

	private async handleDeleteValue(value: string, info: ValueInfo): Promise<void> {
		const files = [...info.files];
		if (this.field.source === 'frontmatter') {
			await deleteFrontmatterValue(this.app, files, this.field.name, value);
		} else {
			await deleteInlineValue(this.app, files, this.field.name, value);
		}
		new Notice(`Deleted value "${value}"`);
		this.close();
		this.onRefresh();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class MetadataWranglerPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(
			VIEW_TYPE,
			(leaf) => new MetadataWranglerView(leaf, this),
		);

		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.addRibbonIcon('list-plus', 'metadata wrangler', () => {
			void this.openView();
		});

		this.addCommand({
			id: 'open-view',
			name: 'Open view',
			callback: () => { void this.openView(); },
		});

		this.addSettingTab(new MetadataWranglerSettingTab(this.app, this));
	}

	onunload(): void { /* nothing to clean up */ }

	private async openView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			void this.app.workspace.revealLeaf(existing[0]!);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
			void this.app.workspace.revealLeaf(leaf);
		}
	}
}
