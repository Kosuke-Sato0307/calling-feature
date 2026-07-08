# Callin 📞 — LINE通話風の音声通話アプリ

無料版の **Cloudflare Workers だけ** で動く、シンプルでスタイリッシュな音声通話 Web アプリです。
PC・タブレット・スマホのブラウザから使えます。

## 主な機能

- 🎨 **テーマカラーをユーザーごとに選択**（12色）
- 🆔 **ランダムなユーザーID を自動発行**
- 🔍 **ID でユーザー検索 → 友だち追加**（双方向で登録されます）
- 👥 **友だち一覧**（表示名・ID・オンライン状態を表示、ID はタップでコピー）
- 📞 **友だち一覧から音声通話を発信**（WebRTC）
- 🎤 **通話中の機能**: ミュート / スピーカー切替 / 通話時間 / 通話終了 / 着信の応答・拒否
- 🔑 **かんたんログイン**: パスワードなし。別端末からは「ID + 表示名」で同じアカウントを復元

## 技術構成（ざっくり）

| 役割 | 使うもの |
| --- | --- |
| 画面（フロント） | 素の HTML / CSS / JavaScript（`public/`） |
| サーバー（バック） | Cloudflare Worker（`src/worker.js`） |
| データ保存・通話中継 | Durable Object（SQLite）＝ `Hub` クラス |
| 通話そのもの | WebRTC（ブラウザ同士を直接つなぐ）＋ 無料の公開 STUN |

Cloudflare Pages は使いません。**1 つの Worker** がフロントの配信もサーバー処理も兼ねます。

詳しい設計は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、
デプロイ手順は [`docs/DEPLOY.md`](docs/DEPLOY.md) を参照してください。

## ローカルで動かす

前提: [Node.js](https://nodejs.org/)（18 以上）がインストールされていること。

```bash
# 1. 依存関係のインストール（初回のみ）
npm install

# 2. 開発サーバーを起動
npm run dev
```

起動したら、ブラウザで表示された URL（例: `http://localhost:8787`）を開きます。

通話を試すには **2 つのブラウザタブ（またはウィンドウ）** で開き、
それぞれ別の名前で登録してください。片方でもう片方の ID を検索 → 友だち追加すると、
一覧にオンライン表示が出て通話ボタンから発信できます。

> 💡 マイクの利用には許可が必要です。ローカルの `localhost` と、本番の `https://` では
> マイクが使えます（`http://` の外部アドレスでは使えないので注意）。

## デプロイ

GitHub にプッシュすると、連携済みの Cloudflare Workers に自動デプロイされます。
**初回のみ Durable Object の設定に関する確認**が必要です。
手順は [`docs/DEPLOY.md`](docs/DEPLOY.md) に画面操作まで含めてまとめています。

## ディレクトリ構成

```
calling-feature/
├── wrangler.jsonc     # Worker の設定（静的配信 + Durable Object）
├── package.json       # スクリプトと wrangler
├── src/
│   └── worker.js      # Worker 本体 + Hub Durable Object
├── public/            # フロントエンド（そのまま配信される）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── docs/
│   ├── ARCHITECTURE.md
│   └── DEPLOY.md
├── CLAUDE.md          # 開発を引き継ぐ際のガイド
└── README.md
```

## 既知の制約

- **通話は無料の公開 STUN のみ**を使っています。多くの環境で繋がりますが、
  企業内ネットワークなど一部の厳しい環境では繋がらないことがあります
  （その場合は TURN サーバーの追加が必要）。
- **ログインにパスワードはありません**。ID と表示名を知っていれば復元できる簡易方式です。
- 個人利用・小規模利用を想定しています。
