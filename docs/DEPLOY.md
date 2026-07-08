# デプロイ手順（初心者向け・画面操作つき）

このドキュメントは、開発に不慣れな方でも Callin を Cloudflare Workers に公開できるよう、
**GitHub と Cloudflare の操作を一つずつ**説明します。

前提:
- GitHub と Cloudflare Workers は **すでに連携済み**（このリポジトリにプッシュすると自動でデプロイされる状態）
- Cloudflare のアカウントにログインできる

---

## 全体の流れ

```
①コードを GitHub にプッシュ
       ↓
②Cloudflare が自動でビルド＆デプロイ
       ↓
③（初回のみ）Durable Object の設定を確認
       ↓
④公開URLをスマホ等で開いて動作確認
```

---

## ① コードを GitHub にプッシュする

ターミナル（コマンドを打つ画面）で、このプロジェクトのフォルダに移動して以下を実行します。

```bash
# 変更をすべてステージに追加
git add -A

# コミット（変更の記録）。メッセージは自由でOK
git commit -m "音声通話アプリを実装"

# GitHub へアップロード
git push
```

> 💡 このプロジェクトの開発用ブランチは `claude/line-calling-app-4urn4x` です。
> 通常はこのブランチにプッシュします。

プッシュが成功すると、GitHub のリポジトリのページに変更が反映されます。

---

## ② Cloudflare が自動でデプロイする

GitHub と Cloudflare Workers が連携済みなら、プッシュした瞬間に**自動でビルドとデプロイ**が始まります。

確認方法:

1. ブラウザで [Cloudflare ダッシュボード](https://dash.cloudflare.com/) を開く
2. 左メニューの **「Compute (Workers)」**（または「Workers & Pages」）をクリック
3. `calling-feature` という名前のプロジェクトをクリック
4. **「Deployments」** タブを開くと、デプロイの進行状況・成功/失敗が見られます

デプロイが成功すると、`https://calling-feature.<あなたのサブドメイン>.workers.dev` のような
**公開URL** が発行されます（プロジェクトの画面上部に表示されます）。

### もしビルド設定を聞かれたら

連携直後などで、Cloudflare 側にビルド設定を求められた場合は次のように設定します:

| 項目 | 値 |
| --- | --- |
| Build command（ビルドコマンド） | 空でOK（または `npm install`） |
| Deploy command（デプロイコマンド） | `npx wrangler deploy` |
| ルートディレクトリ | `/`（このリポジトリの直下） |

`wrangler.jsonc` に設定がすべて書いてあるので、基本はこれだけで動きます。

---

## ③ （初回のみ）Durable Object の確認

このアプリは通話とデータ保存に **Durable Object（SQLite）** を使っています。
`wrangler.jsonc` に以下の設定があり、初回デプロイ時に Cloudflare が自動で作成します。

```jsonc
"durable_objects": {
  "bindings": [{ "name": "HUB", "class_name": "Hub" }]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Hub"] }
]
```

- 通常は**何もしなくても**初回デプロイ時にセットアップされます。
- もしデプロイが「Durable Object のマイグレーションが必要」といったエラーで失敗した場合は、
  上記の `migrations` の記述があることを確認してください（このリポジトリには既に入っています）。
- **`new_sqlite_classes` を使うのが重要**です（無料プランで動かすための条件）。
  `new_classes`（SQLite なし）だと無料プランでは動きません。

デプロイ後、ダッシュボードの `calling-feature` プロジェクト →
**「Settings」→「Bindings」** に `HUB`（Durable Object）が表示されていれば成功です。

---

## ④ 公開URLで動作確認

1. 発行された公開URL（`https://calling-feature.xxx.workers.dev`）をブラウザで開く
2. 表示名を入れて登録 → 自分の ID が発行される
3. **別の端末（スマホなど）** でも同じURLを開いて、別の名前で登録
4. 片方の端末で、もう片方の ID を検索 → 友だち追加
5. 友だち一覧に相手が「オンライン」で表示されたら、📞ボタンで発信
6. 相手の端末で着信 → 応答すると音声が繋がります

> 💡 **マイクの許可**: 初回に「マイクを使用しますか？」と聞かれるので「許可」を選んでください。
> 公開URLは `https://` なのでマイクが使えます（`http://` だとブラウザがマイクをブロックします）。

---

## ローカルで試したいとき

公開せずに手元で動かす場合:

```bash
npm install   # 初回のみ
npm run dev   # 開発サーバー起動
```

表示された `http://localhost:8787` をブラウザの2つのタブで開いて試せます
（`localhost` はマイクが使えます）。

---

## うまくいかないときは

| 症状 | 確認すること |
| --- | --- |
| デプロイが失敗する | ダッシュボードの Deployments のログを確認。`wrangler.jsonc` の記述が正しいか |
| マイクが使えない | URLが `https://` か `localhost` か。ブラウザのマイク許可設定 |
| 友だちがオフラインのまま | 相手がそのURLを開いているか。ページを再読み込みして再接続 |
| 通話が繋がらない | 双方のネットワーク環境。厳しいネットワークでは STUN のみだと繋がらないことがある |

---

## 補足: このアプリのデプロイの仕組み

- フロント（`public/`）もサーバー（`src/worker.js`）も **1 つの Worker** にまとまっています。
- `npx wrangler deploy` が `wrangler.jsonc` を読み、静的ファイルと Worker コードをまとめてアップロードします。
- Durable Object はコード内の `Hub` クラスとして定義され、Cloudflare 上で永続的に動きます。
