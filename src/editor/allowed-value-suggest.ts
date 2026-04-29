import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from "obsidian";
import MetadataWranglerPlugin from "../main";

export class AllowedValueSuggest extends EditorSuggest<any> {
  constructor(private plugin: MetadataWranglerPlugin) {
    super(plugin.app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);

    // --- Case 1: inline field  "fieldname:: <value>"
    // Match everything from line start up to cursor
    const inlineMatch = /^([A-Za-z0-9_\-][A-Za-z0-9_\- ]*):: ?(.*)$/.exec(
      line.slice(0, cursor.ch + 1)
    );
    if (inlineMatch && inlineMatch.length > 2) {
      const fieldName = (inlineMatch[1] || "").trim();
      const def = this.plugin.definitionStore.resolve(fieldName);
      if (!def || !def.allowedValues || def.allowedValues.length === 0) return null;

      // value typing starts after ":: " or "::"
      const valueStart = line.indexOf(":: ") !== -1
        ? line.indexOf(":: ") + 3
        : line.indexOf("::") + 2;

      if (valueStart === -1) return null;

      return {
        start: { line: cursor.line, ch: valueStart },
        end:   { line: cursor.line, ch: cursor.ch },
        query: line.slice(valueStart, cursor.ch),
      };
    }

    // --- Case 2: frontmatter property  "fieldname: <value>"
    // Only fire inside the frontmatter block (lines between --- delimiters)
    const fmEnd = this._getFrontmatterEnd(editor);
    if (fmEnd !== null && cursor.line > 0 && cursor.line < fmEnd) {
      const fmMatch = /^([A-Za-z0-9_\-][A-Za-z0-9_\- ]*): ?(.*)$/.exec(
        line.slice(0, cursor.ch + 1)
      );
      if (fmMatch && fmMatch.length > 2) {
        const fieldName = (fmMatch[1] || "").trim();
        const def = this.plugin.definitionStore.resolve(fieldName);
        if (!def || !def.allowedValues || def.allowedValues.length === 0) return null;

        const valueStart = line.indexOf(": ") !== -1
          ? line.indexOf(": ") + 2
          : line.indexOf(":") + 1;

        if (valueStart === -1) return null;

        return {
          start: { line: cursor.line, ch: valueStart },
          end:   { line: cursor.line, ch: cursor.ch },
          query: line.slice(valueStart, cursor.ch),
        };
      }
    }

    return null;
  }

  // Helper: return the line index of the closing "---" of frontmatter, or null
  _getFrontmatterEnd(editor: Editor): number | null {
    if (editor.getLine(0).trim() !== "---") return null;
    for (let i = 1; i < Math.min(editor.lineCount(), 100); i++) {
      if (editor.getLine(i).trim() === "---") return i;
    }
    return null;
  }

  getSuggestions(ctx: EditorSuggestContext): any[] {
    const line = ctx.editor.getLine(ctx.start.line);
    // Extract field name from the line regardless of :: or :
    const execResult = /^([A-Za-z0-9_\-][A-Za-z0-9_\- ]*)::?/.exec(line);
    const fieldName = (execResult && execResult.length > 1 ? execResult[1] || "" : "").trim();
    const def = this.plugin.definitionStore.resolve(fieldName);
    if (!def || !def.allowedValues || def.allowedValues.length === 0) return [];

    const query = ctx.query.toLowerCase();
    if (!query) return def.allowedValues;   // show all when nothing typed yet

    return def.allowedValues.filter((av: any) =>
      av.value.toLowerCase().includes(query) ||
      (av.label && av.label.toLowerCase().includes(query))
    );
  }

  renderSuggestion(item: any, el: HTMLElement): void {
    el.addClass("pw-value-suggest-item");
    el.createEl("span", { cls: "pw-suggest-value", text: item.value });
    if (item.label) {
      el.createEl("small", { cls: "pw-suggest-value-label", text: item.label });
    }
  }

  selectSuggestion(item: any, evt: MouseEvent | KeyboardEvent): void {
    if (this.context) {
      const { editor, start, end } = this.context;
      editor.replaceRange(item.value, start, end);
      // Move cursor to end of inserted value
      editor.setCursor({ line: start.line, ch: start.ch + item.value.length });
    }
  }
}
