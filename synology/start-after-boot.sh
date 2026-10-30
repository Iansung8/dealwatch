#!/bin/sh
# NAS 開機後補啟動 dealwatch。
#
# 關機時 Container Manager 會逐一停止容器，開機時再依「建立時間由新到舊」逐一啟動，失敗不重試。
# dealwatch 共用 dealwatch-browser 的網路，又一定比它晚建立，所以總是先被啟動、因為瀏覽器還沒起來而失敗。
# 這支腳本等 Container Manager 跑完自己的啟動流程後，用 compose 依 depends_on 的順序把沒起來的容器補上。
#
# 設定方式見 synology/README.md「開機後自動補啟動」：DSM 任務排程表新增「觸發的任務 → 開機」，
# 以 root 或 docker 群組裡的帳號執行 `sh /volume1/docker/dealwatch/synology/start-after-boot.sh`。
cd "$(dirname "$0")/.." || exit 1
export PATH="$PATH:/usr/local/bin"
log() { echo "$(date '+%F %T') $*"; }

# Container Manager 的 docker 開機時可能要好幾分鐘才起來；最多等 20 分鐘
i=0
until err=$(docker info 2>&1 >/dev/null); do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    case "$err" in
      *"permission denied"*) log "沒有權限連 docker：任務的執行帳號要是 root 或在 docker 群組。$err" ;;
      *) log "docker 一直沒有起來，放棄。$err" ;;
    esac
    exit 1
  fi
  sleep 10
done
# 讓 Container Manager 先跑完它自己那一輪啟動，避免兩邊同時啟動同一個容器
sleep "${DEALWATCH_BOOT_DELAY:-90}"

# 瀏覽器冷啟動慢、或對外綁定的網路介面（例如 VPN）還沒起來時會失敗，間隔一分鐘重試
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  log "啟動 dealwatch 專案（第 $attempt 次）"
  docker compose up -d && { log '完成'; exit 0; }
  sleep 60
done
log '重試 10 次仍失敗，請到 Container Manager 看 dealwatch 與 dealwatch-browser 的紀錄'
exit 1
