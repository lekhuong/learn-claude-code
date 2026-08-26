# s08: Context Compact: Dọn chỗ trước khi context đầy

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → s02 → s03 → s04 → s05 → s06 → s07 → `s08` → [s09](../s09_memory/) → s10 → ... → s16 → s17

> *"Context will fill up, so the Harness needs a way to make room."* Bốn bước chạy từ chi phí thấp đến chi phí cao.
>
> **Tầng Harness**: Compaction giữ context hữu hạn vẫn dùng được xuyên suốt một task dài.


Agent làm việc, mỗi lần đọc file, kết quả lệnh, và response của mô hình đều nằm lại trong `messages`. Lịch sử cuối cùng vượt quá context window của mô hình.

Bài này thêm một pipeline compaction bốn bước. Trước hết giảm output tool có thể khôi phục, chỉ tóm tắt lịch sử khi những bước giảm đó vẫn chưa đủ.

![Context Compact overview](images/compact-overview.en.svg)


## Hiểu context

Hãy nghĩ context window như scratchpad hiện tại của mô hình. Tin nhắn user, response của mô hình, các block `tool_use` và `tool_result` được ghi lên đó theo thứ tự. Mô hình đọc lại toàn bộ mỗi khi tiếp tục task.

Scratchpad có kích thước cố định. Khi request vượt quá, API từ chối với `prompt_too_long`. Kết quả tool thường chiếm phần lớn không gian trong các task coding:

- Đọc một file dài đưa toàn bộ nội dung vào context.
- Log test và build có thể thêm hàng chục kilobyte một lần.
- Tìm kiếm nhiều file cứ append thêm kết quả.

Task càng kéo dài, `messages` càng phình. Compaction kiểm soát sự phình đó, đồng thời giữ mục tiêu hiện tại, ràng buộc của user, và công việc đang làm.


## Vì sao kết quả tool được xử lý trước

Tóm tắt cả lịch sử có thể thu nhỏ nhanh, nhưng mỗi bản tóm tắt mất một ít chi tiết và tốn thêm một lần gọi mô hình.

Kết quả tool là mục tiêu đầu tiên hợp lý hơn:

1. Kết quả file lớn có thể lưu ra đĩa rồi đọc lại sau.
2. Lệnh cũ có thể chạy lại.
3. Kết quả mới nhất thường liên quan hơn tới bước hiện tại.
4. Cắt text và chỉnh cấu trúc không gọi mô hình.

Pipeline vì thế đi theo mức mất thông tin và chi phí tăng dần: persist, trim, thay kết quả cũ, và summarize cuối cùng.

![Four-step compaction pipeline](images/compaction-layers.en.svg)


## Bước 1: tool_result_budget

Một response của mô hình có thể yêu cầu vài tool cùng lúc. Các block `tool_result` đã xong được ghi chung vào tin nhắn user cuối. Khi tổng nội dung vượt `200_000` ký tự, `tool_result_budget` xử lý kết quả lớn nhất trước.

Mỗi kết quả trên `LARGE_RESULT_CHAR_LIMIT = 30000` được ghi đầy đủ vào:

```text
.task_outputs/tool-results/<tool_use_id>.txt
```

Context giữ đường dẫn file và preview 2.000 ký tự:

![Persisting large results](images/layer1-budget.en.svg)

Vòng lõi persist kết quả theo thứ tự kích thước giảm dần:

```python
blocks = [block for block in content
          if isinstance(block, dict)
          and block.get("type") == "tool_result"]
total = sum(len(str(block.get("content", ""))) for block in blocks)

ranked = sorted(
    blocks,
    key=lambda block: len(str(block.get("content", ""))),
    reverse=True,
)
for block in ranked:
    if total <= max_chars:
        break
    content = str(block.get("content", ""))
    if len(content) <= self.LARGE_RESULT_CHAR_LIMIT:
        continue
    block["content"] = self.persist_large_output(
        block.get("tool_use_id", "unknown"), content)
    total = sum(len(str(item.get("content", ""))) for item in blocks)
```

Bước này chỉ xét batch kết quả tool mới nhất. Output đầy đủ vẫn có ở đường dẫn đã lưu, nên persist là thao tác an toàn nhất để chạy trước.


## Bước 2: snip_compact

Khi lịch sử vượt 50 tin nhắn, `snip_compact` ghi toàn bộ lịch sử vào `.transcripts/`, rồi giữ 3 tin nhắn đầu và 46 tin nhắn mới nhất. Marker archive chiếm slot còn lại, ghi số tin nhắn đã bỏ, và trỏ tới transcript đầy đủ.

```python
head_end = 3
tail_start = len(messages) - (max_messages - head_end - 1)

if self.has_tool_use(messages[head_end - 1]):
    while (head_end < tail_start
           and self.is_tool_result(messages[head_end])):
        head_end += 1

if (tail_start > 0
        and self.is_tool_result(messages[tail_start])
        and self.has_tool_use(messages[tail_start - 1])):
    tail_start -= 1

transcript = self.write_transcript(messages)
marker = {"role": "user", "content":
          f"[{tail_start - head_end} messages archived at {transcript}]"}
messages = [*messages[:head_end], marker, *messages[tail_start:]]
```

Điểm cắt bảo vệ mọi cặp `assistant(tool_use)` và `user(tool_result)`. Một result mồ côi không có tool call khớp, nên request API tiếp theo sẽ không hợp lệ.

Bước này kiểm soát số tin nhắn. Kết quả tool trong các tin nhắn được giữ lại vẫn có thể dài.


## Bước 3: micro_compact

Sau hai bước đầu, `prepare` ước lượng kích thước context còn lại và chỉ chạy `micro_compact` khi vượt `CONTEXT_CHAR_LIMIT`. Trong các kết quả mô hình đã consume, `micro_compact` giữ 3 cái mới nhất và rút gọn kết quả cũ hơn dài hơn 120 ký tự cho đến khi context gần 80% giới hạn. Trước khi thay một kết quả cũ, nó ghi nội dung đầy đủ ra đĩa, nên mọi lần thay đều còn đường khôi phục:

![Replacing old results with recovery paths](images/micro-compact.en.svg)

```python
unseen = self.unseen_tool_result_positions(messages)
consumed = [entry for entry in results if entry[:2] not in unseen]

for _, _, block in consumed[:-self.KEEP_RECENT_RESULTS]:
    if self.estimate_chars(messages) <= target_chars:
        break
    content = str(block.get("content", ""))
    if len(content) <= 120:
        continue
    saved_path = self.persisted_output_path(content)
    if not saved_path:
        saved_path = self.save_output(block["tool_use_id"], content)
    block["content"] = f"[Earlier tool result saved at {saved_path}]"
```

Kết quả mới thường giữ nguyên cho đến khi mô hình consume chúng. Nếu một batch chưa thấy đã quá lớn so với context, `fit_tool_results` persist các kết quả lớn nhất và giữ preview 1.000 ký tự cộng đường dẫn output đầy đủ. Cách này tránh tóm tắt cả lịch sử trước khi mô hình kịp xem kết quả mới.

Hai bước đầu chạy mỗi vòng. Bước 3 chỉ chạy khi context vượt giới hạn. Cả ba đều là thao tác text và cấu trúc xác định, có thể khôi phục; chúng không thêm lần gọi API.


## Bước 4: compact_history

Sau `micro_compact` và `fit_tool_results`, code ước lượng lại context bằng `estimate_chars(messages)`:

```python
CONTEXT_CHAR_LIMIT = 50000

def estimate_chars(messages):
    return len(json.dumps(messages, default=str, ensure_ascii=False))
```

Khi số đếm vẫn vượt `CONTEXT_CHAR_LIMIT`, `compact_history` làm bốn việc:

1. Ghi toàn bộ lịch sử tin nhắn vào `.transcripts/`.
2. Nhờ mô hình tóm tắt trạng thái mang tính sự kiện.
3. Giữ request bắt được ở biên input tách khỏi bản tóm tắt đó.
4. Thay lịch sử đang dùng bằng một tin nhắn `[Compacted]`.

![History summary](images/auto-compact.en.svg)

```python
def compact_history(messages, active_request):
    transcript = self.write_transcript(messages)
    print(f"[transcript saved: {transcript}]")
    summary = self.summarize_history(messages)
    return [self.summary_message(
        "Compacted", active_request, summary, transcript)]
```

Lần gọi tóm tắt nhờ mô hình ghi lại mục tiêu, file, quyết định, việc còn lại, và ràng buộc của user, không thực thi hướng dẫn từ lịch sử. CLI truyền `active_request` vào Agent Loop vì kết quả tool cũng dùng `role=user`. Tin nhắn đã compact lưu nó dưới `Current user request`, đặt tóm tắt dưới `Conversation summary`, và kèm đường dẫn transcript đầy đủ.

Bài này dùng số ký tự làm trigger, và mọi ngưỡng liên quan dùng cùng đơn vị.


## Vì sao thứ tự bị cố định

Pipeline dùng thứ tự này và chỉ vào bước tóm tắt mất thông tin khi thật sự cần:

```python
messages = self.tool_result_budget(messages)
messages = self.snip_compact(messages)
if self.estimate_chars(messages) > self.CONTEXT_CHAR_LIMIT:
    target = int(self.CONTEXT_CHAR_LIMIT * 0.8)
    messages = self.micro_compact(messages, target)
    if self.estimate_chars(messages) > self.CONTEXT_CHAR_LIMIT:
        messages = self.fit_tool_results(messages, target)
    if self.estimate_chars(messages) > self.CONTEXT_CHAR_LIMIT:
        messages = self.compact_history(messages, active_request)
```

Thứ tự này thỏa hai ràng buộc:

1. Bước 1 và 2 chạy mỗi vòng. Bước 3 chỉ chạy khi vượt giới hạn, và chỉ Bước 4 thêm một request API.
2. Mọi kết quả tool bị rút gọn đều giữ một đường dẫn tin cậy trong `.task_outputs/tool-results/`; chỉ overflow còn lại mới tới tóm tắt lịch sử do mô hình sinh.

Mỗi vòng vì thế bắt đầu bằng thao tác chi phí thấp nhất, thông tin dễ khôi phục nhất.


## Khôi phục khi API từ chối

Số ký tự chỉ ước lượng token mà mô hình dùng. API vẫn có thể trả `prompt_too_long`. `reactive_compact` lưu transcript, tóm tắt lịch sử cũ hơn, và giữ 5 tin nhắn mới nhất:

```python
tail_start = max(0, len(messages) - self.KEEP_RECENT_MESSAGES)
if (tail_start > 0
        and self.is_tool_result(messages[tail_start])
        and self.has_tool_use(messages[tail_start - 1])):
    tail_start -= 1

old_history = messages[:tail_start] if tail_start else messages
summary = self.summarize_history(old_history)
message = self.summary_message(
    "Reactive compact", active_request, summary, transcript)
messages = [message, *messages[tail_start:]] if tail_start else [message]
```

Điểm cắt cũng tránh tách một lần gọi tool khỏi kết quả của nó, trong khi `active_request` mang request hiện tại của user một cách tường minh. `MAX_REACTIVE_RETRIES = 1` cho phép một lần khôi phục. Lỗi độ dài context lần hai được raise lên caller.


## Đưa vào Agent Loop

```python
def agent_loop(messages, active_request):
    while True:
        messages[:] = COMPACTOR.prepare(messages, active_request)

        try:
            response = client.messages.create(
                model=MODEL, system=SYSTEM, messages=messages,
                tools=TOOLS, max_tokens=8000)
            reactive_retries = 0
        except Exception as error:
            message = str(error).lower()
            too_long = ("prompt_too_long" in message
                        or "too many tokens" in message)
            if too_long and reactive_retries < MAX_REACTIVE_RETRIES:
                messages[:] = COMPACTOR.reactive_compact(
                    messages, active_request)
                reactive_retries += 1
                continue
            raise
```

Mọi lần gọi mô hình đều vào cùng pipeline. Sau khi append `query`, CLI gọi `agent_loop(history, query)`, nên compaction lặp lại không thể làm mất request hiện tại. Code chỉ xin tóm tắt khi `micro_compact` vẫn để context trên giới hạn, hoặc khi API từ chối.


## Tool compact

Một ngưỡng tự động chỉ biết context lớn tới đâu. Mô hình cũng có thể gọi `compact` sau khi xong một giai đoạn, khi giai đoạn tiếp chỉ cần bản tóm tắt:

```python
{"name": "compact",
 "description": "Summarize earlier conversation to free context space."}
```

Một response có thể yêu cầu vài tool cùng lúc, ví dụ ghi file rồi compact. Harness thực thi hết batch rồi append một `tool_result` cho mỗi `tool_use`. Nó chỉ tóm tắt sau khi turn đó xong:

```python
tool_calls = [
    block for block in response.content if block.type == "tool_use"
]
results = []
compact_requested = False

for block in tool_calls:
    if block.name == "compact":
        output = "Compaction requested after this tool batch."
        compact_requested = True
    else:
        output = execute_tool(block)
    results.append({"type": "tool_result", "tool_use_id": block.id,
                    "content": output})

messages.append({"role": "user", "content": results})

if compact_requested:
    messages[:] = COMPACTOR.compact_history(messages, active_request)
```

Cách này không để lại tool result mồ côi. Nó cũng giữ lại record của lần ghi file hay side effect khác trước khi compact, nên mô hình không làm lại.


## Bài này thêm gì

| Thành phần | Vòng thực thi dùng chung | Thêm trong s08 |
| --- | --- | --- |
| Agent Loop | Gọi mô hình, chạy tool, append kết quả | Chạy `COMPACTOR.prepare()` trước mỗi lần gọi mô hình |
| Hooks | Kiểm tra permission, log tool, xử lý kết quả | Giữ cùng điểm vào thực thi tool |
| Context | Append vào `messages` | Persist kết quả lớn, archive lịch sử cũ, tóm tắt, và retry một lần sau lỗi độ dài |
| Tools | 5 tool cơ bản | Thêm `compact`, tổng 6 |

> **Ranh giới với s09:** s08 quản lý context hữu hạn của session hiện tại và có thể bỏ chi tiết có thể khôi phục. s09 lưu thông tin phải sống sót qua compaction và các session sau.


## Thử chạy

```bash
cd learn-claude-code
python s08_context_compact/code.py
```

### Thí nghiệm 1: Thay kết quả cũ hơn

```text
Read the README.md files from s01_agent_loop through s05_todo_write.
Compare their top-level headings and summarize the naming pattern.
```

Task này sinh ít nhất 5 kết quả file. Kết quả mới thường giữ nguyên cho đến khi mô hình thấy chúng một lần; kết quả chưa thấy quá cỡ thì giữ preview và đường khôi phục. Ở các turn sau, 3 kết quả đã consume mới nhất vẫn đầy đủ, trong khi kết quả dài cũ hơn thành tham chiếu `[Earlier tool result saved at ...]`.

### Thí nghiệm 2: Persist kết quả lớn

```text
Analyze the structure of web/src/data/generated/docs.json
and explain the main fields in one lesson record.
```

Khi file vượt budget mỗi turn, task vẫn có thể xong và kết quả đầy đủ nằm dưới `.task_outputs/tool-results/`.

### Thí nghiệm 3: Kích hoạt tóm tắt tự động

```text
Compare s08_context_compact/code.py with s09_memory/code.py.
Explain how they manage current context and persistent memory.
```

Khi kết quả file đẩy `estimate_chars(messages)` trên 50000, terminal in `[auto compact]` và đường dẫn transcript. Lần gọi tiếp theo tiếp tục từ tóm tắt `[Compacted]`.

Xem `.transcripts/` và `.task_outputs/tool-results/` để thấy archive lịch sử và output lớn đã persist.


## Tiếp theo

Context compaction để Agent tiếp tục một task dài trong cửa sổ hữu hạn. Thông tin phải sống sót qua compaction và các session sau cần một hệ thống memory bền riêng.

s09 Memory thêm ghi memory, truy xuất, và consolidation.

<!-- translation-sync: zh@v8, en@v8, ja@v8, vi@v8 -->
