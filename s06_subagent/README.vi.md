# s06: Subagent — Cho subtask một context riêng

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → s02 → s03 → s04 → s05 → `s06` → [s07](../s07_skill_loading/) → s08 → ... → s16 → s17

> Subagent bắt đầu với `messages[]` mới. Text cuối cùng trả về parent; hội thoại trung gian thì không.
>
> **Tầng Harness**: Delegation — Chạy một task tập trung trong context hội thoại tách riêng.

---

## Vấn đề

Agent đang sửa bug. Nó đọc nhiều file để lần chuỗi gọi, và mọi lần gọi tool cùng kết quả đều nằm lại trong `messages[]` của parent. Khi đã hiểu chuỗi gọi, phần lớn chi tiết trung gian không còn cần, nhưng chúng vẫn chiếm context.

---

## Giải pháp

![Subagent Overview](images/subagent-overview.en.svg)

Gọi `task` chạy đồng bộ một vòng lặp Agent lồng nhau với `messages[]` mới. Khi vòng đó xong, text cuối cùng trở thành tool result trong hội thoại parent.

Đây là cô lập tin nhắn, không phải cô lập process hay filesystem. Parent và subagent chạy trong cùng process Python và chia sẻ `WORKDIR`, nên ghi file và lệnh vẫn ảnh hưởng cùng workspace. Subagent có năm tool cơ bản nhưng không có `task`, và các lần gọi tool dùng cùng permission và lifecycle Hook như parent.

---

## Cách hoạt động

**run_subagent** tạo list tin nhắn mới, chạy vòng lặp lồng, và trả về text cuối:

```python
SUB_TOOLS = list(BASE_TOOLS)  # no task tool

def run_subagent(prompt: str) -> str:
    messages = [{"role": "user", "content": prompt}]

    for _ in range(30):
        response = client.messages.create(
            model=MODEL, system=SUB_SYSTEM,
            messages=messages, tools=SUB_TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})
        tool_calls = [
            block for block in response.content if block.type == "tool_use"
        ]
        if not tool_calls:
            return extract_text(response.content) or "(no summary)"

        results = []
        for block in tool_calls:
            output = execute_tool(block, SUB_HANDLERS)
            results.append({... "content": output})
        messages.append({"role": "user", "content": results})

    return "Subagent stopped after 30 turns without a final answer."
```

Agent chính gọi nó như bất kỳ tool nào khác:

```python
TASK_TOOL = {
    "name": "task",
    "description": "Run a subagent with fresh conversation context and return its final text.",
    "input_schema": {
        "type": "object",
        "properties": {"prompt": {"type": "string"}},
        "required": ["prompt"],
    },
}

TOOLS = [*BASE_TOOLS, TASK_TOOL]
TOOL_HANDLERS = {**BASE_HANDLERS, "task": run_subagent}
```

Ranh giới là:

| Quyết định | Lựa chọn | Lý do |
|----------|--------|--------|
| Hội thoại | `messages[]` mới | Lịch sử parent không được copy vào subagent |
| Thực thi | Cùng process và `WORKDIR` | Thay đổi filesystem vẫn thấy được ở cả hai vòng lặp |
| Giá trị trả về | Chỉ text cuối | Lần gọi tool và kết quả của con không được copy vào tin nhắn parent |
| Độ sâu ủy thác | Không có `task` trong `SUB_TOOLS` | Bài này cho phép một cấp ủy thác |
| Chính sách tool | Hook dùng chung | Parent và subagent dùng cùng kiểm tra permission |

Parent dispatch `task` qua cùng map handler như các tool khác. Subagent dùng `SUB_SYSTEM`, `SUB_TOOLS`, và list `messages` local riêng.

---

## Thử chạy

```sh
cd learn-claude-code
python s06_subagent/code.py
```

Thử các prompt sau:

1. `Use a subtask to find what testing framework this project uses` (sub-Agent đọc file, Agent chính chỉ nhận kết luận)
2. `Delegate: read all .py files in agents/ and summarize what each one does`
3. `Use a task to create s06_subagent/example/string_tools.py with a slugify(text: str) function, then verify it from the parent agent`

Điều cần quan sát: `[Subagent started]` / `[Subagent done]` có hiện không? Lần gọi tool của subagent có in thành `[sub] ...` không? Parent có tiếp tục chỉ với text cuối mà `task` trả về không?

---

## Tiếp theo

Agent tách task được rồi. Nhưng task khác nhau cần kiến thức khác nhau: sửa component frontend cần quy ước React, viết SQL cần schema bảng. Nhồi hết kiến thức đó vào system prompt sẽ làm context nổ.

→ s07 Skill Loading: Tiêm Skill theo nhu cầu thay vì chất tài liệu vào system prompt. Chỉ load khi cần, tự nhiên như đọc một file.


<!-- translation-sync: zh@v2, en@v2, ja@v2, vi@v2 -->
