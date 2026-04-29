import re

with open("src/editor/allowed-value-suggest.ts", "r") as f:
    content = f.read()

# Replace frontmatterMatch[1] -> frontmatterMatch![1]
content = re.sub(r'frontmatterMatch\[1\]', 'frontmatterMatch![1]', content)

# Replace frontmatterMatch[2] -> frontmatterMatch![2]
content = re.sub(r'frontmatterMatch\[2\]', 'frontmatterMatch![2]', content)

# Replace inlineMatch[1] -> inlineMatch![1]
content = re.sub(r'inlineMatch\[1\]', 'inlineMatch![1]', content)

# Replace inlineMatch[2] -> inlineMatch![2]
content = re.sub(r'inlineMatch\[2\]', 'inlineMatch![2]', content)

# Replace execResult[1] -> execResult![1]
content = re.sub(r'execResult\[1\]', 'execResult![1]', content)

with open("src/editor/allowed-value-suggest.ts", "w") as f:
    f.write(content)
