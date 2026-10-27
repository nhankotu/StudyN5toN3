# Nihongo Study — Ứng dụng học tiếng Nhật nội bộ (Fullstack Web App)

Ứng dụng web học tiếng Nhật đa nền tảng (Điện thoại & Máy tính), tích hợp **Netlify Functions (Serverless)** và cơ sở dữ liệu đám mây **MongoDB Atlas (Free 512MB)**. Tự động đồng bộ bài học và tiến độ học cho các thành viên nội bộ.

## Chức năng chính

1. **Hệ thống đăng nhập nội bộ & Phân quyền Admin:**
   - Tài khoản Quản trị mặc định: `admin` / mật khẩu: `admin123`.
   - **Chỉ Quản trị viên** mới có quyền vào mục **Quản lý tài khoản** để tạo tài khoản cho thành viên khác, đổi mật khẩu hoặc xóa tài khoản.
   - Dữ liệu tài khoản lưu tập trung trên **MongoDB Atlas**, đăng nhập đồng thời trên cả điện thoại và máy tính.
2. **Đồng bộ bài học và tiến độ học tập (Cloud Sync):**
   - Admin tải bài học JSON lên trực tiếp từ giao diện ➔ Lưu ngay vào MongoDB ➔ Tất cả các thiết bị mở web đều thấy bài mới tức thì.
   - Mỗi thành viên có tiến độ học tập riêng (Spaced Repetition System - SRS), học trên máy tính xong mở điện thoại tiếp tục học đúng tiến độ.
3. **Từ vựng & Furigana chuẩn (`<ruby>`):**
   - Hỗ trợ cú pháp Furigana: `私[わたし]` hoặc `今[いま]、何時[なんじ]ですか。` hoặc trường `"ruby": "学校[がっこう]"`.
   - Tự động hiển thị chữ nhỏ trên đầu chữ Hán, phát âm Text-to-Speech tự nhiên (tự lọc bỏ ngoặc).
4. **Flashcards nâng cao:**
   - **Đảo mặt thẻ (Reverse mode):** chuyển đổi linh hoạt giữa `🇯🇵 Nhật ➔ 🇻🇳 Việt` và `🇻🇳 Việt ➔ 🇯🇵 Nhật`.
   - **Trộn thẻ ngẫu nhiên (Shuffle):** xáo trộn thứ tự các thẻ trước khi ôn để chống học vẹt.
   - Vuốt ngón tay trên điện thoại, phím tắt mũi tên trên máy tính.
5. **Mẫu câu & Chữ Hán:** Cấu trúc ngữ pháp kèm ví dụ; tra cứu âm On/Kun và từ ghép Kanji.

---

## Hướng dẫn thiết lập MongoDB Atlas (Miễn phí 100%)

1. Vào [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas) và tạo tài khoản miễn phí.
2. Tạo cụm CSDL miễn phí: Chọn **M0 (Free)** (Dung lượng 512MB).
3. Tại mục **Security**:
   - **Database Access:** Tạo 1 User CSDL (ví dụ username `admin`, password `Matkhau123!`).
   - **Network Access:** Bấm **Add IP Address** ➔ Chọn **Allow Access from Anywhere (`0.0.0.0/0`)** để Netlify và điện thoại có thể kết nối được.
4. Lấy chuỗi kết nối:
   - Bấm nút **Connect** tại Cluster ➔ Chọn **Drivers** (Node.js).
   - Copy chuỗi kết nối, thay mật khẩu của bạn vào, ví dụ:
     ```
     mongodb+srv://admin:Matkhau123!@cluster0.abcde.mongodb.net/nihongo_study?retryWrites=true&w=majority
     ```

---

## 1. Chạy thử trên máy tính (Local)

1. Mở file `.env` và dán chuỗi kết nối MongoDB của bạn vào:
   ```env
   MONGODB_URI=mongodb+srv://admin:Matkhau123!@cluster0.abcde.mongodb.net/nihongo_study?retryWrites=true&w=majority
   PORT=8000
   ```
2. Khởi động server:
   ```bash
   npm run dev
   ```
3. Mở trình duyệt tại `http://localhost:8000` và đăng nhập với tài khoản `admin` / `admin123`.

---

## 2. Đưa lên Netlify (Online cho mọi người dùng)

1. Đẩy mã nguồn lên kho Git (GitHub/GitLab) kết nối Netlify.
2. Trên bảng điều khiển Netlify:
   - Vào **Site configuration** ➔ **Environment variables**.
   - Bấm **Add a variable**:
     - Key: `MONGODB_URI`
     - Value: *(Dán chuỗi kết nối MongoDB Atlas của bạn vào)*
3. Trigger deploy lại 1 lần để Netlify nhận biến môi trường.
4. Mở đường link website Netlify của bạn trên điện thoại hoặc máy tính: Biểu tượng trạng thái sẽ hiện **🟢 MongoDB Cloud**, sẵn sàng cho toàn bộ thành viên cùng học!

---

## Mẫu định dạng JSON bài học

```json
{
  "id": "bai-04",
  "title": "Bài 4 – Thời gian",
  "level": "N5",
  "book": "Giáo trình của tôi",
  "order": 4,
  "vocabulary": [
    {
      "id": "v01",
      "japanese": "今[いま]",
      "reading": "いま",
      "meaning": "bây giờ",
      "example": "今[いま]、何時[なんじ]ですか。",
      "exampleMeaning": "Bây giờ là mấy giờ?"
    },
    {
      "id": "v02",
      "japanese": "時間",
      "ruby": "時間[じかん]",
      "reading": "じかん",
      "meaning": "thời gian"
    }
  ],
  "grammar": [
    {
      "id": "g01",
      "title": "Hỏi giờ",
      "pattern": "今[いま]、何時[なんじ]ですか。",
      "meaning": "Bây giờ là mấy giờ?",
      "explanation": "何時 (なんじ) được dùng để hỏi giờ.",
      "examples": [
        { "japanese": "今[いま]、七時[しちじ]です。", "meaning": "Bây giờ là 7 giờ." }
      ]
    }
  ],
  "kanji": [
    {
      "id": "k01",
      "character": "時",
      "meaning": "thời gian, giờ",
      "onyomi": "ジ",
      "kunyomi": "とき",
      "examples": [
        { "word": "時間", "reading": "じかん", "meaning": "thời gian" }
      ]
    }
  ]
}
```
