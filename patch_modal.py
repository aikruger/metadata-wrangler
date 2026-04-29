import re

with open("src/main.ts", "r") as f:
    content = f.read()

# 1. Update onOpen to include "Add allowed value" row
onopen_target = """		// Values section
		contentEl.createEl('h3', { cls: 'pw-section-title', text: 'Values' });
		const valuesContainer = contentEl.createDiv({ cls: 'pw-values-container' });
		this.renderValues(valuesContainer);"""

onopen_replace = """		// Values section
		contentEl.createEl('h3', { cls: 'pw-section-title', text: 'Values' });
		const valuesSection = contentEl.createDiv({ cls: 'pw-values-section' });

		// --- NEW: add-allowed-value row at the top ---
		const def = this.plugin.definitionStore.resolve(this.field.name);
		const addRow = valuesSection.createDiv({ cls: 'pw-add-value-row' });
		const addInput = addRow.createEl('input', {
			cls: 'pw-edit-input',
			type: 'text',
			placeholder: 'Add allowed value…',
		});
		const addLabelInput = addRow.createEl('input', {
			cls: 'pw-edit-input pw-add-label-input',
			type: 'text',
			placeholder: 'Label (optional)',
		});
		const addBtn = addRow.createEl('button', {
			cls: 'pw-btn pw-btn-primary',
			text: '+ Add',
		});

		addInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') addBtn.click();
		});

		addBtn.addEventListener('click', async () => {
			const val = addInput.value.trim();
			if (!val) {
				addInput.focus();
				return;
			}
			await this.handleAddAllowedValue(val, addLabelInput.value.trim());
			addInput.value = '';
			addLabelInput.value = '';
			addInput.focus();
		});

		const valuesContainer = valuesSection.createDiv({ cls: 'pw-values-container' });
		this.renderValues(valuesContainer);"""

content = content.replace(onopen_target, onopen_replace)

# 2. Add handleAddAllowedValue, renderValues (merged), renderMergedValueRow, and handleRemoveAllowedValue
methods_to_add = """
	async handleAddAllowedValue(value: string, label: string): Promise<void> {
		const existing = this.plugin.definitionStore.resolve(this.field.name);
		const currentAllowed: AllowedValue[] = existing?.allowedValues ?? [];

		if (currentAllowed.some(av => av.value.toLowerCase() === value.toLowerCase())) {
			new Notice(`"${value}" is already an allowed value.`);
			return;
		}

		const newAllowed: AllowedValue[] = [...currentAllowed, { value, label }];

		const defToSave: FieldDefinition = existing
			? { ...existing, allowedValues: newAllowed }
			: {
					name: this.field.name,
					sourceScope: this.field.source === 'frontmatter' ? 'frontmatter'
							 : this.field.source === 'inline'       ? 'inline'
							 : 'both',
					aliases: [],
					description: '',
					group: '',
					subgroup: '',
					filePath: '',
					allowedValues: newAllowed,
				};

		await this.plugin.definitionStore.save(defToSave);
		new Notice(`Added "${value}" as an allowed value for "${this.field.name}".`);

		const container = this.contentEl.querySelector('.pw-values-container') as HTMLElement;
		if (container) this.renderValues(container);
	}

	async handleRemoveAllowedValue(value: string): Promise<void> {
		const def = this.plugin.definitionStore.resolve(this.field.name);
		if (!def) return;

		const newAllowed = def.allowedValues.filter(
			av => av.value.toLowerCase() !== value.toLowerCase()
		);
		await this.plugin.definitionStore.save({ ...def, allowedValues: newAllowed });
		new Notice(`Removed "${value}" from allowed values.`);

		const container = this.contentEl.querySelector('.pw-values-container') as HTMLElement;
		if (container) this.renderValues(container);
	}

	private renderValues(container: HTMLElement): void {
		container.empty();
		const def = this.plugin.definitionStore.resolve(this.field.name);
		const allowedValues: AllowedValue[] = def?.allowedValues ?? [];

		type MergedRow = {
			value: string;
			observed: boolean;
			allowed: boolean;
			occurrences?: ValueInfo;
			label?: string;
		};

		const rows = new Map<string, MergedRow>();

		for (const [value, occurrences] of this.field.values) {
			rows.set(value, {
				value,
				observed: true,
				allowed: false,
				occurrences,
			});
		}

		for (const av of allowedValues) {
			if (rows.has(av.value)) {
				rows.get(av.value)!.allowed = true;
				rows.get(av.value)!.label = av.label || undefined;
			} else {
				rows.set(av.value, {
					value: av.value,
					observed: false,
					allowed: true,
					label: av.label || undefined,
				});
			}
		}

		if (rows.size === 0) {
			container.createDiv({ cls: 'pw-empty', text: 'No values.' });
			return;
		}

		const sorted = [...rows.values()].sort((a, b) => {
			const rank = (r: MergedRow) =>
				r.observed && r.allowed ? 0 :
				r.observed              ? 1 : 2;
			return rank(a) - rank(b) || a.value.localeCompare(b.value);
		});

		for (const row of sorted) {
			this.renderMergedValueRow(container, row, def || null);
		}
	}

	private renderMergedValueRow(
		container: HTMLElement,
		row: any,
		def: FieldDefinition | null
	): void {
		const rowEl = container.createDiv({
			cls: `pw-value-row${!row.observed ? " pw-value-defined-only" : ""}`,
		});

		const header = rowEl.createDiv({ cls: "pw-value-header" });

		const valueTextEl = header.createEl("span", {
			cls: "pw-value-text",
			text: row.value === "" && row.observed ? "(empty)" : row.value,
		});
		if (row.label) {
			header.createEl("span", {
				cls: "pw-value-label",
				text: row.label,
			});
		}

		if (!row.observed && row.allowed) {
			header.createEl("span", {
				cls: "pw-badge pw-badge-defined",
				text: "defined only",
				title: "This value is listed as allowed in the definition but has not been used in any note yet.",
			});
		} else if (row.observed && row.allowed) {
			header.createEl("span", {
				cls: "pw-badge pw-badge-allowed",
				text: "✓ allowed",
				title: "This value is both observed in notes and listed as an allowed value in the definition.",
			});
		}

		if (row.observed && row.occurrences) {
			const fileToggle = header.createEl("button", {
				cls: "pw-btn pw-btn-ghost",
				text: `${row.occurrences.files.size} file${row.occurrences.files.size !== 1 ? "s" : ""}`,
				title: "Toggle file list",
			});
			const fileList = rowEl.createDiv({ cls: "pw-file-list pw-hidden" });
			fileToggle.addEventListener("click", () => {
				fileList.toggleClass("pw-hidden", !fileList.hasClass("pw-hidden"));
			});
			for (const filePath of row.occurrences.files) {
				const entry = fileList.createDiv({ cls: "pw-file-entry" });
				const link = entry.createEl("a", { cls: "pw-file-link", text: filePath });
				link.addEventListener("click", () => {
					const f = this.app.vault.getAbstractFileByPath(filePath);
					if (f instanceof TFile) {
						void this.app.workspace.getLeaf().openFile(f);
						this.close();
					}
				});
			}
		}

		const actions = rowEl.createDiv({ cls: "pw-value-actions" });

		if (row.observed) {
			const editBtn = actions.createEl("button", { cls: "pw-btn pw-btn-secondary", text: "Edit" });
			const deleteBtn = actions.createEl("button", { cls: "pw-btn pw-btn-danger", text: "Delete from notes" });
			editBtn.addEventListener("click", () =>
				this.showEditInput(rowEl, editBtn, row.value, row.occurrences!)
			);
			deleteBtn.addEventListener("click", () =>
				this.handleDeleteValue(row.value, row.occurrences!)
			);
		}

		if (row.allowed) {
			const removeAllowedBtn = actions.createEl("button", {
				cls: "pw-btn pw-btn-ghost",
				text: "Remove from allowed",
				title: "Remove this value from the definition's allowed list without changing any notes.",
			});
			removeAllowedBtn.addEventListener("click", () =>
				this.handleRemoveAllowedValue(row.value)
			);
		} else if (row.observed) {
			const promoteBtn = actions.createEl("button", {
				cls: "pw-btn pw-btn-ghost",
				text: "Add to allowed",
				title: "Add this observed value to the definition's allowed list.",
			});
			promoteBtn.addEventListener("click", () =>
				this.handleAddAllowedValue(row.value, "")
			);
		}
	}
"""

old_render_values_regex = r"\bprivate renderValues\(container: HTMLElement\): void \{.*?(?=\n\tprivate showEditInput)"
content = re.sub(old_render_values_regex, methods_to_add.strip(), content, flags=re.DOTALL)

with open("src/main.ts", "w") as f:
    f.write(content)
