# s17: Goal Loop: Mô hình đề xuất dừng; bộ đánh giá độc lập quyết định có tiếp tục không

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Tiếng Việt](README.vi.md)

s01 → ... → s15 → [s16](../s16_workflow_runtime/) → `s17`

> *"The model making no more tool calls means that one turn wants to stop. A separate evaluator decides whether the whole goal is complete."*
>
> **Tầng Harness: thực thi tiếp.** Kiểm tra điều kiện hoàn thành ở cuối mỗi lượt, và bắt đầu lượt khác khi việc còn lại.

---

![Goal Loop overview](images/goal-loop-overview.svg)

Từ s01, vòng lặp Agent có một điều kiện thoát đơn giản: khi mô hình ngừng gọi tool, chương trình return.

Điều đó đủ cho hội thoại thông thường, nhưng không phải lúc nào cũng đủ cho các task như "cứ sửa cho đến khi mọi test pass" hoặc "hoàn thành mọi tiêu chí nghiệm thu." Mô hình có thể tin việc đã xong sau khi mới làm một phần. Không có `tool_use` mới chỉ nghĩa là lượt hiện tại đã kết thúc; nó không chứng minh toàn bộ mục tiêu đã đạt.

`/goal` thêm một quyết định độc lập trước lần return thật.

## /goal là Stop hook theo phạm vi session

Nhập:

```text
/goal pytest tests/auth exits with code 0 and lint reports no errors
```

Chương trình lưu điều kiện hoàn thành và ngay lập tức đưa nó cho mô hình chính như task hiện tại. Bạn không cần gửi thêm prompt "bắt đầu làm."

Khi mô hình chính ngừng gọi tool, vòng lặp chạy Goal Stop hook trước khi return:

```python
if tool_results:
    messages.append({"role": "user", "content": tool_results})
    continue

decision = await self.goal.evaluate_after_turn(self.messages)
if decision.action == "block":
    self.messages.append({
        "role": "user",
        "content": decision.reason,
    })
    continue

return SessionResult(text=text, status=decision.action)
```

Không có goal đang hoạt động thì hook cho phép dừng ngay, nên điều kiện return giống s01.

## Bộ đánh giá tách khỏi worker

Mô hình chính sửa code, chạy lệnh, và giải task. Goal evaluator là một lần gọi mô hình riêng với một việc: phán điều kiện hoàn thành.

`GoalController` sở hữu evaluator như dependency nội bộ của Goal gate. Nó không phải đường return thứ hai bên cạnh vòng lặp chính.

Bài học này không có `CommandQueue` riêng: khi đánh giá chặn việc dừng, controller append lý do vào cùng `messages[]` và bắt đầu lượt tiếp theo. Host lớn hơn có thể dùng queue dùng chung để đưa input người dùng, kết quả nền, và lệnh continuation trở lại session, nhưng queue đó là vận chuyển cho cả host, không phải thành phần thuộc Goal gate. Đặt nó trong gate sẽ làm mờ quyết định với đường dùng để chuyển quyết định đó.

Evaluator thấy:

- điều kiện Goal đang hoạt động;
- cuộc hội thoại đến hiện tại;
- tool result mà worker đã đặt vào hội thoại đó.

Nó không có tool. Nó không đọc file hay chạy lại test một mình. Nó chỉ phán những gì đã có trong hội thoại:

```json
{
  "ok": false,
  "reason": "The conversation does not contain pytest's exit code yet.",
  "impossible": false
}
```

`ok=true` nghĩa là điều kiện được thỏa. `ok=false` nghĩa là cần thêm một lượt. Nếu task không còn hoàn thành được, evaluator có thể trả `impossible=true`.

## Hội thoại là input của evaluator

Evaluator đọc hội thoại hiện tại. Tool result, giải thích của worker, và notification của background-task đều vào đó như message, và quyết định phụ thuộc vào những gì các message đó thực sự nói.

Input của evaluator giữ các message hoàn chỉnh gần nhất. Nếu chỉ message mới nhất đã quá lớn, nó giữ đầu và cuối của message đó để một tool result không chiếm hết request evaluator.

Điều đó không nghĩa là một câu "tests passed" trần phải được chấp nhận. Prompt của evaluator yêu cầu rõ kết quả cụ thể từ hội thoại và bảo mô hình đừng giả định lệnh chưa được báo cáo đã thành công.

Vẫn là mô hình đọc text, nên độ tin cậy phụ thuộc vào việc kết quả quan trọng đã được nêu rõ chưa. System prompt của worker vì thế nói:

> After running a verification command, report the command and its result clearly enough for an independent evaluator to inspect.

Goal Loop không phải test framework. Tool vẫn thực hiện xác minh thật. Goal evaluator chỉ quyết định những kết quả xác minh đó có mặt trong bản ghi công việc hiện tại hay không.

## Điều kiện hoàn thành tốt thì kiểm được

"Làm code cho tốt" quá mơ hồ. Evaluator không biết "tốt" nghĩa là gì.

Điều kiện hữu ích nêu ba thứ:

1. **Trạng thái cuối:** điều gì phải đúng khi việc xong;
2. **Cách kiểm:** lệnh hoặc output nào chứng minh điều đó;
3. **Ràng buộc:** điều gì không được phá dọc đường.

Ví dụ:

```text
/goal finish the authentication migration until pytest tests/auth exits 0,
without modifying test files outside tests/auth
```

Nếu cần giới hạn việc chạy không người trông, dùng giới hạn lượt toàn cục của vòng lặp chính thay vì giấu ngân sách cố định trong Goal:

```bash
MAX_TURNS=20 python s17_goal_loop/code.py \
  "/goal fix the type errors until npm run typecheck exits 0"
```

## Việc chưa xong quay lại cùng vòng lặp

Khi evaluator nói điều kiện chưa đạt, nó trả một lý do ngắn:

```text
The conversation has no complete test result. Run pytest tests/auth and report its exit code.
```

Chương trình append lý do đó vào `messages[]` và thực thi `continue` trong vòng `while` hiện tại. Mô hình chính bắt đầu lượt khác mà không chờ người dùng gõ "continue."

Không có continuation queue riêng. Đánh giá Goal xảy ra tại ranh giới return của vòng lặp, và việc chưa xong quay lại qua cùng ranh giới đó.

## Chờ trước khi phán việc nền chưa xong

Một Workflow, lệnh nền, hoặc task bất đồng bộ khác có thể vẫn đang chạy khi mô hình chính kết thúc lượt hiện tại.

Đánh giá ngay sẽ sớm vì kết quả quan trọng chưa về hội thoại. Goal Stop hook trả `defer`, giữ Goal hoạt động, và bỏ qua evaluator. Khi task xong, host đưa completion message tới `submit_background_result()`; message đó vào cùng `messages[]`, và vòng lặp tiếp tục.

Notification của Workflow không có đặc quyền máy móc. Nó vào hội thoại như các message khác, và evaluator phán kết quả thực sự mà nó chứa.

## Continuation tự động vẫn cần lối thoát

Goal không có ngân sách mặc định ẩn hai mươi lượt. Evaluator phán lại điều kiện sau mỗi lượt đã hoàn thành.

Tuy nhiên không cơ chế tự động nào nên độc chiếm một request mãi. Bài học này giữ hai lối thoát chung ngoài bản thân goal:

- `max_turns` toàn cục của vòng lặp chính;
- trần số lần Stop-hook block liên tiếp.

Khi đạt giới hạn, chương trình trả quyền điều khiển cho người dùng. Nó không đánh dấu goal hoàn thành và không lặng lẽ xóa. Người dùng có thể xem status, cung cấp thêm thông tin, tiếp tục, hoặc xóa goal.

Lỗi evaluator theo cùng quy tắc: dừng continuation tự động, để goal hoạt động, và hiện lỗi thay vì tuyên bố thành công khi không thể phán hoàn thành.

## Xem, thay, và xóa

Một session có tối đa một Goal đang hoạt động.

```text
/goal
```

Hiện điều kiện, thời gian đã trôi, số lần đánh giá, token spend của Agent chính, và lý do evaluator gần nhất.

```text
/goal a new completion condition
```

Thay Goal trước và bắt đầu làm theo điều kiện mới ngay.

```text
/goal clear
```

Xóa Goal đang hoạt động. `stop`, `off`, `reset`, `none`, và `cancel` là alias được chấp nhận.

`GoalController.restore()` có thể khôi phục Goal vẫn đang hoạt động từ sự kiện `goal_status` mà host persist; CLI của bài học này không persist cả session. Goal đã hoàn thành, thất bại, hoặc đã xóa không restart. Điều kiện được mang sang, trong khi số lượt, thời gian đã trôi, và mốc token bắt đầu lại từ đầu.

## Code thêm gì

Đây là ví dụ cơ chế độc lập dựng trên kernel S04. Nó giữ năm tool cơ bản và bốn điểm hook, rồi thêm bốn phần riêng của Goal:

| Phần | Trách nhiệm |
|---|---|
| `GoalState` | Lưu điều kiện, số lần đánh giá, thời điểm bắt đầu, và lý do gần nhất |
| `PromptGoalEvaluator` | Dùng một lần gọi mô hình riêng để phán hội thoại |
| `GoalController` | Đặt, xem, xóa, và chạy Goal Stop hook |
| `AgentSession` | Nối Stop hook với ranh giới return ban đầu |

Điểm tích hợp chỉ vài dòng:

```python
decision = await self.goal.evaluate_after_turn(self.messages)
if decision.action == "block":
    continue
return SessionResult(text=text, status=decision.action)
```

## Thử chạy

Cài dependency và chuẩn bị `.env`:

```bash
pip install -r requirements.txt

# .env
ANTHROPIC_API_KEY=...
MODEL_ID=...

# Optional: use a smaller model for Goal evaluation
GOAL_EVALUATOR_MODEL_ID=...
```

Bắt đầu session tương tác:

```bash
python s17_goal_loop/code.py
```

Rồi nhập:

```text
/goal python -m pytest exits with code 0
```

Bạn cũng có thể đặt Goal trực tiếp từ dòng lệnh:

```bash
python s17_goal_loop/code.py "/goal python -m pytest exits with code 0"
```

## Quan hệ với s16

s16 trả lời cách một lô việc nên chạy: bước nào song song, kết quả được xác minh thế nào, và lần chạy bị gián đoạn resume ra sao.

s17 trả lời toàn bộ task đã hoàn thành chưa. Một Workflow có thể kết thúc thành công trong khi yêu cầu cuối của người dùng vẫn chưa đạt. Khi kết quả Workflow vào hội thoại, Goal evaluator quyết định session nên dừng hay tiếp tục.

Bạn có thể dùng từng cơ chế một mình. Khi một host nối chúng, completion message của Workflow vào hội thoại và Goal Loop quyết định task tổng thể có cần thêm một lượt không.

<!-- translation-sync: zh@v6, en@v6, ja@v6, vi@v6 -->
