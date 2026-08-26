# s15: Integrated Harness — Nhiều cơ chế, một vòng lặp

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → ... → s13 → [s14](../s14_mcp_plugin/) → `s15` → [s16](../s16_workflow_runtime/) → s17

> *"Many mechanisms, one loop"* — tools, quyền, memory, tasks, teams, và plugin đều treo trên cùng một `while True`.
>
> **Tầng Harness**: Tích hợp — đưa các cơ chế mà ví dụ này dùng vào một hệ thống chạy được.

---

## Vấn đề

Các chương trước giữ từng cơ chế riêng trong từng ví dụ chạy độc lập. Chương này nối các cơ chế mà runtime tích hợp cần.

Một coding Agent chạy dài cần tất cả những thứ này cùng lúc:

- phân phối tool và ranh giới quyền
- điểm mở rộng hook
- kế hoạch todo và đồ thị task
- skills, memory, và lắp system prompt lúc runtime
- compaction và phục hồi lỗi
- background tasks và cron scheduling
- teams, protocol, và IDLE task claiming
- worktree gắn với task
- tích hợp MCP tool bên ngoài

S15 không giới thiệu thêm một cơ chế cô lập. Nó cho thấy các cơ chế sẵn có đi vào vòng lặp mô hình ở đâu, và sự kiện của chúng quay lại cùng một cuộc hội thoại như thế nào.

---

## Giải pháp

![System Architecture](images/system-architecture.en.svg)

S15 không giới thiệu cơ chế mới. Nó nối các thành phần từ các chương trước trong một Harness tích hợp:

```text
user input
  → UserPromptSubmit hooks
  → cron/background notification injection
  → context compact
  → memory + skills + MCP state assemble the system prompt
  → LLM
  → has tool_use block?
      no  → Stop hooks → return
      yes → PreToolUse hooks + permission
          → TOOL_HANDLERS / MCP handlers / background dispatch
          → PostToolUse hooks
          → tool_result / task_notification back to messages
          → next round
```

Vòng lặp giữ cùng cấu trúc: gọi mô hình, kiểm tra response có block `tool_use` không, thực thi tool, rồi append kết quả vào `messages`. Có hay không block `tool_use` quyết định việc thực thi tool có tiếp tục.

---

## Vị trí từng thành phần

| Vị trí | Thành phần | Vai trò |
|----------|-----------|------|
| Xung quanh input người dùng | `UserPromptSubmit` hooks | Ghi log, inject, hoặc audit input người dùng |
| Trước LLM | cron queue | Inject prompt đã lên lịch vào `messages` |
| Trước LLM | background notifications | Inject công việc nền đã xong dưới dạng `<task_notification>` |
| Trước LLM | compaction pipeline | Cắt output lớn theo budget, tỉa lịch sử, compact tool result cũ, tóm tắt khi cần |
| Trước LLM | memory / skills / MCP state | Lắp system prompt để mô hình thấy khả năng hiện tại và ngữ cảnh dài hạn |
| Lần gọi LLM | error recovery | Retry 429/529, tăng `max_tokens`, compact khi prompt-too-long |
| Trước khi thực thi tool | `PreToolUse` hooks + permission | Chặn lệnh nguy hiểm, ghi ngoài phạm vi, MCP tool phá hủy |
| Phân phối tool | `assemble_tool_pool` | Lắp tool built-in và MCP tool động |
| Trong lúc thực thi tool | background dispatch | Đưa bash được đánh dấu rõ vào daemon thread và trả kết quả placeholder |
| Sau khi thực thi tool | `PostToolUse` hooks | Cảnh báo output lớn, log, hậu xử lý |
| Quay lại vòng lặp | tool_result | Một `tool_result` cho mỗi `tool_use`, rồi vòng mô hình tiếp theo |
| Không có tool_use vòng này / khi dừng | `Stop` hooks | Thống kê, dọn dẹp, audit |

---

## code.py chứa gì

### Tools và Dispatch

Tool pool built-in gồm 26 tool:

```text
bash, read_file, write_file, edit_file, glob
todo_write, task, load_skill, compact
create_task, update_task, list_tasks, get_task, claim_task, complete_task
schedule_cron, list_crons, cancel_cron
spawn_teammate, list_teammates, send_message
request_shutdown, request_plan, review_plan
create_worktree
connect_mcp
```

`assemble_tool_pool()` lắp chúng mỗi vòng:

```text
BUILTIN_TOOLS + connected MCP tools
BUILTIN_HANDLERS + mcp__server__tool handlers
```

Sau `connect_mcp("docs")`, vòng tiếp theo expose các tool như `mcp__docs__search`.

### Quyền và Hooks

Quyền không được hardcode vào dòng thực thi tool. Nó là một hook `PreToolUse`:

```python
blocked = trigger_hooks("PreToolUse", block)
if blocked:
    results.append(tool_result(block.id, blocked))
    continue
```

Nghĩa là logic quyền, logging, và audit đều gắn vào cùng một điểm hook. Tool của Lead, tool subagent one-shot, và tool teammate đều đi qua `PreToolUse`; cuộc gọi được phép rồi chạy `PostToolUse` sau handler.

Policy không tin description của chính MCP server như ủy quyền. Host sở hữu một allowlist nhỏ, khớp chính xác, cho các lời gọi read-only đã biết; mọi MCP tool khác hỏi người dùng. File tool bị từ chối ngoài `WORKDIR`, và mọi lệnh bash hỏi trước khi thực thi. Chỉ lượt người dùng foreground mới được mở prompt phê duyệt tương tác; các lượt bất đồng bộ fail closed thay vì tranh stdin với CLI chính.

### Planning và Tasks

S15 giữ hai tầng planning:

- `todo_write`: kế hoạch nhẹ cho session hiện tại, giữ trong memory
- task graph: file task xuyên session, có dependency, có thể claim, nằm dưới `.tasks/task_*.json`

Cái thứ nhất giữ một Agent không bị trôi. Cái thứ hai hỗ trợ phối hợp team.

Chúng chia sẻ ý định, không chia sẻ implementation: `todo_write` thay một checklist trong session, trong khi bản ghi task có ID ổn định và cập nhật vòng đời riêng. Tool `task` riêng bên dưới nghĩa là "dispatch một subagent cô lập"; nó không phải Task System.

Việc dựng task graph trong host tích hợp vẫn hai pha: Lead tạo tất cả node task trước, rồi gọi `update_task` với runtime ID mà `create_task` trả về. Teammate chỉ nhận thao tác list, claim, và complete, nên cấu trúc dependency được Lead cố định trước khi phân việc.

### Subagent và Teams

S15 có hai kiểu ủy thác:

- `task`: subagent one-shot. Nó dùng `messages[]` cô lập, bỏ ngữ cảnh trung gian, và chỉ trả summary cuối.
- `spawn_teammate`: thread teammate bền. Khi được một `task_id` sẵn sàng, runtime claim nó trước khi thread bắt đầu; không có thì teammate có thể chờ ở IDLE cho việc sau. Teammate chưa được gán việc không dùng được file hay Shell tool. Nó theo `WORK → result → IDLE` mà không có trần số vòng tool cố định; lỗi mô hình hoặc dispatch phát `error`, và dọn thread trả assignment chưa xong về task board. Nó rút inbox trước mỗi lần gọi mô hình, nên tin nhắn trực tiếp và yêu cầu shutdown không phải chờ sau một chuỗi tool-use không ngắt. Khi idle nó chờ delivery của `MessageBus` trước, rồi mới quét task sẵn sàng sau khi hết thời gian chờ, và atomically claim tối đa một task.

Sau khi spawn teammate, Lead kết thúc lượt hiện tại thay vì liên tục hỏi status bên trong vòng lặp mô hình. Một team event trong mailbox của Lead khiến runtime bắt đầu lượt tiếp theo.

Subagent one-shot giải quyết cô lập ngữ cảnh. Teammate bền giải quyết cộng tác song song chạy dài.

### Memory, Skills, và Prompt

S15 tái sử dụng trực tiếp memory runtime của s09. Trước mỗi lần gọi mô hình, nó đọc catalog `.memory/MEMORY.md`, chọn bản ghi liên quan tới yêu cầu hiện tại, rồi đưa nội dung của chúng vào `assemble_system_prompt(context)`. Cuối lượt, `extract_memories()` giữ thông tin có thể giúp session sau; khi có bản ghi mới được lưu, `consolidate_memories()` chạy tiếp.

Cùng system prompt đó còn gồm identity, hướng dẫn tool, workspace, catalog skills, và MCP server đã kết nối. Skills chỉ đóng góp catalog; `load_skill(name)` tải nội dung đầy đủ khi cần.

### Compaction và Recovery

Trước lần gọi LLM, S15 chạy compaction pipeline:

```text
tool_result_budget → snip_compact → micro_compact → compact_history
```

`snip_compact` lưu trữ toàn bộ lịch sử trước khi tỉa phần giữa. `micro_compact` chỉ chạy khi vượt giới hạn ngữ cảnh: nó lưu các result cũ đã dùng trước khi thay bằng đường phục hồi, giữ 3 cái mới nhất đầy đủ, và dừng gần 80% giới hạn. Nếu một result mới chưa thấy mà bản thân đã quá lớn, S15 giữ preview và đường full-output trước khi cân nhắc tóm tắt lịch sử.

Lần gọi mô hình được bọc recovery:

- 429: retry backoff mũ
- 529: backoff mũ, tùy chọn chuyển mô hình fallback sau nhiều lần thất bại
- `max_tokens`: tăng max tokens, rồi yêu cầu continuation
- prompt too long: compact phản ứng rồi retry

### Background và Cron

Khi một lời gọi bash đặt `run_in_background=true`, vòng lặp chính trả placeholder mà không chờ lệnh:

```text
should_run_background → start_background_task → placeholder tool_result
background done → task_notification → next round injects messages
```

Chỉ lời gọi bash được đánh dấu rõ mới vào đường background. Exit khác 0 hoặc exception của worker tạo notification `failed`. Mỗi shell chạy trong process group riêng, runtime dừng group đó khi lệnh hoặc process Agent kết thúc theo đường bình thường hoặc `SIGTERM`. Process tạo session khác có thể rời group đó.

Cron scheduler chạy như daemon thread và kiểm tra mỗi giây một lần. Job one-shot bền được persist thành `pending_delivery` trước khi vào queue và ở đó cho đến khi lần gọi mô hình chứa prompt của nó thành công; lần gọi thất bại trả nó về queue, và restart xếp nó lại. Delivery vì thế là at-least-once. CLI theo dõi `cron_queue`, inbox của Lead, và công việc nền trên terminal; bất kỳ cái nào cũng có thể đánh thức một lượt Agent tự động.

### Worktree và MCP

Hành vi worktree theo task kế thừa từ s13 quản lý thư mục làm việc:

- một task pending, chưa có chủ có thể ở lại workspace chính hoặc được `create_worktree(name, task_id)` gắn với một nhánh và thư mục riêng
- lúc tạo, prevalidate task, tên, path, nhánh, và Git registry; lệnh Git thất bại được đối chiếu với registry và trạng thái nhánh, và mọi checkout dở vẫn không bị bind, được giữ lại để phục hồi thủ công
- teammate idle atomically claim một task sẵn sàng; assignment ghi cả `task_id` lẫn `cwd` hiệu lực
- Lead cũng có thể truyền `task_id` sẵn sàng cho `spawn_teammate`; thread chỉ bắt đầu sau khi claim thành công
- mọi file tool của teammate dùng `cwd` đó; chỉ teammate sở hữu mới complete được task, và assignment được chọn cho đến khi lượt mô hình đó kết thúc
- gỡ bỏ nằm ở helper phía host `remove_worktree()`. Mô hình không gọi được. Người dùng hoặc host trước hết kiểm tra quyền sở hữu task, lease assignment, công việc nền, và trạng thái Git; gỡ phá hủy cần xác nhận người dùng riêng

Worktree đổi thư mục mặc định của tool. Nó tách bản làm việc; không phải sandbox, và dọn process-group không chứa process đã mở session khác. Đó là lý do xóa vẫn thuộc host.

Claim hoặc release một Task đổi version assignment và vô hiệu phê duyệt plan cũ. `send_message` thông thường chỉ giao text; nó không đổi identity của Task hay trạng thái plan.

MCP sở hữu khả năng bên ngoài:

- `connect_mcp(name)` kết nối một mock server
- `assemble_tool_pool()` lắp MCP tool và từ chối va chạm tên đã chuẩn hóa
- tên tool dùng `mcp__server__tool`

---

## Thay đổi so với s14

| Phạm vi | s14 MCP | s15 Integrated Harness |
|-------|---------|-------------------------|
| tool built-in | 6 | 25 |
| tool bên ngoài | MCP tool đã kết nối | cùng đường MCP động và host policy |
| cơ chế local | tool S04, hooks, permission, MCP | todo, subagent, skills, compaction, memory, task graph, background bash, cron, teams, và worktree |
| nguồn sự kiện | input người dùng và tool result | input người dùng, tool result, cron prompt, background notification, và team event |

---

## Thử chạy

```sh
cd learn-claude-code
python s15_integrated_harness/code.py
```

Thử:

1. `Inspect this repository and tell me which Python files matter most.`
2. `Search the connected documentation for agent loop guidance.`
3. `Refactor the authentication module and login page in parallel in separate worktrees. Show me each plan before editing.`
4. `Remind me about the meeting in 3 minutes.`
5. `Install the dependencies in the background while you read README.md.`

Quan sát:

- mỗi lời gọi tool có đi qua hooks/permission không
- MCP tool có xuất hiện ở vòng tiếp theo sau `connect_mcp` không
- lời gọi bash với `run_in_background=true` có trả placeholder background không
- cron có tự nhắc khi đến giờ không
- teammate có nộp plan và dừng trước khi được phê duyệt không
- teammate idle có atomically claim đúng một task sẵn sàng không
- mọi file tool của teammate có chuyển sang `cwd` của task đã claim không
- complete có giữ `cwd` của task suốt phần còn lại của lượt rồi nhả lúc IDLE không

---

## Tiếp theo

[s16 Workflow Runtime](../s16_workflow_runtime/) thêm tool `Workflow` vào host này. Một Workflow giữ đường điều phối cố định trong code và ghi tiến độ để cùng một lần chạy có thể resume.

<!-- translation-sync: zh@v14, en@v14, ja@v14, vi@v14 -->
