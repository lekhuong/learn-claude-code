# s07: Skill Loading — Load Skill khi cần

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → s02 → s03 → s04 → s05 → s06 → `s07` → [s08](../s08_context_compact/) → s09 → ... → s16 → s17

> System prompt chứa catalog Skill; `load_skill` trả về toàn bộ `SKILL.md`.
>
> **Tầng Harness**: Knowledge loading — cho mô hình biết Skill nào tồn tại, rồi load từng cái theo tên.

---

## Vấn đề

Giả sử dự án có một đặc tả component React, một style guide SQL, và một tài liệu thiết kế API. Ta muốn Agent tuân các quy tắc này khi phát triển, nên cách thẳng nhất là nhét hết vào system prompt:

```python
SYSTEM = (
    f"You are a coding agent. "
    + open("docs/react-style.md").read()
    + open("docs/sql-style.md").read()
    + open("docs/api-design.md").read()
)
```

Cách này để Agent đọc mọi đặc tả, nhưng cố định cả ba tài liệu trong system prompt thay vì chỉ chọn cái cần cho task hiện tại. Mỗi lần gọi LLM gửi toàn bộ text của cả ba tài liệu tới mô hình. Khi task chỉ sửa component React, chỉ đặc tả React là liên quan; style guide SQL và tài liệu thiết kế API vẫn tiêu token input và chỗ trong context-window vốn có thể giữ code, hội thoại, và kết quả tool.

---

## Giải pháp

![Skill Overview](images/skill-overview.en.svg)

Khi khởi động, `SkillLoader` quét `skills/*/SKILL.md`, đọc `name` và `description` từ YAML frontmatter, rồi thêm catalog đó vào system prompt. Khi mô hình cần hướng dẫn đầy đủ, nó gọi `load_skill(name)`; `SKILL.md` trả về được append vào list tin nhắn như một `tool_result`.

| Nội dung | Input của mô hình | Thời điểm thêm |
|---------|-------------|-------|
| Tên và mô tả Skill | system prompt | Khi khởi động |
| Toàn bộ `SKILL.md` | `tool_result` | Khi gọi `load_skill` |

---

## Cách hoạt động

Mỗi Skill là một thư mục chứa `SKILL.md`:

```text
skills/
  agent-builder/SKILL.md
  code-review/SKILL.md
  mcp-builder/SKILL.md
  pdf/SKILL.md
```

### Quét Skill

```python
class SkillLoader:
    def scan(self):
        self.skills.clear()
        skills_root = self.skills_dir.resolve()
        for manifest in sorted(self.skills_dir.glob("*/SKILL.md")):
            if (not manifest.is_file()
                    or not manifest.resolve().is_relative_to(skills_root)):
                continue
            content = manifest.read_text(encoding="utf-8")
            metadata, body = self.parse_frontmatter(content)
            raw_name = metadata.get("name")
            name = raw_name.strip() if isinstance(raw_name, str) else ""
            name = name or manifest.parent.name
            raw_description = metadata.get("description")
            description = (raw_description.strip()
                           if isinstance(raw_description, str) else "")
            description = description or body.split("\n", 1)[0]
            description = " ".join(str(description).lstrip("# ").split())
            self.skills[name] = {
                "name": name,
                "description": description,
                "content": content,
            }
```

`catalog()` chỉ trả về tên và mô tả:

```text
- code-review: Perform thorough code reviews...
- pdf: Process PDF files...
```

### Dựng system prompt

```python
def build_system_prompt() -> str:
    return (
        f"You are a coding agent at {WORKDIR}. Use tools to solve tasks. "
        "Act, don't explain.\n\n"
        f"Skills available:\n{SKILL_LOADER.catalog()}\n\n"
        "Use load_skill to read the full instructions when a skill applies."
    )
```

Hàm này ghép hướng dẫn Agent cố định với catalog tìm được lúc khởi động.

### Load nội dung đầy đủ

```python
def load(self, name: str) -> str:
    skill = self.skills.get(name)
    if skill:
        return skill["content"]
    available = ", ".join(self.skills) or "none"
    return f"Error: Unknown skill '{name}'. Available: {available}"
```

`name` tra registry lúc khởi động; không được diễn giải thành đường dẫn file. Sau khi tool trả về, Agent Loop sẵn có append nội dung đó như một tin nhắn `tool_result` mới.

---

## Thử chạy

```sh
cd learn-claude-code
python s07_skill_loading/code.py
```

Thử các prompt sau:

1. `What skills are available?`
2. `Load the code-review skill and follow its instructions`
3. `Review README.md and load the relevant skill first`

Kiểm tra system prompt chỉ chứa catalog và toàn bộ `SKILL.md` xuất hiện sau khi gọi `load_skill`.

---

## Tiếp theo

Khi các lần gọi tool tích lại, `messages[]` giữ nội dung file và kết quả tool trước đó.

→ s08 Context Compact: rút gọn tin nhắn cũ hơn và giữ context còn chỗ cho các lần gọi sau.


<!-- translation-sync: zh@v6, en@v6, ja@v6, vi@v6 -->
