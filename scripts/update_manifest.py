#!/usr/bin/env python3
"""Tự tìm tất cả file .json trong data/lessons và cập nhật data/manifest.json.
Chạy: python scripts/update_manifest.py (từ thư mục dự án).
Không giới hạn nhân tạo số lượng bài học hoặc số lượng file.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LESSONS_DIR = ROOT / 'data' / 'lessons'
MANIFEST = ROOT / 'data' / 'manifest.json'
files = sorted(LESSONS_DIR.rglob('*.json'))
paths = ['./data/lessons/' + p.relative_to(LESSONS_DIR).as_posix() for p in files]
MANIFEST.write_text(json.dumps({'files': paths}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Đã ghi {len(paths)} file JSON vào {MANIFEST.relative_to(ROOT)}')
