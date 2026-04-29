import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from "obsidian";
import MetadataWranglerPlugin from "../main";

export class AllowedValueSuggest extends EditorSuggest<any> {
  constructor(private plugin: MetadataWranglerPlugin) {
    super(plugin.app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);

    // Match YAML frontmatter value position: "key: <cursor>"
    const frontmatterMatch = /^([A-Za-z0-9_\- ]+):\s*(.*)$/.exec(line);
    if (frontmatterMatch && frontmatterMatch.length > 2) {
      const fieldName = (frontmatterMatch[1] || "").trim();
      const def = this.plugin.definitionStore.resolve(fieldName);
      if (!def || !def.allowedValues || def.allowedValues.length === 0) return null;
      const valText = frontmatterMatch[2] || "";
      const valueStart = line.indexOf(valText);
      if (valueStart === -1) return null;
      return {
        start: { line: cursor.line, ch: valueStart },
        end:   { line: cursor.line, ch: cursor.ch },
        query: valText.substring(0, cursor.ch - valueStart),
      };
    }

    // Match inline field position: "fieldName:: <cursor>"
    const inlineMatch = /^([A-Za-z0-9_\- ]+)::\s*(.*)$/.exec(line);
    if (inlineMatch && inlineMatch.length > 2) {
      const fieldName = (inlineMatch[1] || "").trim();
      const def = this.plugin.definitionStore.resolve(fieldName);
      if (!def || !def.allowedValues || def.allowedValues.length === 0) return null;
      const valText = inlineMatch[2] || "";
      const valueStart = line.indexOf(valText);
      if (valueStart === -1) return null;
      return {
        start: { line: cursor.line, ch: valueStart },
        end:   { line: cursor.line, ch: cursor.ch },
        query: valText.substring(0, cursor.ch - valueStart),
      };
    }

    return null;
  }

  getSuggestions(ctx: EditorSuggestContext): any[] {
    const line = ctx.editor.getLine(ctx.start.line);
    const execResult = /^([A-Za-z0-9_\- ]+)::?\s*/.exec(line);
    const fieldName = (execResult && execResult.length > 1 ? execResult[1] || "" : "").trim();
    const def = this.plugin.definitionStore.resolve(fieldName);
    if (!def || !def.allowedValues) return [];

    const query = ctx.query.toLowerCase();
    return def.allowedValues.filter((av: any) =>
      av.value.toLowerCase().includes(query) ||
      (av.label && av.label.toLowerCase().includes(query))
    );
  }

  renderSuggestion(item: any, el: HTMLElement): void {
    el.createEl("span", { cls: "pw-suggest-value", text: item.value });
    if (item.label) {
      el.createEl("small", { cls: "pw-suggest-value-label", text: item.label });
    }
  }

  selectSuggestion(item: any, evt: MouseEvent | KeyboardEvent): void {
    if (this.context) {
      const { editor, start, end } = this.context;
      editor.replaceRange(item.value, start, end);
    }
  }
}
