# s02: Tool Use — Thêm một tool, chỉ thêm một dòng

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → `s02` → [s03](../s03_permission/) → s04 → ... → s16 → s17
> *"Add a tool, add just one handler"* — Vòng lặp giữ nguyên. Đăng ký tool mới vào bảng dispatch là xong.
>
> **Tầng Harness**: Tool Dispatch — Mở rộng tầm với của mô hình.

---

## Chỉ một tool: Bash

Agent s01 chỉ có một tool: bash. Đọc file thì `cat`; ghi thì `echo "..." > file.py`; sửa thì `sed`.

Mô hình nghĩ "đọc file này" nhưng phải viết ra `cat path/to/file`. Một lớp dịch thừa, tốn token và dễ lỗi.

---

## Tổng quan: Tool Dispatch

![Tool Dispatch](images/tool-dispatch.en.svg)

Vòng lặp s01 được giữ nguyên (gọi LLM, kiểm tra block `tool_use`, append tin nhắn — không đổi một chữ). Thay đổi duy nhất nằm ở một dòng thực thi tool: `run_bash()` được thay bằng lookup `TOOL_HANDLERS[block.name]()`.

Thêm một tool cho Agent chỉ cần hai việc:

1. **Định nghĩa tool**: Thêm một mục vào mảng `TOOLS`
2. **Đăng ký handler**: Thêm một mapping trong dict `TOOL_HANDLERS`

---

## Từ 1 tool lên 5 tool

s01 chỉ có bash:

```python
TOOLS = [{"name": "bash", ...}]

def run_bash(command): ...
```

s02 mở rộng thành 5 tool, mỗi cái định nghĩa độc lập:

```python
TOOLS = [
    {"name": "bash",       "description": "Run a shell command.", ...},
    {"name": "read_file",  "description": "Read file contents.",  ...},
    {"name": "write_file", "description": "Write content to file.", ...},
    {"name": "edit_file",  "description": "Replace text in file once.", ...},
    {"name": "glob",       "description": "Find files by pattern.", ...},
]
```

Mỗi tool có hàm triển khai riêng:

```python
def run_read(path, limit=None):
    lines = safe_path(path).read_text(encoding="utf-8").splitlines()
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)

def run_write(path, content):
    safe_path(path).write_text(content, encoding="utf-8")
    return f"Wrote {len(content)} bytes to {path}"

def run_edit(path, old_text, new_text):
    text = safe_path(path).read_text(encoding="utf-8")
    if old_text not in text:
        return "Error: text not found"
    safe_path(path).write_text(text.replace(old_text, new_text, 1), encoding="utf-8")
    return f"Edited {path}"

def run_glob(pattern):
    import glob as g
    matches = sorted(set(g.glob(
        pattern, root_dir=WORKDIR, recursive=True)))
    shown = matches[:200]
    if len(matches) > 200:
        shown.append("... (more matches omitted; narrow the pattern)")
    return "\n".join(shown)
```

---

## Tool Dispatch

```python
TOOL_HANDLERS = {
    "bash":       run_bash,
    "read_file":  run_read,
    "write_file": run_write,
    "edit_file":  run_edit,
    "glob":       run_glob,
}

# Only one line changed in the loop — from hardcoded run_bash to dispatch lookup:
for block in tool_calls:
    handler = TOOL_HANDLERS[block.name]    # lookup
    output = handler(**block.input)         # call
    results.append(...)
```

Thêm tool = một mục trong mảng `TOOLS` + một dòng trong dict `TOOL_HANDLERS`. Vòng lặp giữ nguyên.

---

## Nhiều lần gọi tool

Mô hình thường trả về nhiều `tool_use` cùng lúc — "đọc a.py và b.py, rồi liệt kê mọi file .py".

Các lần gọi được thực thi lần lượt theo thứ tự gốc trong `response.content`.

---

## Tra cứu nhanh

| Khái niệm | Một câu |
|---------|-----------|
| TOOL_HANDLERS | Dict tên tool → hàm handler. Thêm tool = thêm một dòng mapping |
| Tool Definition | JSON schema nói với mô hình "tôi làm được gì" |
| Multiple tool calls | Mô hình có thể trả nhiều tool_use cùng lúc; thực thi theo thứ tự gốc |
| Loop Unchanged | Vòng `while True` của s01 — không đổi một dòng |

---

## Thay đổi so với s01

| Thành phần | Trước (s01) | Sau (s02) |
|-----------|-------------|-------------|
| Số tool | 1 (bash) | 5 (+read, write, edit, glob) |
| Thực thi tool | `run_bash()` cứng | Lookup TOOL_HANDLERS |
| An toàn path | Không | Kiểm tra safe_path (chỉ file tools) |
| Vòng lặp | `while True` + block `tool_use` | Giống hệt s01 |

---

## Thử chạy

```sh
cd learn-claude-code
python s02_tool_use/code.py
```

Thử các prompt sau:

1. `Read the file README.md and tell me what this project is about`
2. `Create a file called test.py that prints "hello", then read it back`
3. `Find all Python files in this directory`
4. `Read both README.md and requirements.txt, then create a summary file`

Điều cần quan sát: Khi nào mô hình chỉ gọi một tool, khi nào gọi nhiều cùng lúc? Nhiều lần gọi có được thực thi đúng thứ tự không?

---

## Tiếp theo

Agent giờ có 5 tool chuyên biệt. File tools được `safe_path` bảo vệ, nhưng bash thì không hạn chế — `rm -rf /` vẫn chạy.

→ s03 Permission: Thêm cổng trước khi thực thi tool — thao tác này có an toàn không? Có cần người dùng duyệt không?


<!-- translation-sync: zh@v1, en@v1, ja@v1, vi@v1 -->
