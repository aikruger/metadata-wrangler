import {
	App,
	Editor,
	FuzzySuggestModal,
	FuzzyMatch,
	ItemView,
	Modal,
	Notice,
	Plugin,
	TFile,
	WorkspaceLeaf,
	debounce,
} from 'obsidian';
import { MetadataWranglerSettingTab, MetadataWranglerSettings, DEFAULT_SETTINGS } from './settings';
import { hoverTooltip } from '@codemirror/view';

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

/** User-authored definition attached to a field from the registry folder. */
interface FieldDefinition {
  /** Canonical field name — must match the indexed FieldInfo.name exactly. */
  name: string;
  /** Human-readable description. Shown in hover tooltips and Dataview. */
  description: string;
  /** Alternative names that also resolve to this field (comma-separated in YAML). */
  aliases: string[];
  /** Top-level classification group, e.g. "Project", "Person", "Status". */
  group: string;
  /** Optional sub-classification, e.g. "Administrative", "Creative". */
  subgroup: string;
  /** FieldSource scope: "frontmatter", "inline", or "both". */
  sourceScope: 'frontmatter' | 'inline' | 'both';
  /** Vault path to the definition note, e.g. "metadata/status.md". */
  filePath: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = 'metadata-wrangler-view';

/** Matches Dataview-style inline fields: `key:: value` */
const INLINE_FIELD_RE = /^([A-Za-z0-9_][A-Za-z0-9_\- ]*)::\s*(.+?)\s*$/;

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

// ─── Indexing ─────────────────────────────────────────────────────────────────

async function buildIndex(app: App, plugin: MetadataWranglerPlugin): Promise<Map<string, FieldInfo>> {
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
		// Skip definition notes to avoid polluting occurrence statistics.
		if (file.path.startsWith(plugin.settings.definitionFolder + '/')) continue;

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
			const m = INLINE_FIELD_RE.exec(line);
			if (m != null && m[1] != null && m[2] != null) {
				const name = m[1].trim();
				const val = m[2].trim();
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

async function deleteEntireFrontmatterKey(app: App, filePath: string, key: string) {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return;
  await app.fileManager.processFrontMatter(file, fm => {
    delete fm[key];
  });
}

async function deleteAllInlineOccurrences(app: App, filePaths: string[], key: string) {
  const pattern = new RegExp(`^${escapeRegex(key)}::[ \\t]*.*$\\n?`, 'gm');
  for (const path of filePaths) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) continue;
    const content = await app.vault.read(file);
    const fmEnd = getFrontmatterEnd(content);
    const body = content.slice(fmEnd).replace(pattern, '');
    if (body !== content.slice(fmEnd)) {
      await app.vault.modify(file, content.slice(0, fmEnd) + body);
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

// ─── Definition Store ──────────────────────────────────────────────────────────

class DefinitionStore {
  private app: App;
  private folderPath: string;
  /** In-memory cache, keyed by canonical lowercase field name. */
  private cache: Map<string, FieldDefinition> = new Map();

  constructor(app: App, folderPath: string) {
    this.app = app;
    this.folderPath = folderPath;
  }

  updateFolder(folderPath: string): void {
    this.folderPath = folderPath;
    this.cache.clear();
  }

  // ── Persistence ──

  /** Ensure the definition folder exists. */
  async ensureFolder(): Promise<void> {
    const exists = this.app.vault.getAbstractFileByPath(this.folderPath);
    if (!exists) {
      await this.app.vault.createFolder(this.folderPath);
    }
  }

  /** Load all .md files in the definition folder into the cache. */
  async loadAll(): Promise<void> {
    this.cache.clear();
    await this.ensureFolder();
    const folder = this.app.vault.getAbstractFileByPath(this.folderPath);
    if (!folder) return;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(this.folderPath + '/')) continue;
      const def = await this.readDefinitionFile(file);
      if (def) {
        this.cache.set(def.name.toLowerCase(), def);
      }
    }
  }

  private async readDefinitionFile(file: TFile): Promise<FieldDefinition | null> {
    try {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm || typeof fm['name'] !== 'string') return null;
      return {
        name: fm['name'] as string,
        description: (fm['description'] as string) ?? '',
        aliases: Array.isArray(fm['aliases'])
          ? (fm['aliases'] as string[]).map(String)
          : typeof fm['aliases'] === 'string'
          ? [fm['aliases'] as string]
          : [],
        group: (fm['group'] as string) ?? '',
        subgroup: (fm['subgroup'] as string) ?? '',
        sourceScope: (['frontmatter', 'inline', 'both'].includes(fm['sourceScope'] as string)
          ? fm['sourceScope']
          : 'both') as FieldDefinition['sourceScope'],
        filePath: file.path,
      };
    } catch {
      return null;
    }
  }

  // ── Lookups ──

  /** Resolve by exact canonical name (case-insensitive). */
  getByName(name: string): FieldDefinition | undefined {
    return this.cache.get(name.toLowerCase());
  }

  /** Resolve by alias (case-insensitive). Returns first match. */
  getByAlias(alias: string): FieldDefinition | undefined {
    const lower = alias.toLowerCase();
    for (const def of this.cache.values()) {
      if (def.aliases.some((a) => a.toLowerCase() === lower)) return def;
    }
    return undefined;
  }

  /** Resolve by canonical name first, then alias. */
  resolve(nameOrAlias: string): FieldDefinition | undefined {
    return this.getByName(nameOrAlias) ?? this.getByAlias(nameOrAlias);
  }

  /** Return all definitions as an array. */
  getAll(): FieldDefinition[] {
    return [...this.cache.values()];
  }

  // ── Writes ──

  /** Save (create or overwrite) a definition. Updates cache. */
  async save(def: FieldDefinition): Promise<void> {
    await this.ensureFolder();
    const slug = this.toSlug(def.name);
    const filePath = `${this.folderPath}/${slug}.md`;
    const aliasesYaml =
      def.aliases.length > 0
        ? `aliases:\n${def.aliases.map((a) => `  - "${a}"`).join('\n')}`
        : 'aliases: []';
    const content =
      `---\nname: "${def.name}"\n${aliasesYaml}\ndescription: "${def.description.replace(/"/g, '\\"')}"\ngroup: "${def.group}"\nsubgroup: "${def.subgroup}"\nsourceScope: ${def.sourceScope}\n---\n\n# ${def.name}\n\n${def.description}\n`;

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(filePath, content);
    }
    this.cache.set(def.name.toLowerCase(), { ...def, filePath });
  }

  /** Open the definition note in a new leaf. */
  async open(def: FieldDefinition): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(def.filePath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(true).openFile(file);
    }
  }

  async deleteDefinition(fieldName: string): Promise<boolean> {
    const key = fieldName.toLowerCase();
    const def = this.cache.get(key);
    if (!def) return false;
    const file = this.app.vault.getAbstractFileByPath(def.filePath);
    if (file instanceof TFile) {
      await this.app.vault.trash(file, true);
    }
    this.cache.delete(key);
    return true;
  }

  async deleteDefinitionByPath(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      await this.app.vault.trash(file, true);
    }
  }

  toSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .slice(0, 64);
  }
}

// ─── View ─────────────────────────────────────────────────────────────────────

let activeSidebarTooltip: HTMLElement | null = null;

function hideSidebarTooltip() {
	if (activeSidebarTooltip) {
		activeSidebarTooltip.remove();
		activeSidebarTooltip = null;
	}
}

function showSidebarTooltip(anchor: HTMLElement, def: FieldDefinition, plugin: MetadataWranglerPlugin) {
	hideSidebarTooltip();
	activeSidebarTooltip = buildTooltipDom(def.name, def, true);
	document.body.appendChild(activeSidebarTooltip);
	activeSidebarTooltip.style.visibility = 'hidden';
	positionTooltip(activeSidebarTooltip, anchor);
	activeSidebarTooltip.style.visibility = 'visible';
}

class MetadataWranglerView extends ItemView {
	private plugin: MetadataWranglerPlugin;
	index: Map<string, FieldInfo> = new Map();
	private loading = false;
	private searchQuery = '';
	private showFrontmatter = true;
	private showInline = true;
	private listContainer: HTMLElement | null = null;
	private _keyUpHandler: (e: KeyboardEvent) => void;

	constructor(leaf: WorkspaceLeaf, plugin: MetadataWranglerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE; }
	// eslint-disable-next-line obsidianmd/ui/sentence-case
	getDisplayText(): string { return 'metadata wrangler'; }
	getIcon(): string { return 'list-plus'; }

	async onOpen(): Promise<void> {
		this._keyUpHandler = (e: KeyboardEvent) => {
			if (e.key === this.plugin.settings.tooltipModifierKey) hideSidebarTooltip();
		};
		window.addEventListener('keyup', this._keyUpHandler);
		await this.refresh();
	}

	async onClose(): Promise<void> {
		window.removeEventListener('keyup', this._keyUpHandler);
	}

	async refresh(): Promise<void> {
		this.loading = true;
		this.render();
		try {
			this.index = await buildIndex(this.app, this.plugin);
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
	  const q = this.searchQuery.toLowerCase();
	  const fields: FieldInfo[] = [];
	  for (const field of this.index.values()) {
	    if (field.source === 'frontmatter' && !this.showFrontmatter) continue;
	    if (field.source === 'inline' && !this.showInline) continue;
	    if (q) {
	      const nameMatch = field.name.toLowerCase().includes(q);
	      let aliasMatch = false;
	      let descMatch = false;
	      if (this.plugin.settings.searchAliasesAndDescriptions) {
	        const def = this.plugin.definitionStore.resolve(field.name);
	        if (def) {
	          aliasMatch = def.aliases.some((a) => a.toLowerCase().includes(q));
	          descMatch = def.description.toLowerCase().includes(q);
	          // Also match group/subgroup
	          const groupMatch =
	            def.group.toLowerCase().includes(q) || def.subgroup.toLowerCase().includes(q);
	          if (!nameMatch && !aliasMatch && !descMatch && !groupMatch) continue;
	        } else if (!nameMatch) {
	          continue;
	        }
	      } else if (!nameMatch) {
	        continue;
	      }
	    }
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
			// Source badge (p or i) next to each result entry
			row.createEl('span', {
				cls: `field-source-badge ${field.source === 'frontmatter' ? 'p' : 'i'}`,
				text: field.source === 'frontmatter' ? 'p' : 'i',
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
				new FieldEditModal(this.app, this.plugin, field, () => { void this.refresh(); }).open();
			});

			// Sidebar tooltip from definition
			if (this.plugin.settings.enableSidebarTooltips) {
			  const def = this.plugin.definitionStore.resolve(field.name);
			  if (def) {
			    row.setAttribute('data-has-def', 'true');
			    row.addEventListener('mouseenter', (e) => {
			      if (!this.plugin.modifierHeld) return;
			      showSidebarTooltip(row, def, this.plugin);
			    });
			    row.addEventListener('mouseleave', () => {
			      hideSidebarTooltip();
			    });
			    // Optionally render a small group badge after the field name span
			    if (def.group) {
			      row.createEl('span', {
			        cls: 'pw-group-badge',
			        text: def.subgroup ? `${def.group} › ${def.subgroup}` : def.group,
			        title: `Group: ${def.group}${def.subgroup ? ' / ' + def.subgroup : ''}`,
			      });
			    }
			  }
			}
		}
	}
}

// ─── Confirm Modal ────────────────────────────────────────────────────────────

class ConfirmModal extends Modal {
	constructor(app: App, private title: string, private body: string, private onResolve: (confirmed: boolean) => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.title });
		contentEl.createEl('p', { text: this.body });

		const row = contentEl.createDiv({ cls: 'pw-rename-row' });
		const confirmBtn = row.createEl('button', { cls: 'pw-btn pw-btn-danger', text: 'Confirm' });
		const cancelBtn = row.createEl('button', { cls: 'pw-btn', text: 'Cancel' });

		confirmBtn.addEventListener('click', () => {
			this.onResolve(true);
			this.close();
		});
		cancelBtn.addEventListener('click', () => {
			this.onResolve(false);
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

function confirmDialog(app: App, title: string, body: string): Promise<boolean> {
	return new Promise(resolve => {
		const m = new ConfirmModal(app, title, body, resolve);
		m.open();
	});
}

// ─── Field Edit Modal ─────────────────────────────────────────────────────────

class FieldEditModal extends Modal {
	private plugin: MetadataWranglerPlugin;
	private field: FieldInfo;
	private onRefresh: () => void;

	constructor(app: App, plugin: MetadataWranglerPlugin, field: FieldInfo, onRefresh: () => void) {
		super(app);
		this.plugin = plugin;
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
		renameBtn.addEventListener('click', () => {
			void this.handleRename(nameInput.value);
		});

		// ── Definition section ──
		contentEl.createEl('h3', { cls: 'pw-section-title', text: 'Definition' });
		const defSection = contentEl.createDiv({ cls: 'pw-definition-section' });

		const existingDef = this.plugin.definitionStore.resolve(this.field.name);

		// Description
		defSection.createEl('label', { cls: 'pw-label', text: 'Description:' });
		const descTextarea = defSection.createEl('textarea', { cls: 'pw-def-textarea' });
		descTextarea.value = existingDef?.description ?? '';
		descTextarea.rows = 3;
		descTextarea.placeholder = 'Human-readable description of this field…';

		// Aliases
		defSection.createEl('label', { cls: 'pw-label', text: 'Aliases (comma-separated):' });
		const aliasInput = defSection.createEl('input', { cls: 'pw-name-input', type: 'text' });
		aliasInput.value = existingDef?.aliases.join(', ') ?? '';
		aliasInput.placeholder = 'e.g. state, lifecycle status';

		// Group
		defSection.createEl('label', { cls: 'pw-label', text: 'Group:' });
		const groupInput = defSection.createEl('input', { cls: 'pw-name-input', type: 'text' });
		groupInput.value = existingDef?.group ?? '';
		groupInput.placeholder = 'e.g. Project, Person, Status';

		// Subgroup
		defSection.createEl('label', { cls: 'pw-label', text: 'Subgroup (optional):' });
		const subgroupInput = defSection.createEl('input', { cls: 'pw-name-input', type: 'text' });
		subgroupInput.value = existingDef?.subgroup ?? '';
		subgroupInput.placeholder = 'e.g. Administrative, Creative';

		// Save + Open definition buttons
		const defActionRow = defSection.createDiv({ cls: 'pw-rename-row' });
		const saveDefBtn = defActionRow.createEl('button', {
		  cls: 'pw-btn pw-btn-primary',
		  text: existingDef ? 'Save definition' : 'Create definition',
		});
		if (existingDef) {
		  const openDefBtn = defActionRow.createEl('button', {
		    cls: 'pw-btn pw-btn-secondary',
		    text: 'Open definition note',
		  });
		  openDefBtn.addEventListener('click', () => {
		    void this.plugin.definitionStore.open(existingDef);
		  });
		}

		saveDefBtn.addEventListener('click', () => {
		  void this.handleSaveDefinition({
		    name: this.field.name,
		    description: descTextarea.value.trim(),
		    aliases: aliasInput.value
		      .split(',')
		      .map((a) => a.trim())
		      .filter(Boolean),
		    group: groupInput.value.trim(),
		    subgroup: subgroupInput.value.trim(),
		    sourceScope: this.field.source === 'frontmatter'
		      ? 'frontmatter'
		      : this.field.source === 'inline'
		      ? 'inline'
		      : 'both',
		    filePath: existingDef?.filePath ?? '',
		  }, saveDefBtn);
		});

		// Values section
		contentEl.createEl('h3', { cls: 'pw-section-title', text: 'Values' });
		const valuesContainer = contentEl.createDiv({ cls: 'pw-values-container' });
		this.renderValues(valuesContainer);

		// Convert / Copy section
		contentEl.createEl('h3', { cls: 'pw-section-title', text: 'Convert / copy' });
		this.renderConvertSection(contentEl);

		// Danger zone
		contentEl.createEl('h3', { cls: 'pw-section-title pw-danger-title', text: 'Danger zone' });
		const dangerSection = contentEl.createDiv({ cls: 'pw-danger-section' });

		const deleteFieldBtn = dangerSection.createEl('button', {
		  cls: 'pw-btn pw-btn-danger',
		  text: 'Delete field from all notes'
		});

		deleteFieldBtn.addEventListener('click', () => {
			void this.handleDeleteField();
		});

		if (existingDef) {
			const deleteDefBtn = dangerSection.createEl('button', {
			  cls: 'pw-btn pw-btn-danger-outline',
			  text: 'Delete definition only'
			});
			deleteDefBtn.addEventListener('click', () => {
				void this.handleDeleteDefinitionOnly();
			});
		}
	}

	private async handleDeleteField() {
	  const confirmed = await confirmDialog(
		this.app,
	    `Delete field "${this.field.name}" from all ${this.field.files.size} file(s)?`,
	    'This will remove all values for this field from frontmatter and inline. This cannot be undone.'
	  );
	  if (!confirmed) return;
	  const files = [...this.field.files];
	  if (this.field.source === 'frontmatter') {
	    for (const path of files) {
	      await deleteEntireFrontmatterKey(this.app, path, this.field.name);
	    }
	  } else {
	    await deleteAllInlineOccurrences(this.app, files, this.field.name);
	  }
	  const hadDef = await this.plugin.definitionStore.deleteDefinition(this.field.name);
	  const defNote = hadDef ? ' Definition note also deleted.' : '';
	  new Notice(`Deleted field "${this.field.name}" from ${files.length} file(s).${defNote}`);
	  this.close();
	  this.onRefresh();
	}

	private async handleDeleteDefinitionOnly() {
	  const def = this.plugin.definitionStore.resolve(this.field.name);
	  if (!def) { new Notice('No definition exists for this field.'); return; }
	  const confirmed = await confirmDialog(
		this.app,
	    `Delete definition for "${this.field.name}"?`,
	    `This removes the definition note at "${def.filePath}" but leaves field occurrences in notes untouched.`
	  );
	  if (!confirmed) return;
	  await this.plugin.definitionStore.deleteDefinition(this.field.name);
	  new Notice(`Definition for "${this.field.name}" deleted.`);
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

	private async handleSaveDefinition(def: FieldDefinition, btn: HTMLButtonElement): Promise<void> {
	  btn.disabled = true;
	  btn.textContent = 'Saving…';
	  try {
	    await this.plugin.definitionStore.save(def);
	    new Notice(`Definition for "${def.name}" saved.`);
	    btn.textContent = 'Saved ✓';
	    btn.disabled = false;
	  } catch (e) {
	    new Notice(`Failed to save definition for "${def.name}".`);
	    console.error('metadata-wrangler: save definition failed', e);
	    btn.textContent = 'Save definition';
	    btn.disabled = false;
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

	private async handleRename(newName: string): Promise<void> {
		const trimmed = newName.trim();
		if (!trimmed || trimmed === this.field.name) return;
		const files = [...this.field.files];
		if (this.field.source === 'frontmatter') {
			await renameFrontmatterKey(this.app, files, this.field.name, trimmed);
		} else {
			await renameInlineKey(this.app, files, this.field.name, trimmed);
		}

			const def = this.plugin.definitionStore.resolve(this.field.name);
			if (def) {
			  const renamedDef = { ...def, name: trimmed };
			  await this.plugin.definitionStore.save(renamedDef);
			  // Only delete old def file if slug changed
			  const oldSlug = this.plugin.definitionStore.toSlug(this.field.name);
			  const newSlug = this.plugin.definitionStore.toSlug(trimmed);
			  if (oldSlug !== newSlug) {
			    await this.plugin.definitionStore.deleteDefinitionByPath(def.filePath);
			  }
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

// ─── Inline Field Suggester ───────────────────────────────────────────────────

interface SuggestItem {
  field: FieldInfo;
  def: FieldDefinition | undefined;
  /** The text matched (canonical name or alias that triggered the match). */
  matchedText: string;
}

class InlineFieldSuggester extends FuzzySuggestModal<SuggestItem> {
  private plugin: MetadataWranglerPlugin;
  private editor: Editor;
  private items: SuggestItem[] = [];

  constructor(app: App, plugin: MetadataWranglerPlugin, editor: Editor) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.setPlaceholder('Search inline fields…');
    this.setInstructions([
      { command: '↑↓', purpose: 'navigate' },
      { command: '↵', purpose: 'insert field' },
      { command: 'esc', purpose: 'cancel' },
    ]);
  }

  onOpen(): void {
    // Build items from the plugin's current view index via a fresh index call.
    // We resolve inline fields only from the existing sidebar view index if available,
    // falling back to an async build. Use the simpler synchronous path: read the view.
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const view = leaves[0]?.view as MetadataWranglerView | undefined;
    const index: Map<string, FieldInfo> = view
      ? (view as unknown as { index: Map<string, FieldInfo> }).index
      : new Map();

    this.items = [];
    for (const field of index.values()) {
      if (field.source !== 'inline') continue;
      const def = this.plugin.definitionStore.resolve(field.name);
      this.items.push({ field, def, matchedText: field.name });
      // Also add alias-keyed entries for search surfacing
      if (def) {
        for (const alias of def.aliases) {
          this.items.push({ field, def, matchedText: alias });
        }
      }
    }

    super.onOpen();
  }

  getItems(): SuggestItem[] {
    return this.items;
  }

  getItemText(item: SuggestItem): string {
    // FuzzySuggestModal matches against this string.
    // Include name, aliases (via matchedText), group, description for broad matching.
    const parts = [item.field.name, item.matchedText];
    if (item.def?.group) parts.push(item.def.group);
    if (item.def?.subgroup) parts.push(item.def.subgroup);
    if (item.def?.description) parts.push(item.def.description);
    return parts.join(' ');
  }

  renderSuggestion(item: FuzzyMatch<SuggestItem>, el: HTMLElement): void {
    const { item: si } = item;
    el.addClass('pw-suggester-item');
    const nameRow = el.createDiv({ cls: 'pw-suggester-name-row' });
    nameRow.createEl('span', { cls: 'pw-field-name', text: si.field.name });
    if (si.def?.group) {
      nameRow.createEl('span', {
        cls: 'pw-group-badge',
        text: si.def.subgroup
          ? `${si.def.group} › ${si.def.subgroup}`
          : si.def.group,
      });
    }
    if (si.matchedText !== si.field.name) {
      // Matched via alias — show it
      el.createEl('small', {
        cls: 'pw-suggester-alias',
        text: `alias: ${si.matchedText}`,
      });
    }
    if (si.def?.description) {
      el.createEl('small', {
        cls: 'pw-suggester-desc',
        text: si.def.description,
      });
    }
  }

  onChooseItem(item: SuggestItem): void {
    const suffix = this.plugin.settings.insertionTrailingSpace ? ':: ' : '::';
    const insertion = `${item.field.name}${suffix}`;
    this.editor.replaceSelection(insertion);
  }
}

// ─── Tooltip UI Helpers ───────────────────────────────────────────────────────

function buildTooltipDom(fieldName: string, def: FieldDefinition, isSidebar = false): HTMLElement {
  const dom = document.createElement('div');
  dom.addClass(isSidebar ? 'pw-sidebar-tooltip' : 'pw-editor-tooltip');
  dom.createEl('strong', { text: fieldName });
  if (def.group) {
    dom.createEl('span', {
      cls: 'pw-tooltip-group',
      text: ` [${def.group}${def.subgroup ? ' › ' + def.subgroup : ''}]`,
    });
  }
  if (def.description) {
    dom.createEl('p', { cls: 'pw-tooltip-desc', text: def.description });
  }
  if (def.aliases.length > 0) {
    dom.createEl('small', { text: `Aliases: ${def.aliases.join(', ')}` });
  }
  return dom;
}

function positionTooltip(tooltipEl: HTMLElement, anchorEl: HTMLElement) {
  const rect = anchorEl.getBoundingClientRect();
  const scrollY = window.scrollY;
  tooltipEl.style.position = 'fixed';
  tooltipEl.style.zIndex = '10000';
  tooltipEl.style.top = `${rect.top - tooltipEl.offsetHeight - 8}px`;
  tooltipEl.style.left = `${Math.max(8, rect.left)}px`;
  tooltipEl.style.maxWidth = '320px';
}

let activePropertiesTooltip: HTMLElement | null = null;

function hidePropertiesTooltip() {
	if (activePropertiesTooltip) {
		activePropertiesTooltip.remove();
		activePropertiesTooltip = null;
	}
}

function showPropertiesTooltip(anchor: HTMLElement, def: FieldDefinition) {
	hidePropertiesTooltip();
	activePropertiesTooltip = buildTooltipDom(def.name, def, false);
	document.body.appendChild(activePropertiesTooltip);
	activePropertiesTooltip.style.visibility = 'hidden';
	positionTooltip(activePropertiesTooltip, anchor);
	activePropertiesTooltip.style.visibility = 'visible';
}

function registerPropertiesHover(plugin: MetadataWranglerPlugin): () => void {
  const handleMouseEnter = (e: MouseEvent) => {
    if (!plugin.modifierHeld) return;
    if (!plugin.settings.enableEditorTooltips) return;
    const target = e.target as HTMLElement;
    const propEl = target.closest('.metadata-property') as HTMLElement | null;
    if (!propEl) return;
    const keyEl = propEl.querySelector(
      '.metadata-property-key input, .metadata-property-key'
    ) as HTMLInputElement | HTMLElement | null;
    if (!keyEl) return;
    const fieldName = (keyEl as HTMLInputElement).value?.trim()
      ?? keyEl.textContent?.trim();
    if (!fieldName) return;
    const def = plugin.definitionStore.resolve(fieldName);
    if (!def || (!def.description && def.aliases.length === 0 && !def.group)) return;
    showPropertiesTooltip(propEl, def);
  };

  const handleMouseLeave = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.metadata-property')) hidePropertiesTooltip();
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key === plugin.settings.tooltipModifierKey) hidePropertiesTooltip();
  };

  document.addEventListener('mouseover', handleMouseEnter, true);
  document.addEventListener('mouseout', handleMouseLeave, true);
  window.addEventListener('keyup', handleKeyUp);

  return () => {
    document.removeEventListener('mouseover', handleMouseEnter, true);
    document.removeEventListener('mouseout', handleMouseLeave, true);
    window.removeEventListener('keyup', handleKeyUp);
  };
}

// ─── Editor Hover Tooltips ────────────────────────────────────────────────────
// Uses the CodeMirror 6 hoverTooltip extension to show field definitions
// when hovering over "key:: value" patterns in the editor body.

function buildEditorTooltipExtension(plugin: MetadataWranglerPlugin) {
  return hoverTooltip((view, pos) => {
    if (!plugin.modifierHeld) return null;
    if (!plugin.settings.enableEditorTooltips) return null;
    const line = view.state.doc.lineAt(pos);
    const lineText = line.text;
    const m = INLINE_FIELD_RE.exec(lineText);
    if (!m) return null;

    const fieldName = m[1]?.trim();
    if (!fieldName) return null;

    // Only show tooltip if the cursor/hover position is within the key part.
    const keyEnd = line.from + (m.index ?? 0) + m[1]!.length;
    if (pos > keyEnd + 2) return null; // past the "::"

    const def = plugin.definitionStore.resolve(fieldName);
    if (!def || (!def.description && def.aliases.length === 0 && !def.group)) return null;

    return {
      pos: line.from + (m.index ?? 0),
      end: keyEnd,
      above: true,
      create() {
        return { dom: buildTooltipDom(fieldName, def) };
      },
    };
  });
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class MetadataWranglerPlugin extends Plugin {
  settings!: MetadataWranglerSettings;
  definitionStore!: DefinitionStore;
  modifierHeld = false;
  private _onKeyDown: (e: KeyboardEvent) => void;
  private _onKeyUp: (e: KeyboardEvent) => void;
  private _unregisterPropertiesHover?: () => void;
  private _editorExtension: any[] = [];

  /** Public API for DataviewJS and other plugins. */
  api = {
    getFieldDefinition: (name: string) => this.definitionStore.resolve(name),
    getAllFieldDefinitions: () => this.definitionStore.getAll(),
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.definitionStore = new DefinitionStore(this.app, this.settings.definitionFolder);

    // Load definitions after layout is ready (vault is fully available).
    this.app.workspace.onLayoutReady(() => {
      void this.definitionStore.loadAll();
      this._unregisterPropertiesHover = registerPropertiesHover(this);
    });

    this.registerView(VIEW_TYPE, (leaf) => new MetadataWranglerView(leaf, this));

    this._onKeyDown = (e: KeyboardEvent) => {
      if (e.key === this.settings.tooltipModifierKey) this.modifierHeld = true;
    };
    this._onKeyUp = (e: KeyboardEvent) => {
      if (e.key === this.settings.tooltipModifierKey) this.modifierHeld = false;
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this.addRibbonIcon('list-plus', 'metadata wrangler', () => {
      void this.openView();
    });

    this.addCommand({
      id: 'open-view',
      name: 'Open view',
      callback: () => { void this.openView(); },
    });

    this.addCommand({
      id: 'insert-inline-field',
      name: 'Insert inline field at cursor',
      editorCallback: (editor) => {
        new InlineFieldSuggester(this.app, this, editor).open();
      },
    });

    this.addSettingTab(new MetadataWranglerSettingTab(this.app, this));

    if (this.settings.enableEditorTooltips) {
      this._editorExtension = [buildEditorTooltipExtension(this)];
      this.registerEditorExtension(this._editorExtension);
    }
  }

  rebuildEditorExtension(): void {
    if (this.settings.enableEditorTooltips) {
      this._editorExtension.length = 0;
      this._editorExtension.push(buildEditorTooltipExtension(this));
      this.app.workspace.updateOptions();
    }
  }

  onunload(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this._unregisterPropertiesHover?.();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.definitionStore.updateFolder(this.settings.definitionFolder);
  }

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
