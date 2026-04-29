import re

with open("src/main.ts", "r") as f:
    content = f.read()

# Update readDefinitionFile
read_def_target = """        sourceScope: (['frontmatter', 'inline', 'both'].includes(fm['sourceScope'] as string)
          ? fm['sourceScope']
          : 'both') as FieldDefinition['sourceScope'],
        filePath: file.path,"""
read_def_replace = """        sourceScope: (['frontmatter', 'inline', 'both'].includes(fm['sourceScope'] as string)
          ? fm['sourceScope']
          : 'both') as FieldDefinition['sourceScope'],
        filePath: file.path,
        allowedValues: Array.isArray(fm['allowedValues'])
          ? fm['allowedValues'].map((v: any) => ({
              value: String(v?.value ?? v ?? "").trim(),
              label: typeof v?.label === "string" ? v.label.trim() : "",
            })).filter((v: any) => v.value.length > 0)
          : [],"""

content = content.replace(read_def_target, read_def_replace)

# Update save
save_target = """    const aliasesYaml =
      def.aliases.length > 0
        ? `aliases:\\n${def.aliases.map((a) => `  - "${a}"`).join('\\n')}`
        : 'aliases: []';
    const content =
      `---\\nname: "${def.name}"\\n${aliasesYaml}\\ndescription: "${def.description.replace(/"/g, '\\\\"')}"\\ngroup: "${def.group}"\\nsubgroup: "${def.subgroup}"\\nsourceScope: ${def.sourceScope}\\n---\\n\\n# ${def.name}\\n\\n${def.description}\\n`;"""

save_replace = """    const aliasesYaml =
      def.aliases.length > 0
        ? `aliases:\\n${def.aliases.map((a) => `  - "${a}"`).join('\\n')}`
        : 'aliases: []';
    const allowedValuesYaml = def.allowedValues && def.allowedValues.length > 0
      ? `allowedValues:\\n${def.allowedValues.map(av => `  - value: ${av.value}\\n    label: "${(av.label || '').replace(/"/g, '\\\\"')}"`).join('\\n')}`
      : 'allowedValues: []';
    const content =
      `---\\nname: "${def.name}"\\ndescription: "${def.description.replace(/"/g, '\\\\"')}"\\nsourceScope: ${def.sourceScope}\\n${aliasesYaml}\\ngroup: "${def.group}"\\nsubgroup: "${def.subgroup}"\\n${allowedValuesYaml}\\n---\\n\\n# ${def.name}\\n\\n${def.description}\\n`;"""

content = content.replace(save_target, save_replace)

with open("src/main.ts", "w") as f:
    f.write(content)
