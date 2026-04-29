import re

with open("src/editor/allowed-value-suggest.ts", "r") as f:
    content = f.read()

# Wait, TS2532 "Object is possibly 'undefined'" usually means frontmatterMatch is not checked properly?
# But it IS checked `if (frontmatterMatch)`.
# Let's write the file directly.
