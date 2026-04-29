import re

with open("src/main.ts", "r") as f:
    content = f.read()

# Add import
import_stmt = 'import { AllowedValueSuggest } from "./editor/allowed-value-suggest";\n'
content = import_stmt + content

# Register suggest
register_target = """		this.registerEditorSuggest(new InlineFieldSuggester(this.app, this));
		this.registerMarkdownPostProcessor(this.postProcessMarkdown.bind(this));"""
register_replace = """		this.registerEditorSuggest(new InlineFieldSuggester(this.app, this));
		this.registerEditorSuggest(new AllowedValueSuggest(this));
		this.registerMarkdownPostProcessor(this.postProcessMarkdown.bind(this));"""

content = content.replace(register_target, register_replace)

with open("src/main.ts", "w") as f:
    f.write(content)
