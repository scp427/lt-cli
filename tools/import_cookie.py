#!/usr/bin/env python3
"""从 macOS 网易云音乐客户端的本地 MMKV 存储中读取登录 Cookie。

只在本机读取，不联网，不打印 Cookie 内容。
输出写入 ~/.lt-cli/account.json（权限 0600）。
"""
import json
import os
import plistlib
import stat
from pathlib import Path

MMKV = Path.home() / 'Library/Containers/com.netease.163music/Data/Documents/storage/mmkv.default'
OUT = Path.home() / '.lt-cli/account.json'


def varint(data, offset):
    value = 0
    shift = 0
    while True:
        if offset >= len(data):
            raise ValueError('unexpected end of MMKV data')
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            break
        shift += 7
    return value, offset


def read_records(data):
    # 跳过 8 字节文件头（有效长度 + 校验/版本字段）。
    offset = 8
    records = []
    while offset < len(data) - 4:
        try:
            key_len, offset = varint(data, offset)
            if not 1 <= key_len <= 200:
                break
            key_bytes = data[offset:offset + key_len]
            if not all(32 <= char < 127 for char in key_bytes):
                break
            offset += key_len
            value_len, offset = varint(data, offset)
            if value_len < 1 or offset + value_len > len(data):
                break
            value = data[offset:offset + value_len]
            offset += value_len
            records.append((key_bytes.decode('ascii'), value))
        except (ValueError, IndexError):
            break
    return records


def unarchive_cookies(value):
    inner_len, index = varint(value, 0)
    blob = value[index:index + inner_len]
    archive = plistlib.loads(blob)
    objects = archive['$objects']

    def resolve(item):
        return objects[item.data] if isinstance(item, plistlib.UID) else item

    pairs = []
    for obj in objects:
        if not isinstance(obj, dict) or 'properties' not in obj:
            continue
        props = resolve(obj['properties'])
        if not isinstance(props, dict) or 'NS.keys' not in props or 'NS.objects' not in props:
            continue
        keys = [resolve(item) for item in props['NS.keys']]
        values = [resolve(item) for item in props['NS.objects']]
        entry = dict(zip(keys, values))
        domain = str(entry.get('Domain', ''))
        if not (domain.endswith('music.163.com') or domain == 'music.163.com'):
            continue
        name = entry.get('Name')
        cookie_value = entry.get('Value')
        if isinstance(name, str) and isinstance(cookie_value, str) and name:
            pairs.append((name, cookie_value))
    return pairs


def main():
    if not MMKV.exists():
        raise SystemExit(f'找不到客户端数据文件：{MMKV}')
    records = read_records(MMKV.read_bytes())
    cookie_values = [value for key, value in records if key == 'cookie']
    if not cookie_values:
        raise SystemExit('没有在客户端数据里找到 cookie 记录')
    pairs = unarchive_cookies(cookie_values[-1])
    # 同名 Cookie 保留最后一个（不同域的 __csrf 只留一个，避免重复）。
    deduped = {}
    for name, value in pairs:
        deduped[name] = value
    pairs = list(deduped.items())
    if not any(name == 'MUSIC_U' for name, _ in pairs):
        raise SystemExit('cookie 里没有 MUSIC_U，请先在客户端登录')

    cookie = '; '.join(f'{name}={value}' for name, value in pairs)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        'cookie': cookie,
        'savedAt': __import__('datetime').datetime.now().isoformat(),
        'source': 'macOS NeteaseMusic local MMKV',
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    os.chmod(OUT, stat.S_IRUSR | stat.S_IWUSR)
    names = ', '.join(name for name, _ in pairs)
    print(f'已导入客户端登录态到 {OUT}（{len(pairs)} 个字段：{names}）')


if __name__ == '__main__':
    main()
