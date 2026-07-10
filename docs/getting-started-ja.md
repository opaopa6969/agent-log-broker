[English version](getting-started.md)

# はじめに

## 前提条件

- Node.js 20+
- npm 10+
- Claude Code（または `~/.claude/projects/` に JSONL ログを書き出すエージェント）

---

## インストール

```bash
# リポジトリをクローン
git clone https://github.com/opaopa6969/agent-log-broker.git
cd agent-log-broker

# 依存関係をインストール
npm install

# TypeScript をビルド
npm run build
```

---

## クイックスタート

### 1. Broker を起動する

```bash
npm run dev
```

> **注意**: `npm run dev` は `tsx watch src/index.ts` を実行するだけで、型チェックと変更時の再ビルドを行うにすぎない。`src/index.ts` は公開 API を再エクスポートするだけで**実行時の副作用が一切無い** — したがって Broker プロセスは起動せず、`~/.claude/projects/` の監視も始まらない。実行可能なエントリポイント（および下記の HTTP API）は Phase 1 作業。現時点で各構成要素を動かすには、`FileWatcher` / `ConsumerRegistry` をコードから直接駆動すること（下記セクション参照）。

### 2. コンシューマーを登録する

サブスクリプション定義を `POST /api/subscribe` で送信する。

**full\_stream** — 全イベントを受信:

```bash
curl -X POST http://localhost:3100/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "consumerId": "my-consumer",
    "callbackUrl": "http://localhost:9000/events",
    "mode": "full_stream"
  }'
```

**filtered** — 特定プロジェクトのアシスタントメッセージのみ受信:

```bash
curl -X POST http://localhost:3100/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "consumerId": "askos",
    "callbackUrl": "http://localhost:3000/broker/events",
    "mode": "filtered",
    "filter": {
      "projectPath": "/home/opa/work/my-project",
      "includeRoles": ["assistant"],
      "includeFields": ["toolUses", "text", "securityFlags"],
      "redactionLevel": "standard"
    }
  }'
```

**trigger** — セキュリティフラグが発生したときだけ発火:

```bash
curl -X POST http://localhost:3100/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "consumerId": "slack-security",
    "callbackUrl": "https://hooks.slack.com/services/...",
    "mode": "trigger",
    "trigger": {
      "conditions": [
        { "field": "securityFlags", "op": "not_empty" }
      ],
      "throttleSeconds": 300
    }
  }'
```

> **注意**: HTTP API サーバーはまだ実装されていない。型定義とサブスクリプションデータモデルは用意されているが、Express/Fastify サーバー層は Phase 1 作業。現時点では `ConsumerRegistry` をコードから直接使用すること。

### 3. イベントを受信する

コンシューマーは登録した `callbackUrl` で `POST` リクエストを受け付ける必要がある。

リクエストボディは `BrokerEvent` オブジェクト:

```json
{
  "_broker": {
    "version": "1.0",
    "messageId": "b1c2d3e4-...",
    "deliveredAt": "2026-04-19T10:00:00.000Z",
    "deliveryAttempt": 1
  },
  "_session": {
    "sessionId": "abc123",
    "sessionPath": "/home/opa/.claude/projects/-home-opa-work-my-project/sessions/abc123/log.jsonl",
    "projectPath": "-home-opa-work-my-project",
    "agentType": "claude"
  },
  "_index": {
    "messageIndex": 5,
    "byteOffset": 1024
  },
  "type": "message",
  "message": {
    "role": "assistant",
    "text": "ファイルを作成します。",
    "toolUses": [...],
    "timestamp": "2026-04-19T09:59:58.000Z"
  },
  "securityFlags": []
}
```

成功時は `2xx`、一時的エラーは `5xx`（リトライされる）、永続エラーは `4xx`（スキップされる）を返すこと。

---

## ConsumerRegistry を直接使う

```typescript
import { ConsumerRegistry } from "@unlaxer/agent-log-broker";

const registry = new ConsumerRegistry({
  errorThreshold: 3,   // UNHEALTHY になるまでのエラー数
  maxRetries: 10,      // DEAD になるまでのエラー数
});

// コンシューマーを登録
const consumer = await registry.register(
  "my-consumer",
  "http://localhost:9000/events"
);
console.log(consumer.status); // "HEALTHY"

// 配信結果を記録
await registry.recordDelivery("my-consumer", true);   // 成功
await registry.recordDelivery("my-consumer", false);  // 失敗

// ヘルス状態を確認
const state = registry.getState("my-consumer");
// "HEALTHY" | "UNHEALTHY" | "DEAD" | ...

// 全コンシューマーを一覧表示
const all = registry.list();

// 死亡したコンシューマーを削除
await registry.remove("my-consumer"); // DEAD 状態からのみ動作
```

---

## FileWatcher を直接使う

```typescript
import { FileWatcher } from "@unlaxer/agent-log-broker";

const watcher = new FileWatcher({
  basePath: "/home/opa/.claude/projects",  // デフォルト値
  scanIntervalSeconds: 30,
});

// 既存セッションを検出
const sessions = await watcher.discoverSessions();
for (const session of sessions) {
  console.log(session.sessionId, session.sessionPath);

  // 新しい行を監視
  watcher.watchSession(session.sessionPath, (line, offset) => {
    const parsed = JSON.parse(line);
    console.log("offset", offset, "での新しい行:", parsed);
  });
}

// 特定セッションの監視を停止
watcher.unwatchSession(sessions[0].sessionPath);

// 全監視を停止
watcher.close();
```

> **注意**: オフセットはインメモリのみ。再起動後は全セッションが先頭から再読み込みされる。

---

## 開発コマンド

```bash
npm run build       # TypeScript コンパイル（tsc）
npm run dev         # 監視モード（tsx watch）
npm test            # Vitest
npm run typecheck   # エミットなしの型チェック
```

---

## 次のステップ

- [アーキテクチャ](architecture-ja.md) — BrokerCore、FileWatcher、BrokerEvent スキーマ
- [コンシューマーライフサイクル](consumer-lifecycle-ja.md) — tramli ステートマシンリファレンス
- [設計決定](decisions/) — tramli 採用理由、JSON Schema Draft 2020-12 採用理由
