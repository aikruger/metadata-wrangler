# metadata wrangler

An Obsidian plugin for managing vault metadata: search, filter, rename, edit, and convert both frontmatter properties and Dataview-style inline fields across all files.

## Features

### Sidebar view
- Lists **all field names** found across the vault (frontmatter properties and inline fields)
- **Search** by field name with debounced input
- **Filter** by source: Properties `[p]` and/or Inline `[i]`
- Each result shows:
  - A source badge: `[p]` for frontmatter, `[i]` for inline fields — displayed next to each entry
  - A **field type badge**: `text`, `number`, `checkbox`, `date`, `datetime`, or `list`
  - File count and unique value count
- Click any field row to open the field edit modal

### Field edit modal
- **Rename** a field vault-wide (frontmatter key or inline `key::` pattern)
- **Values list**: view all unique values with file lists, edit values, or delete values — all vault-wide
- **Convert / Copy** between inline and frontmatter:
  - Frontmatter → inline: inserts `key:: value` line(s) at the top of the file body
  - Inline → frontmatter: collects `key:: value` occurrences and adds them to frontmatter
  - Choose **Convert (move)** or **Copy (keep original)** via radio buttons

## Field type detection

| Type | Detection criteria |
|---|---|
| `checkbox` | Boolean raw value, or string `true`/`false` |
| `number` | Numeric raw value, or parseable number string |
| `date` | String matching `YYYY-MM-DD` |
| `datetime` | String matching `YYYY-MM-DDTHH:MM…` |
| `list` | Array raw value in frontmatter |
| `text` | Any other string |

## Installation

Copy `main.js`, `manifest.json`, and `styles.css` to:
```
VaultFolder/.obsidian/plugins/metadata-wrangler/
```

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
npm run lint   # lint
```
