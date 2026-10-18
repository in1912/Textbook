#!/usr/bin/env python3
"""Create a UTF-8 zip that survives Windows Explorer and macOS Archive Utility.

Python's zipfile already sets the UTF-8 name flag for non-ASCII entries, but it
drops Unix permissions unless they are written explicitly. macOS needs the
executable bit on .command/.sh files, so we set it here instead of relying on
`zip` being installed.

Usage: python zip-utf8.py <source-dir> <output.zip> [name-in-zip]
"""
import os
import stat
import sys
import zipfile

EXEC_SUFFIXES = ('.command', '.sh', '.py')


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    src = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2])
    top = sys.argv[3] if len(sys.argv) > 3 else ''
    if not os.path.isdir(src):
        print(f'not a directory: {src}', file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    count = 0
    total = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(src):
            dirs.sort()
            rel_root = os.path.relpath(root, src)
            if rel_root == '.':
                rel_root = ''
            for d in dirs:
                rel = os.path.join(rel_root, d).replace(os.sep, '/')
                arc = f'{top}/{rel}' if top else rel
                info = zipfile.ZipInfo(arc + '/')
                info.external_attr = (0o40755 << 16) | 0x10
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, b'')
            for f in sorted(files):
                full = os.path.join(root, f)
                rel = os.path.join(rel_root, f).replace(os.sep, '/')
                arc = f'{top}/{rel}' if top else rel
                # Windows reports 0o666 for every file; normalise so the archive
                # looks the same however it was built.
                mode = 0o755 if f.lower().endswith(EXEC_SUFFIXES) else 0o644
                info = zipfile.ZipInfo(arc)
                info.external_attr = (stat.S_IFREG | mode) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(full, 'rb') as fh:
                    zf.writestr(info, fh.read())
                count += 1
                total += os.path.getsize(full)
    print(f'[zip] {out} <- {src} ({count} files, {total / 1048576:.1f} MB raw)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
