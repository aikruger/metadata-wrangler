import re

with open("src/main.ts", "r") as f:
    content = f.read()

target = """		saveDefBtn.addEventListener('click', () => {
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
		});"""

replace = """		saveDefBtn.addEventListener('click', () => {
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
		    allowedValues: existingDef?.allowedValues ?? [],
		  }, saveDefBtn);
		});"""

content = content.replace(target, replace)

with open("src/main.ts", "w") as f:
    f.write(content)
