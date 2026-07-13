# 璀璨宝石 · 双人对决 (Splendor Duel)

一款支持双人在线对战的「璀璨宝石」桌游复刻。基于 Node.js + WebSocket,服务端统一判定规则,双方打开浏览器即可对战,无需安装客户端或注册账号。

## 功能

- 完整 Splendor 规则:90 张发展卡(三级)、10 位贵族随机取 3、双人局每色 4 枚宝石 + 5 枚黄金
- 拿宝石(3 枚不同色 / 同色 2 枚需库存 ≥4)、购买、预定(含牌堆盲预定,对手不可见)、黄金万能支付自动计算
- 超 10 枚强制弃宝石、贵族拜访(多位可选)、15 分触发终局(补齐同等回合数)、平局按卡牌数判定
- 房间码对战:创建房间 → 把 4 位房间码发给对手 → 对方加入即自动开局
- 断线自动重连(浏览器刷新 / 网络闪断都能恢复对局)
- 等待或对局中均可退出;对局座位暂时保留,可从大厅继续
- 未使用的邀请码创建 10 分钟后失效,已开局房间 10 分钟无操作后自动解散
- 局终可一键「再来一局」

## 在 Linux 服务器上部署(外网可访问)

### 1. 环境要求

- Linux 服务器(需有公网 IP 或端口映射)
- Node.js ≥ 16

### 2. 上传项目并安装依赖

```bash
# 将整个 splendor 目录上传到服务器,例如 /opt/splendor
scp -r splendor/ user@your-server:/opt/

# SSH 登录服务器
ssh user@your-server

# 安装依赖
cd /opt/splendor
npm install --omit=dev
```

### 3. 放行防火墙端口

```bash
# Ubuntu / Debian
sudo ufw allow 3000/tcp
sudo ufw enable   # 如果 ufw 尚未启用

# CentOS / RHEL
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload
```

如果服务器在云厂商(阿里云/腾讯云/AWS 等)上,还需在**安全组/防火墙规则**中放行 TCP 3000 端口,否则外网无法访问。

### 4. 启动服务

**临时测试:**

```bash
node server.js
# 默认监听 3000 端口,外网访问 http://你的公网IP:3000
# 自定义端口: PORT=8080 node server.js
# 自定义房间超时(毫秒,默认 600000 即 10 分钟): ROOM_TIMEOUT_MS=900000 node server.js
```

浏览器访问 `http://你的公网IP:3000`,一人点「创建房间」,另一人输入房间码「加入房间」即可对战。

**生产环境(用 systemd 常驻后台,重启自动拉起):**

创建 `/etc/systemd/system/splendor.service`:

```ini
[Unit]
Description=Splendor Duel Game Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/splendor
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=ROOM_TIMEOUT_MS=600000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

然后启动:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now splendor
sudo systemctl status splendor   # 确认运行正常
```

**服务管理常用命令:**

```bash
systemctl start splendor      # 启动
systemctl stop splendor       # 关闭
systemctl restart splendor    # 重启
systemctl status splendor     # 查看状态
journalctl -u splendor -f     # 查看实时日志
```

### 5. 云安全组未放行 3000 端口时用 Nginx 反代到 80 端口

部分云厂商安全组不允许放行非标端口,此时无需暴露 3000 端口,用 Nginx 将 80 端口流量反向代理到本地 3000 即可。项目代码无需任何修改。

安装 Nginx:

```bash
sudo apt install -y nginx
```

编辑 `/etc/nginx/sites-enabled/default`,替换为:

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```

重载 Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

访问 `http://公网IP` (80 端口) 即可。

> **注意:** `proxy_http_version 1.1` 和 `Upgrade` / `Connection` 头是 WebSocket 代理所必需的,缺一不可。

### 6. (可选)绑定域名 + HTTPS 反向代理

如果有域名,推荐用 Nginx 反代到本地端口,并配置 SSL 证书。

**Nginx 配置示例** (`/etc/nginx/sites-available/splendor`):

```nginx
server {
    listen 80;
    server_name game.your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用站点并重载:

```bash
sudo ln -s /etc/nginx/sites-available/splendor /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS 配置(用 Let's Encrypt 获取免费证书):

```bash
sudo apt install certbot python3-certbot-nginx   # Ubuntu / Debian
sudo certbot --nginx -d game.your-domain.com
```

页面在 HTTPS 下会自动改用 `wss://` 连接 WebSocket,无需额外配置。

## 验证外网访问

部署完成后,在自己手机上用 4G/5G 流量访问 `http://你的公网IP:3000`,确认页面能打开且能正常创建房间。

如果无法访问,请逐一排查:

1. `ss -tlnp | grep 3000` — 确认服务正在监听 `0.0.0.0:3000`
2. `sudo ufw status` — 确认防火墙放行了 3000 端口
3. 云厂商安全组 — 确认入方向允许 TCP 3000

## 项目结构

```
splendor/
├── server.js           # 服务端:HTTP 静态服务 + WebSocket 房间管理 + 规则引擎 + 牌库数据
├── public/index.html   # 前端:大厅 + 棋盘 UI + 交互(单文件,无构建步骤)
├── scripts/smoke.js    # 端到端冒烟测试
└── package.json        # 唯一依赖:ws
```

## 运行测试

```bash
npm test    # 端到端冒烟测试:规则、重连、主动退出恢复、邀请码和房间超时等 37 项断言
```

## 规则速览

每回合任选其一:**拿宝石**(3 枚不同色,或库存 ≥4 时同色 2 枚)/ **购买发展卡**(场上或自己预定的)/ **预定**(拿到手最多 3 张,附赠 1 枚黄金)。
购得的卡提供永久宝石折扣;集齐贵族要求的卡牌颜色即获 3 分拜访。手中宝石超过 10 枚须弃至 10。先到 15 分者触发终局,双方回合数补齐后分高者胜,同分则购卡少者胜。
