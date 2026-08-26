# s09: Memory — Giữ kiến thức hữu ích xuyên suốt các phiên

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → ... → s07 → s08 → `s09` → [s10](../s10_task_system/) → s11 → ... → s16 → s17
> *"Keep information that later tasks will need."* Lưu file + một index + chọn theo độ liên quan + recall khi cần.
>
> **Tầng Harness**: Memory lưu kiến thức tái sử dụng bên ngoài hội thoại và recall khi gặp task liên quan.

---

## Vấn đề

Một Agent bắt đầu phiên mới mà không có hội thoại trước trong `messages`. Một preference về coding, sự kiện của project, hay manh mối debug từ phiên trước vẫn có thể còn hữu ích. Không có lưu trữ bền vững, người dùng phải cung cấp lại.

Transcript đầy đủ dùng được như kho lưu, nhưng gửi kèm mọi request thì không scale. Hội thoại cứ lớn dần, thông tin hữu ích ngày càng khó tìm, và sự kiện cũ có thể không còn đúng. Memory phải quyết định gì đáng giữ xuyên phiên và bản ghi nào thuộc về task hiện tại.

![Memory Overview](images/memory-overview.en.svg)

---

## Vì sao không đưa tất cả vào System Prompt?

Cách trực tiếp là ghi preference và sự kiện project vào một file, rồi nhét cả file vào system prompt. Nó nhớ được thông tin, nhưng mỗi lần gọi LLM phải gửi lại toàn bộ. Kho càng lớn, càng nhiều nội dung không liên quan chiếm token đầu vào và chỗ trong context.

s07 đã chỉ một pattern đọc tốt hơn: giữ một index ngắn luôn sẵn và chỉ nạp nội dung đầy đủ khi cần. Skills do người viết và chỉ đọc. Memory cho phép Agent trích thông tin từ hội thoại và tái sử dụng ở công việc sau.

Vì thế chương này cần bốn phần: storage, recall, extraction, và consolidation.

![Memory Subsystems](images/memory-subsystems.en.svg)

---

## Storage: Mỗi bản ghi một file

Mỗi memory là một file Markdown trong `.memory/`. YAML frontmatter lưu `name`, `description`, và `type`:

```markdown
---
name: user-preference-tabs
description: User prefers tabs for indentation
type: user
---

User prefers using tabs, not spaces, for indentation.
```

Có bốn type của memory:

| Type | Nội dung lưu | Ví dụ |
|------|----------------|---------|
| user | Preference bền vững của người dùng | "Use tabs for indentation" |
| feedback | Hướng dẫn vẫn còn hữu ích | "Do not mock the database" |
| project | Sự kiện ổn định của project | "The authentication rewrite is compliance-driven" |
| reference | Con trỏ bên ngoài hoặc manh mối tra cứu | "The pipeline issue is tracked in Linear INGEST" |

`MEMORY.md` là index, mỗi dòng một file memory. Sau khi ghi, `rebuild_memory_index()` tái tạo index từ các file:

```python
def write_memory_file(name, mem_type, description, body):
    path = MEMORY_DIR / f"{memory_slug(name)}.md"
    path.write_text(
        memory_document(name, mem_type, description, body), encoding="utf-8"
    )
    rebuild_memory_index()
    return path
```

Index phục vụ việc chọn; nội dung đầy đủ nằm trong từng file riêng.

---

## Recall: Chọn trước, rồi mới nạp bản ghi đầy đủ

Khi bắt đầu một request của người dùng, `select_relevant_memories()` gửi đoạn text gần nhất của người dùng cùng catalog memory tới một lần gọi mô hình nhẹ. Nó chọn tối đa năm bản ghi liên quan:

```python
prompt = (
    "Select memory records that are relevant to the current user request. "
    "Return only a JSON array of catalog indices, such as [0, 2]. "
    "Return [] when none are relevant."
)
```

Nếu gọi mô hình hoặc parse JSON thất bại, code fallback sang khớp keyword. Chỉ sau khi chọn, `load_memories()` mới đọc các file tương ứng, với giới hạn tổng lượng text được recall.

```python
relevant_memories = load_memories(messages)
system = build_system(relevant_memories)
```

`build_system()` nêu rõ nội dung được recall là kiến thức nền, không phải lệnh mới của người dùng. Request hiện tại thắng khi xung đột với memory. Nhờ đó Agent dùng được thông tin cũ mà không để bản ghi cũ ra lệnh thay người dùng.

---

## Extraction: Lưu thông tin tái sử dụng sau lượt

Người dùng không phải lúc nào cũng nói "remember this." Sau khi Agent xong response hiện tại, `extract_memories()` xem hội thoại và chỉ giữ thông tin có khả năng giúp sau này:

```python
tool_calls = [
    block for block in response.content if block.type == "tool_use"
]
if not tool_calls:
    force = trigger_hooks("Stop", messages)
    if force:
        messages.append({"role": "user", "content": force})
        continue
    if extract_memories(messages):
        consolidate_memories()
    return
```

Mô hình trả về candidate, không phải bản ghi tự động được phép ghi đĩa. Mỗi candidate mang một `scope`: chỉ `persistent` nghĩa là thông tin nên sống sang phiên sau. `current_task` bao gồm lệnh một lần, path tạm, và hạn chế tạm thời.

`should_store_memory()` thực hiện kiểm tra chấp nhận cuối. Nó từ chối candidate incomplete, cụm từ chỉ phiên hoặc task hiện tại, và bản ghi trùng với cái đã có. Ví dụ, "do not create files in this session" ràng buộc công việc hiện tại; nó không được còn hiệu lực ở phiên sau.

---

## Consolidation: Gộp bản ghi trùng và lỗi thời

Khi file memory tích lũy, một số trở thành trùng, mâu thuẫn, hoặc lỗi thời. Bản triển khai dạy gọi `consolidate_memories()` sau khi kho đạt mười bản ghi và hỏi mô hình một danh sách đã làm sạch.

Code parse và validate danh sách mới trước khi thay file cũ. Nó snapshot các bản ghi hiện tại trước; nếu xóa hoặc ghi thất bại, nó khôi phục bản gốc và rebuild index:

```python
snapshot = {
    path.name: path.read_text(encoding="utf-8")
    for path in MEMORY_DIR.glob("*.md")
    if path.name != MEMORY_INDEX.name
}

try:
    for path in MEMORY_DIR.glob("*.md"):
        if path.name != MEMORY_INDEX.name:
            path.unlink()
    for record in consolidated:
        path = MEMORY_DIR / f"{memory_slug(record['name'])}.md"
        path.write_text(memory_document(
            record["name"], record["type"],
            record["description"], record["body"],
        ), encoding="utf-8")
    rebuild_memory_index()
except Exception:
    for path in MEMORY_DIR.glob("*.md"):
        if path.name != MEMORY_INDEX.name:
            path.unlink()
    for filename, content in snapshot.items():
        (MEMORY_DIR / filename).write_text(content, encoding="utf-8")
    rebuild_memory_index()
    raise
```

Khóa học dùng ngưỡng đếm đơn giản. Ứng dụng thật còn phải chọn lịch phù hợp với khối lượng dữ liệu và ngăn các process đồng thời rewrite cùng một kho.

---

## Code của bài này

| Phần | Triển khai |
|------|----------------|
| Agent Loop | Giữ messages, tool call, tool result, và điểm trigger hook |
| Base tools | `bash`, `read_file`, `write_file`, `edit_file`, `glob` |
| Storage | Index `.memory/MEMORY.md` + bản ghi `.memory/*.md` |
| Recall | Chọn từ catalog + fallback keyword + giới hạn kích thước body |
| Writing | Extraction cuối lượt + kiểm tra persistence + lọc trùng |
| Consolidation | Gộp khi đạt ngưỡng; khôi phục file cũ nếu thay thế thất bại |

> **Ranh giới với s08:** s08 quản lý ngân sách context của phiên đang chạy. s09 quản lý kiến thức tái sử dụng bên ngoài hội thoại. Memory là lưu trữ có chọn lọc, không phải backup transcript không mất mát, và không thay thế context compaction.

---

## Thử chạy

```sh
cd learn-claude-code
python s09_memory/code.py
```

1. Nhập `I prefer using tabs for indentation. Remember that.` Sau lượt, kiểm tra `.memory/` có bản ghi mới và `MEMORY.md` có mục index tương ứng.
2. Nhập `q`, khởi động lại chương trình, rồi hỏi `What indentation style do I prefer?` Xác nhận phiên mới recall được preference.
3. Lưu một preference khác không liên quan đến định dạng code, rồi hỏi về indentation. Quan sát request hiện tại chỉ nạp bản ghi liên quan.
4. Nhập `Do not create files in this session.` Xác nhận yêu cầu tạm này không trở thành rule bền vững cho phiên sau.

Cách diễn đạt chính xác và số lần extraction có thể khác theo mô hình. Kiểm tra những gì được ghi vào `.memory/` và phiên sau có chỉ recall thông tin liên quan hay không.

---

## Tiếp theo

Memory giữ thông tin xuyên phiên, nhưng task phức tạp còn cần trạng thái bền vững và theo dõi dependency. TODO chỉ nằm trong hội thoại không thể mang tiến độ qua lần restart process.

s10 Task System → Persist task, status, và dependency xuống đĩa.

<!-- translation-sync: zh@v3, en@v3, ja@v3, vi@v3 -->
