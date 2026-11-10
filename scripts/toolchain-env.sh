#!/usr/bin/env bash
# 隔离构建链（M6b）——只在当前 shell 前置 PATH，不改系统/用户环境变量。
#
#   source scripts/toolchain-env.sh
#   node -v        # v24.22.2
#   pnpm -v        # 11.28.11
#   node scripts/check-env.mjs --check
#
# 工具链放在工作区级的 ../.wbsync-tools/（仓库外，不入库、不污染其它项目）。
# 若该目录不存在，本脚本什么都不做并给出提示。

_TC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.wbsync-tools" 2>/dev/null && pwd)"
if [ -z "$_TC" ] || [ ! -x "$_TC/node-v24.22.2-win-x64/node.exe" ]; then
  echo "toolchain: 未找到 ../.wbsync-tools/node-v24.22.2-win-x64/node.exe，跳过（沿用系统 PATH）" >&2
  unset _TC
  return 0 2>/dev/null || exit 0
fi

export WBSYNC_TOOLCHAIN="$_TC"
export PATH="$_TC/node-v24.22.2-win-x64:$_TC/bin:$PATH"
unset _TC
echo "toolchain: Node $(node -v) / pnpm $(pnpm -v 2>/dev/null || echo 'n/a') 已启用（仅当前 shell）"
