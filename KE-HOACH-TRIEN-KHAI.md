# Kế hoạch triển khai Nihongo Study

## Mục tiêu và phạm vi

Bảo vệ bài học theo chủ sở hữu, lưu dữ liệu học tập trên MongoDB, bổ sung luyện viết kanji có chấm tham khảo, trắc nghiệm và ôn tập. Giữ tương thích JSON và prompt import hiện tại. Không triển khai, xóa dữ liệu thật hoặc chạy migration production khi chưa có bản sao lưu và quyết định xử lý dữ liệu cũ.

## Hiện trạng cần lưu ý

- `netlify/functions/api.js`: GET /lessons hiện trả mọi bài cho mọi tài khoản; POST/DELETE đã kiểm tra một phần quyền sở hữu. Chủ sở hữu lấy từ phiên; admin hiện sửa được bài người khác, cần thay đổi.
- Cơ chế khởi tạo tự nạp bài từ `data/lessons` khi collection lessons rỗng; phải tắt để bài đã xóa không xuất hiện lại.
- `app.js` đã có flashcard, chế độ chưa thuộc/cần ôn và trộn thẻ; chưa có trắc nghiệm hoặc bộ lọc trả lời sai.
- Tiến trình hiện gắn username và cardKey trong collection riêng. Cần kiểm tra quyền bài học, định danh bền vững và cách xử lý dữ liệu cũ.
- `db.js` còn nhánh IndexedDB; README nói cần kết nối MongoDB. Loại bỏ các đường ghi dữ liệu học local; không báo thành công khi ghi cloud thất bại.
- Mục `kanji` hiện là danh sách do file nhập cung cấp; không tự trích chữ từ vocabulary. `normalizeLesson` chưa xác thực đó là từng chữ Hán.

## 1. Quyền truy cập và danh tính

| Hành động | Người dùng thường | Admin |
| --- | --- | --- |
| Xem, tìm, học | Chỉ bài của mình | Mọi bài |
| Tạo/import | Bài thuộc người đăng nhập | Bài thuộc admin đăng nhập |
| Sửa bài và từng mục | Chỉ bài của mình | Chỉ bài của mình |
| Xóa bài | Chỉ bài của mình | Bài của mình hoặc người khác |
| Xem/ghi tiến trình | Chỉ tiến trình của mình | Chỉ tiến trình của admin |

Kiểm tra ở mọi endpoint, cả truy cập trực tiếp và dữ liệu cho ôn tập, đáp án nhiễu, export. Lấy danh tính và vai trò từ phiên đã xác thực; không tin username/createdBy từ client. Xác định chính sách xử lý tài khoản đã xóa và dữ liệu vô chủ, không tự gán chủ sở hữu khi chưa rõ.

Dùng định danh bài nội bộ duy nhất toàn hệ thống, ổn định và không tái sử dụng; giữ mã trong file làm mã nguồn/hiển thị để các chủ sở hữu có thể nhập cùng mã mà không ghi đè nhau. Phân biệt rõ tạo bài mới với cập nhật bài do chính mình sở hữu; không cho import nhầm ghi đè bài người khác. Migration phải bảo toàn liên kết và khóa tiến trình cũ; báo cáo xung đột trước khi chuyển đổi.

## 2. Kho bài và quản lý nội dung

- Người dùng: tab Bài học của tôi. Admin: thêm tab Bài học của người dùng khác, hiển thị chủ sở hữu và lọc theo người tải. Tìm theo tên/mã, lọc cấp độ, giáo trình, loại nội dung; áp dụng quyền ở server trước bộ lọc. Phân trang nếu cần.
- Chủ bài sửa thông tin bài và thêm/sửa/xóa từng mục từ vựng, ngữ pháp, kanji, bài đọc. Giữ ID của các mục không thay đổi; xác thực dữ liệu và ID trùng.
- Xóa bài hoặc mục yêu cầu xác nhận và thông báo ảnh hưởng đến tiến trình. Với admin xóa bài người khác, hiển thị bài/chủ sở hữu và yêu cầu nhập lại mã hoặc tên để xác nhận; server vẫn kiểm tra quyền.
- Xác định và triển khai nhất quán quy tắc dọn hoặc lưu lịch sử tiến trình khi xóa; ID không tái sử dụng để tránh gắn nhầm. Không để tiến trình bị lộ hoặc áp vào bài khác.

## 3. MongoDB, migration và vận hành

- Bỏ tự seed bài mẫu khi collection rỗng, bao gồm mọi đường build/fallback liên quan; giữ file mẫu import nếu cần. Không tự xóa bài đang có.
- MongoDB là nguồn dữ liệu bài, tiến trình và kết quả ôn tập; khi mất kết nối hiển thị lỗi, không báo lưu thành công hoặc chuyển sang ghi local. Kiểm tra service worker, phiên đăng nhập và hiển thị sau khi đăng nhập lại.
- Sao lưu trước migration; chạy dry-run, thống kê bài vô chủ, mã trùng và tiến trình cần ánh xạ. Xin quyết định xử lý các bản ghi vô chủ hoặc xung đột không thể xác định. Chạy thử trên bản sao, đối chiếu số lượng, kiểm tra khôi phục và chuẩn bị rollback trước production.
- Dùng chỉ mục duy nhất phù hợp cho ID bài và tiến trình theo người học/bài/mục/loại hoạt động; xử lý trùng dữ liệu trước khi tạo chỉ mục. Không xóa dữ liệu production trong bước kiểm thử.

## 4. Tiến trình cá nhân

Lưu riêng nội dung và tiến trình: người học được xác định từ phiên; bản ghi gắn người học, ID bài nội bộ, ID mục và loại hoạt động. Người dùng chỉ đọc/ghi tiến trình của chính mình; admin học bài người khác chỉ tạo tiến trình của admin. Xác thực quyền xem bài trước khi ghi. Bảo toàn và chuyển đổi các bản ghi `username:cardKey` hiện có; kiểm thử các ID chứa dấu phân cách.

Flashcard hiện có giữ được lọc chưa thuộc, cần ôn và trộn; trạng thái tự đánh giá phải phân biệt với kết quả trắc nghiệm và điểm viết.

## 5. Import và tương thích

Giữ nguyên schema JSON và prompt đang dùng. `kanji` có sẵn quyết định danh sách luyện theo bài; bài không có `kanji` vẫn import bình thường. Không bắt buộc bổ sung dữ liệu nét vào JSON. Không âm thầm loại bỏ dữ liệu cũ: đưa ra cảnh báo cho mục không phải một chữ hỗ trợ luyện viết, cho import nội dung và đánh dấu mục không hỗ trợ khi cần. Tách xác thực import với khả năng tra mẫu; không giả định mục nào cũng có mẫu. Duy trì mã và nội dung các loại mục cũ, kiểm thử cả bài chỉ có reading.

## 6. Học và luyện viết chữ Hán

- Tab Học chữ Hán: chọn một bài để luyện lần lượt theo thứ tự `kanji`, hoặc chọn từng chữ/một nhóm chữ từ các bài được phép xem. Nếu chọn từ nhiều chữ là tính năng sau, chỉ triển khai sau khi xác định xử lý chữ chưa có trong kanji.
- Canvas vuông chia bốn bằng dấu cộng, nhận chuột, cảm ứng và bút. Hỗ trợ Xong, Viết lại, chuyển chữ, gợi ý và hiển thị chữ mẫu sau khi hoàn thành; có thể xem thứ tự nét.
- Mẫu dùng dạng nét viết Nhật, ưu tiên khảo sát KanjiVG (https://kanjivg.tagaini.net/). Kiểm tra nguồn, phiên bản, độ bao phủ và giấy phép của đúng bộ dữ liệu, ghi công và kèm giấy phép; không yêu cầu thay đổi file import. Cung cấp dự phòng tự đối chiếu nếu không có mẫu.
- Chấm bằng thuật toán không dùng AI: ghi tọa độ từng nét, chuẩn hóa vị trí/kích thước; so sánh hình dạng/vị trí và số nét với mẫu, đánh giá thứ tự và hướng trong chế độ nghiêm ngặt. Phải chống trường hợp viết thừa nét, chữ gần giống; chấm theo từng nét là một thiết kế cần kiểm thử chứ không bảo đảm nhận dạng chính xác.
- Hai chế độ dự kiến: hình dạng dễ hơn và thứ tự nét. Điểm 80/100 chỉ là ngưỡng thử nghiệm, không phải xác suất đúng; hiệu chỉnh bằng mẫu viết tay thực tế trên điện thoại và máy tính. Luôn hiển thị đáp án dạng nét viết bên cạnh chữ người dùng, cho viết lại và tự điều chỉnh đánh giá khi chấm nhầm. Không có mẫu hoặc độ tin cậy chưa đủ thì không tự chấm.
- Lưu kết quả/trạng thái của từng người trên MongoDB; danh sách chữ cần luyện lại tách khỏi sai trắc nghiệm. Không cần lưu ảnh/nét vẽ lâu dài nếu không có yêu cầu.

## 7. Trắc nghiệm và ôn tập

- Chọn bài, nhiều bài hoặc từ cụ thể; chọn thứ tự bài hoặc trộn ngẫu nhiên mỗi lượt, kể cả khi ôn từ sai. Có thể trộn từ giữa những bài đã chọn.
- Mỗi câu có một đáp án đúng và ba đáp án sai ngẫu nhiên, đảo vị trí. Lấy đáp án nhiễu từ dữ liệu người học được quyền xem, cùng loại câu hỏi; tránh trùng đáp án sau chuẩn hóa. Không đủ ba lựa chọn phù hợp thì thông báo chọn thêm dữ liệu, không dựng đáp án giả.
- Sau khi trả lời hiện đúng/sai và đáp án chuẩn; lưu kết quả theo tài khoản, bài và mục. Ôn tất cả từ sai, lọc theo bài hoặc chọn các từ cụ thể; hiển thị số mục cần ôn theo bài. Phân biệt từ sai với flashcard tự đánh dấu cần học lại và với chữ viết cần luyện.
- Đề xuất quy tắc có thể kiểm thử: trả lời sai đưa vào cần ôn; trả lời đúng khi ôn chuyển khỏi danh sách cần ôn nhưng giữ lịch sử; trả lời sai lần nữa đưa trở lại. Hiển thị quy tắc cho người học.

## 8. Đặt lại mật khẩu

Admin có thể đặt lại mật khẩu. Phương án đề xuất: tạo mật khẩu tạm riêng cho mỗi lần, hiển thị một lần, bắt đổi khi đăng nhập tiếp theo và thu hồi phiên hiện hữu. Người dùng đã yêu cầu mật khẩu mặc định nhưng chưa chốt dùng mật khẩu cố định hay tạm: xác nhận lựa chọn trước khi thay đổi hành vi nếu không thể suy ra; không ghi mật khẩu vào log hoặc lưu dạng rõ. Thiết kế luồng đổi mật khẩu và kiểm thử khóa phiên cũ.

## 9. Thứ tự triển khai

1. Kiểm kê dữ liệu, sao lưu và thử migration/rollback trên bản sao.
2. Tắt seed, chuẩn hóa ID/chủ sở hữu, quyền ở API, lưu MongoDB; kiểm thử các đường truy cập và xử lý lỗi.
3. Migration và cách ly tiến trình; bảo đảm admin học bài người khác không tác động tiến trình chủ bài.
4. Kho bài và tìm kiếm; giao diện sửa từng mục, xóa có xác nhận, đặc biệt xóa bài người khác.
5. Quy trình đặt lại mật khẩu sau khi chốt chính sách.
6. Tích hợp mẫu nét viết và giấy phép, canvas, đối chiếu và thử nghiệm chấm; giữ import tương thích.
7. Trắc nghiệm, xáo câu/đáp án, danh sách ôn và quy tắc kết quả.
8. Kiểm thử tổng thể, cập nhật tài liệu và chuẩn bị triển khai.

## 10. Tiêu chí nghiệm thu

- Hai user A/B và một admin: A không đọc/tìm/sửa/xóa bài B qua UI hoặc API; admin xem được tất cả, không sửa bài B nhưng xóa được sau xác nhận. Đáp án nhiễu, export và tiến trình không làm lộ nội dung ngoài quyền.
- A và B nhập cùng mã bài nhưng không ghi đè hoặc nhìn thấy bài nhau; mã nội bộ và các mục giữ liên kết đúng khi sửa/xóa/import lại.
- Admin và B học cùng bài: kết quả flashcard, trắc nghiệm, viết và ôn tập riêng biệt, còn nguyên sau đăng xuất, đăng nhập lại và mở thiết bị khác.
- Bài mẫu không tự trở lại khi kho rỗng hoặc sau restart/deploy; mất MongoDB không báo đã lưu và không phát sinh bản ghi học local.
- File import hiện tại, bài chỉ có reading, bài không có kanji và mục kanji thiếu mẫu vẫn hoạt động; cảnh báo rõ mà không mất dữ liệu.
- Kiểm tra vẽ bằng chuột/cảm ứng, thay đổi kích thước màn hình; mẫu viết tay Nhật hiển thị sau Xong, thứ tự nét và fallback khi thiếu mẫu; đánh giá cả đúng bị chấm sai và chữ khác bị chấm đúng trước khi chốt ngưỡng.
- Trắc nghiệm có bốn đáp án phân biệt hoặc thông báo thiếu dữ liệu; trộn câu/đáp án, ôn sai theo bài và liên bài, cập nhật khi đúng lại, cách ly tài khoản.
- Kiểm thử tự động API/logic quan trọng và giao diện cho luồng chính; kiểm thử migration trên bản sao, kiểm tra backup và rollback. Chạy npm test và npm run build; kiểm thử MongoDB thật chỉ trên cơ sở dữ liệu thử được chỉ định.
