# 璀璨宝石 · 双人对决 (Splendor Duel)

可部署在 Linux 服务器上的双人在线「璀璨宝石」网页游戏。
Node.js + WebSocket 实现,服务端判定全部规则,浏览器直接打开即可玩,无需安装客户端。

## 功能

- 完整 Splendor 规则:90 张发展卡(三级)、10 位贵族随机取 3、双人局每色 4 枚宝石 + 5 枚黄金
- 拿宝石(3 枚不同色 / 同色 2 枚需库存 ≥4)、购买、预定(含牌堆盲预定,对手不可见)、黄金万能支付自动计算
- 超 10 枚强制弃宝石、贵族拜访(多位可选)、15 分触发终局(补齐同等回合数)、平局按卡牌数判定
- 房间码对战:创建房间 → 把 4 位房间码发给对手 → 对方加入即自动开局
- 断线自动重连(浏览器刷新 / 网络闪断都能恢复对局)
- 局终可一键「再来一局」

## 快速开始

需要 Node.js ≥ 16。

```bash
cd splendor
npm install
node server.js          # 默认端口 3000,可用 PORT=8080 node server.js 修改
```

浏览器访问 `http://服务器IP:3000`,一人点「创建房间」,另一人输入房间码「加入房间」即可开战。

记得放行防火墙端口,例如:

```bash
sudo ufw allow 3000/tcp        # Ubuntu/Debian
# 或
sudo firewall-cmd --add-port=3000/tcp --permanent && sudo firewall-cmd --reload   # CentOS/RHEL
```

## 运行测试

```bash
npm test    # 端到端冒烟测试:建房、拿宝石、预定、购买、弃子、重连等 23 项断言
```

## 用 systemd 常驻运行

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
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp -r splendor /opt/splendor && cd /opt/splendor && sudo npm install --omit=dev
sudo systemctl daemon-reload
sudo systemctl enable --now splendor
```

## 可选:Nginx 反向代理(HTTPS / 80 端口)

WebSocket 需要升级头,配置示例:

```nginx
server {
    listen 80;
    server_name game.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

页面在 HTTPS 下会自动改用 `wss://` 连接,无需额外配置。

## 项目结构

```
splendor/
├── server.js           # 全部服务端:HTTP 静态服务 + WebSocket 房间管理 + 规则引擎 + 牌库数据
├── public/index.html   # 全部前端:大厅 + 棋盘 UI + 交互(单文件,无构建步骤)
├── scripts/smoke.js    # 端到端冒烟测试
└── package.json        # 唯一依赖:ws
```

## 规则速览

每回合任选其一:**拿宝石**(3 枚不同色,或库存 ≥4 时同色 2 枚)/ **购买发展卡**(场上或自己预定的)/ **预定**(拿到手最多 3 张,附赠 1 枚黄金)。
购得的卡提供永久宝石折扣;集齐贵族要求的卡牌颜色即获 3 分拜访。手中宝石超过 10 枚须弃至 10。先到 15 分者触发终局,双方回合数补齐后分高者胜,同分则购卡少者胜。
