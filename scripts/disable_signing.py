#!/usr/bin/env python3
"""关闭 Xcode 工程的代码签名，使 xcodebuild 能在没有 Apple 证书的机器上完成 archive。

自变量: ios/App/App.xcodeproj/project.pbxproj 的路径
"""
import pathlib
import re
import sys

RULES = [
    (r"CODE_SIGN_STYLE = [^;]+;", "CODE_SIGN_STYLE = Manual;"),
    (r'DEVELOPMENT_TEAM = [^;]*;', 'DEVELOPMENT_TEAM = "";'),
    (r'CODE_SIGN_IDENTITY = [^;]+;', 'CODE_SIGN_IDENTITY = "";'),
    (r'PROVISIONING_PROFILE_SPECIFIER = [^;]+;', 'PROVISIONING_PROFILE_SPECIFIER = "";'),
    (r"CODE_SIGNING_ALLOWED = [^;]+;", "CODE_SIGNING_ALLOWED = NO;"),
    (r"CODE_SIGNING_REQUIRED = [^;]+;", "CODE_SIGNING_REQUIRED = NO;"),
]


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: disable_signing.py <path/to/project.pbxproj>", file=sys.stderr)
        return 1

    path = pathlib.Path(sys.argv[1])
    if not path.is_file():
        print(f"not found: {path}", file=sys.stderr)
        return 1

    text = path.read_text(encoding="utf-8")
    hits = 0
    for pattern, repl in RULES:
        text, n = re.subn(pattern, repl, text)
        hits += n

    path.write_text(text, encoding="utf-8")
    print(f"patched {hits} signing entries in {path}")
    if hits == 0:
        print("warning: no signing keys matched; the project layout may have changed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
