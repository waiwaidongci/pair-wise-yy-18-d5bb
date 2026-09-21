#!/usr/bin/env python3
# sqlite3 CLI 兼容 shim：运行环境没有 sqlite3 可执行文件（也无编译工具链），
# 但 Python3 自带 sqlite3。存储模块(src/storage/db.js)仍以“给 SQL、拿结果”的
# CLI 语义调用本脚本：
#   python3 sqlite_shim.py DB_FILE            # 执行 stdin 中的脚本（可含事务）
#   python3 sqlite_shim.py DB_FILE --json SQL # 执行单条查询，stdout 输出 JSON 数组
import json
import sqlite3
import sys


def main():
    args = [a for a in sys.argv[1:] if a != '--json']
    if not args:
        sys.stderr.write('missing db file\n')
        sys.exit(1)
    db_path = args[0]
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA busy_timeout = 30000;')
    try:
        if '--json' in sys.argv:
            sql = sys.stdin.read()
            rows = conn.execute(sql).fetchall()
            json.dump([dict(r) for r in rows], sys.stdout, ensure_ascii=False)
            sys.stdout.write('\n')
        else:
            # executescript 支持 BEGIN IMMEDIATE; ... COMMIT; 多语句事务，
            # 任何一条失败都会抛异常，连接关闭时未提交事务自动回滚。
            conn.executescript(sys.stdin.read())
    finally:
        conn.close()


if __name__ == '__main__':
    main()
