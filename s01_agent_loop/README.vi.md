# s01: The Agent Loop — Một vòng lặp là đủ

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

`s01` → [s02](../s02_tool_use/) → s03 → s04 → ... → s16 → s17
> *"One loop & Bash is all you need"* — Một tool + một vòng lặp = một Agent.
>
> **Tầng Harness**: The Loop — cầu nối đầu tiên giữa mô hình và thế giới thật.

---

## Vấn đề

Bạn hỏi mô hình: "Liệt kê file trong thư mục của tôi rồi chạy XXX.py."

Mô hình có thể xuất một lệnh bash, nhưng sau khi xuất xong thì dừng — nó không tự chạy lệnh, cũng không tiếp tục suy luận dựa trên kết quả.

Bạn có thể tự chạy, dán output trở lại chat, rồi để nó tiếp. Lệnh tiếp theo ra, bạn chạy lại, dán lại.

Mỗi vòng đi-về, bạn chính là tầng trung gian. Tự động hóa tầng đó chính là nội dung chương này.

---

## Giải pháp

![Agent Loop](images/agent-loop.en.svg)

Một vòng `while True`: tiếp tục khi mô hình gọi tool, dừng khi không gọi. Vòng lặp kiểm tra trực tiếp các content block trong response:

| Tín hiệu | Ý nghĩa | Hành động của vòng lặp |
|--------|---------|-------------|
| Có block `tool_use` | Mô hình yêu cầu gọi tool | Thực thi → đưa kết quả trở lại → tiếp tục |
| Không có block `tool_use` | Mô hình không gọi tool | Thoát vòng lặp |

---

## Cách hoạt động

Dịch quá trình này thành code. Từng bước:

**Bước 1**: Bắt đầu bằng câu hỏi của người dùng làm tin nhắn đầu tiên.

```python
messages = [{"role": "user", "content": query}]
```

**Bước 2**: Gửi messages và định nghĩa tool tới LLM.

```python
response = client.messages.create(
    model=MODEL, system=SYSTEM, messages=messages,
    tools=TOOLS, max_tokens=8000,
)
```

**Bước 3**: Append response của mô hình rồi kiểm tra xem nó có gọi tool không. Không gọi tool → xong.

```python
messages.append({"role": "assistant", "content": response.content})
tool_calls = [
    block for block in response.content if block.type == "tool_use"
]
if not tool_calls:
    return
```

Chỉ các block `tool_use` cụ thể mới vào giai đoạn thực thi, nên vòng lặp không bao giờ append một tin nhắn tool-result rỗng.

**Bước 4**: Thực thi tool mà mô hình yêu cầu và thu kết quả.

```python
results = []
for block in tool_calls:
    output = run_bash(block.input["command"])
    results.append({
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": output,
    })
```

**Bước 5**: Append kết quả tool như một tin nhắn mới rồi quay lại Bước 2.

```python
messages.append({"role": "user", "content": results})
```

Ghép thành một hàm hoàn chỉnh:

```python
def agent_loop(messages):
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        tool_calls = [
            block for block in response.content if block.type == "tool_use"
        ]
        if not tool_calls:
            return

        results = []
        for block in tool_calls:
            output = run_bash(block.input["command"])
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": output,
            })
        messages.append({"role": "user", "content": results})
```

Hơn 30 dòng — đó là kernel harness agent tối thiểu có thể chạy. Nó không phải trí tuệ, mà là runtime nhỏ nhất để mô hình tiếp tục hành động. Mô hình quyết định (có gọi tool không, gọi cái nào), harness thực thi (gọi tool rồi append kết quả thành tin nhắn mới). 16 chương sau đều thêm cơ chế lên trên vòng lặp này. Bản thân vòng lặp không đổi.

---

## Thử chạy

> **Lưu ý an toàn**: Code thực thi lệnh shell do mô hình sinh ra. Chạy trong thư mục tạm để tránh ảnh hưởng file dự án. s03 sẽ thêm kiểm soát quyền.

**Cài đặt** (lần đầu):

```sh
pip install -r requirements.txt
cp .env.example .env
# Edit .env, fill in ANTHROPIC_API_KEY and MODEL_ID
```

**Chạy**:

```sh
python s01_agent_loop/code.py
```

Thử các prompt sau:

1. `Create a file called hello.py that prints "Hello, World!"`
2. `List all Python files in this directory`
3. `What is the current git branch?`

Điều cần quan sát: Khi nào mô hình gọi tool (vòng lặp tiếp tục), khi nào không gọi (vòng lặp kết thúc)?

---

## Tiếp theo

Hiện mô hình chỉ có bash — đọc file thì `cat`, ghi file thì `echo ... >`, tìm file thì `find`. Vừa xấu vừa dễ sai.

→ s02 Tool Use: Điều gì xảy ra khi ta cho nó 5 tool đúng nghĩa? Mô hình có gọi nhiều tool cùng lúc không? Thực thi song song có đạp lên nhau không?


<!-- translation-sync: zh@v2, en@v2, ja@v2, vi@v2 -->
