import re

with open("src/main.ts", "r") as f:
    content = f.read()

allowed_value_interface = """
interface AllowedValue {
  value: string;
  label?: string;
  description?: string;
}
"""

# Insert interface AllowedValue before interface FieldDefinition
content = content.replace("interface FieldDefinition {", allowed_value_interface + "\ninterface FieldDefinition {")

# Add allowedValues to FieldDefinition
content = content.replace("filePath: string;", "filePath: string;\n  allowedValues: AllowedValue[];")

with open("src/main.ts", "w") as f:
    f.write(content)
