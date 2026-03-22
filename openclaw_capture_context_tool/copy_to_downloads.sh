#!/bin/bash
# 用法: ./copy_to_downloads.sh [文件名]
# 例如: ./copy_to_downloads.sh "token比对测试.html"

OUTPUT_DIR=/mnt/c/Users/xuwengui/Downloads
DEFAULT_NAME="openclaw_capture_$(date +%Y%m%d_%H%M%S).html"

if [ -n "$1" ]; then
    FILENAME="$1"
else
    FILENAME="$DEFAULT_NAME"
fi

# 复制最新的 HTML 文件
LATEST_HTML=$(ls -t ./output/*.html 2>/dev/null | head -1)
if [ -z "$LATEST_HTML" ]; then
    echo "错误: 没有找到 HTML 文件"
    exit 1
fi

cp "$LATEST_HTML" "$OUTPUT_DIR/$FILENAME"
echo "已复制到: $OUTPUT_DIR/$FILENAME"
ls -lh "$OUTPUT_DIR/$FILENAME"
