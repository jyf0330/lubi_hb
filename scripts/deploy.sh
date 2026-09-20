#!/usr/bin/env bash
# 把本仓库的正式服务文件发布到腾讯云生产目录，并重启正式服务。
#
# 用法（在服务器上的 git 源目录中执行）：
#   bash scripts/deploy.sh
#
# 可覆盖的默认值：
#   TARGET=/opt/game-team-board SERVICE=game-team-board.service BRANCH=main
#
# 只发布正式服务运行所需的 Python 模块与 static/ 资源；不会发布 nginx 配置、
# systemd 单元、测试、文档或数据库，也不会删除正式目录里仓库之外的文件。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${TARGET:-/opt/game-team-board}"
SERVICE="${SERVICE:-game-team-board.service}"
BRANCH="${BRANCH:-main}"

APP_FILES=(
  app.py
  workflow.py
  mcp_protocol.py
  report_files.py
  report_images.py
  task_files.py
  task_planner.py
  schema.sql
)

cd "$REPO_DIR"

echo "==> 仓库：$REPO_DIR"

if [ -n "$(git status --porcelain)" ]; then
  echo "错误：git 工作区不干净，请先提交或清理后再发布。" >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  echo "错误：当前分支为 ${CURRENT_BRANCH}，期望 ${BRANCH}。" >&2
  exit 1
fi

echo "==> 拉取最新代码（git pull --ff-only origin ${BRANCH}）"
git pull --ff-only origin "$BRANCH"
REV="$(git rev-parse --short HEAD)"
echo "==> 目标版本：$REV"

for f in "${APP_FILES[@]}"; do
  [ -f "server/$f" ] || { echo "错误：缺少 server/$f" >&2; exit 1; }
done
[ -d server/static ] || { echo "错误：缺少 server/static 目录" >&2; exit 1; }

echo "==> 语法检查"
PY_FILES=()
for f in "${APP_FILES[@]}"; do
  case "$f" in
    *.py) PY_FILES+=("server/$f") ;;
  esac
done
python3 -m py_compile "${PY_FILES[@]}"

TS="$(date +%Y%m%d-%H%M%S)"
BK="$TARGET/backups/deploy-$TS-$REV"
echo "==> 备份现有正式文件到 $BK"
sudo mkdir -p "$BK"
for f in "${APP_FILES[@]}"; do
  [ -f "$TARGET/$f" ] && sudo cp -a "$TARGET/$f" "$BK/$f"
done
if [ -d "$TARGET/static" ]; then
  sudo mkdir -p "$BK/static"
  sudo cp -a "$TARGET/static/." "$BK/static/"
fi

echo "==> 发布服务文件到 $TARGET"
for f in "${APP_FILES[@]}"; do
  sudo install -m 0644 -o root -g root "server/$f" "$TARGET/$f"
done
sudo mkdir -p "$TARGET/static"
sudo cp -a server/static/. "$TARGET/static/"

echo "==> 校验发布结果与仓库一致"
for f in "${APP_FILES[@]}"; do
  a="$(md5sum < "server/$f" | cut -d' ' -f1)"
  b="$(md5sum < "$TARGET/$f" | cut -d' ' -f1)"
  [ "$a" = "$b" ] || { echo "错误：$f 发布后校验不一致" >&2; exit 1; }
done
for f in server/static/*; do
  name="$(basename "$f")"
  a="$(md5sum < "$f" | cut -d' ' -f1)"
  if [ ! -f "$TARGET/static/$name" ]; then
    echo "错误：static/$name 未发布" >&2
    exit 1
  fi
  b="$(md5sum < "$TARGET/static/$name" | cut -d' ' -f1)"
  [ "$a" = "$b" ] || { echo "错误：static/$name 发布后校验不一致" >&2; exit 1; }
done
for f in "$TARGET"/static/*; do
  name="$(basename "$f")"
  [ -f "server/static/$name" ] || echo "提示：正式目录存在仓库外的静态文件 static/${name}，本次未改动"
done

echo "==> 重启 $SERVICE"
sudo systemctl restart "$SERVICE"
sleep 2
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "错误：$SERVICE 未处于 active；备份位于 $BK" >&2
  systemctl status "$SERVICE" --no-pager -l | head -20 >&2 || true
  exit 1
fi

echo "==> 健康检查"
curl -fsS http://127.0.0.1:4312/health >/dev/null || { echo "错误：健康检查失败；备份位于 $BK" >&2; exit 1; }

echo "==> 完成：$REV 已发布，服务 active，备份位于 $BK"
