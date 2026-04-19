[English version](README.md)

# agent-log-broker

AskOS ワークスペースエコシステムの中央ログブローカー — Claude セッションログを複数コンシューマーへファンアウト配信する。

> **設計哲学: 「俺はパイプであって、裁判官じゃない」**
> Broker はログの内容を理解しない。受け取り、必要なら PII をマスクし、配信するだけ。

---

## 目次

- [何をするか](#何をするか)
- [エコシステムにおける位置づけ](#エコシステムにおける位置づけ)
- [サブスクリプションモード](#サブスクリプションモード) — full\_stream / filtered / trigger
- [コンシューマーライフサイクル](#コンシューマーライフサイクル) — tramli ステートマシン
- [tramli 統合](#tramli-統合)
- [session-replay / replayer 連携](#session-replay--replayer-連携)
- [既知の制限事項](#既知の制限事項)
- [開発](#開発)
- [ロードマップ](#ロードマップ)

---

## 何をするか

agent-log-broker は `~/.claude/projects/` 以下の JSONL ログファイルを監視し、各行を共通の `AgentMessage` モデルに変換、`BrokerEvent` エンベロープに包んで、登録済みコンシューマーのサブスクリプションモードに従いファンアウト配信する。

Broker の7つの責務:

| 責務 | 説明 |
|---|---|
| Discover | ベースパス配下のエージェントログファイルを検出 |
| Watch | `fs.watch` でファイル変更を検知 |
| Parse | 生 JSONL 行を `AgentMessage` に変換 |
| Redact | PII をマスク（minimal / standard / strict） |
| Flag | 危険コマンドと禁止語を検出 |
| Distribute | マッチするコンシューマーへ `BrokerEvent` をファンアウト |
| Offset Track | 各ファイルをどこまで読んだか記憶 |

---

## エコシステムにおける位置づけ

```
Agent (Claude Code, Codex, Gemini, ...)
  │
  │  JSONL ログファイル出力
  ▼
┌──────────────────────────────┐
│      agent-log-broker        │
│                              │
│  Discover → Watch → Parse    │
│  → Redact → Flag             │
│  → Distribute                │
└────────────┬─────────────────┘
             │ fan-out
             ├──→ AskOS            (filtered: 進捗・異常のみ)
             ├──→ session-replay   (full_stream: 全メッセージ蓄積・再生)
             ├──→ Slack webhook    (trigger: セキュリティアラートのみ)
             └──→ Dashboard        (filtered: メタデータのみ)
```

---

## サブスクリプションモード

### full\_stream

全セッションの全イベントを受け取る。`session-replay` が使用。

```json
{
  "consumerId": "session-replay",
  "callbackUrl": "http://localhost:4200/broker/events",
  "mode": "full_stream"
}
```

### filtered

プロジェクトパス・エージェント種別・ロール・フィールド条件に合致するイベントのみ受け取る。AskOS が使用。

```json
{
  "consumerId": "askos",
  "callbackUrl": "http://localhost:3000/broker/events",
  "mode": "filtered",
  "filter": {
    "projectPath": "/home/opa/work/my-project",
    "includeRoles": ["assistant"],
    "includeFields": ["toolUses", "text", "securityFlags"],
    "excludeFields": ["toolResults", "thinking"],
    "redactionLevel": "standard"
  }
}
```

### trigger

特定条件に合致したときだけ発火。Slack webhook が使用。

```json
{
  "consumerId": "slack-security",
  "callbackUrl": "https://hooks.slack.com/...",
  "mode": "trigger",
  "trigger": {
    "conditions": [
      { "field": "securityFlags", "op": "not_empty" }
    ],
    "throttleSeconds": 300
  }
}
```

> **注意**: trigger 条件評価は現在の実装ではスタブ状態（Phase 2 作業）。

---

## コンシューマーライフサイクル

各コンシューマーのヘルス状態は [tramli](https://github.com/opaopa6969/tramli) ステートマシンで管理される:

```
INITIALIZING ──auto──> HEALTHY
HEALTHY      ──external(配信結果)──> ASSESSING
UNHEALTHY    ──external(配信結果)──> ASSESSING
ASSESSING    ──branch──> HEALTHY | UNHEALTHY | DEAD
DEAD         ──external(cleanup)──> REMOVED
任意エラー   ──> DEAD
```

`ASSESSING` でのブランチロジック:
- 配信成功 → `HEALTHY`（エラーカウントリセット）
- エラー数 < `errorThreshold`（デフォルト 3）→ `HEALTHY` を維持（エラーカウントインクリメント）
- エラー数 >= `errorThreshold` → `UNHEALTHY`
- エラー数 >= `maxRetries`（デフォルト 10）→ `DEAD`

ステートマシン全仕様は [docs/consumer-lifecycle.md](docs/consumer-lifecycle.md) を参照。

---

## tramli 統合

コンシューマーライフサイクルは tramli の `FlowDefinition<ConsumerState>` として実装されている。tramli がビルド時に保証するもの:

- 全ステートにプロセッサまたはガードが定義されている
- `flowKey` の依存関係が読み取り前に必ず満たされている
- 不正な遷移が構造的に存在できない

`ConsumerRegistry` は `InMemoryFlowStore` と共有 `FlowEngine` を使用する。登録された各コンシューマーは独自の `FlowInstance` を持つ。

```typescript
import { ConsumerRegistry } from "@unlaxer/agent-log-broker";

const registry = new ConsumerRegistry({ errorThreshold: 3, maxRetries: 10 });
const consumer = await registry.register("my-consumer", "http://localhost:9000/events");
// consumer.status === "HEALTHY"

await registry.recordDelivery("my-consumer", false); // ASSESSING をトリガー
```

---

## session-replay / replayer 連携

`session-replay`（claude-session-replay）はこのブローカーのファーストクラスコンシューマーとして動作する:

- **従来**: session-replay がログファイルを直接読み、独自のパース・オフセット管理をしていた。
- **今後**: Broker が検出・監視・パース・配信を担当し、session-replay は `BrokerEvent` を HTTP POST で受け取り、蓄積と UI に専念する。

ログフォーマットアダプター（`claude-log2model`、`codex-log2model` 等）は session-replay から Broker のアダプター層に移行する。

`BrokerEvent` スキーマ（`schemas/broker-event.schema.json`、JSON Schema Draft 2020-12）が Broker とコンシューマー間の契約。フィールド全仕様は [docs/architecture.md](docs/architecture.md) を参照。

---

## 既知の制限事項

| 制限事項 | 詳細 |
|---|---|
| `deliverToConsumer` はスタブ | HTTP POST 配信は未実装。現在は無条件で `success: true` を返す。Phase 1 作業。 |
| FileWatcher オフセットはインメモリ | プロセス再起動でオフセットが失われる。起動時にオフセット 0 からセッションが再読み込みされる。永続オフセットストアは Phase 2 作業。 |
| symlink 解決が未完成 | `discoverSessions()` は `projectPath` にディレクトリハッシュをそのまま返す。実際のプロジェクトパスへの symlink 解決は未実装。 |
| trigger 評価はスタブ | `matchesTrigger()` は常に `false` を返す。Phase 2 作業。 |

---

## 開発

```bash
npm install
npm run build       # TypeScript コンパイル
npm run dev         # 監視モード（tsx）
npm test            # Vitest
npm run typecheck   # tsc --noEmit
```

### プロジェクト構成

```
src/
├── broker/
│   ├── core.ts          # BrokerCore — ファンアウトエンジン
│   ├── subscription.ts  # SubscriptionManager + BrokerEvent 型定義
│   └── lifecycle.ts     # （予約）
├── consumers/
│   ├── types.ts         # Consumer, ConsumerState, DeliveryResult
│   ├── lifecycle.ts     # tramli FlowDefinition<ConsumerState>
│   └── registry.ts      # ConsumerRegistry（tramli バックエンド）
├── adapters/
│   └── file-watcher.ts  # FileWatcher — JSONL テールアダプター
├── security/
│   └── redaction.ts     # RedactionPipeline
└── index.ts             # 公開 API エクスポート

schemas/
└── broker-event.schema.json  # JSON Schema Draft 2020-12
```

---

## ロードマップ

### Phase 1 — ファイルウォッチャー + 基本ファンアウト（現在）

- [x] `FileWatcher` — `~/.claude/projects/` JSONL 監視
- [x] `BrokerCore.distribute()` — `Promise.allSettled` ファンアウト
- [x] `SubscriptionManager` — full\_stream + filtered マッチング
- [x] `ConsumerRegistry` — tramli バックエンドライフサイクル
- [x] `RedactionPipeline` — PII マスク + セキュリティフラグ
- [x] `BrokerEvent` JSON Schema（Draft 2020-12）
- [ ] `deliverToConsumer` — 実際の HTTP POST（現在スタブ）
- [ ] 永続オフセットストア

### Phase 2 — サブスクリプション管理 + セキュリティ

- [ ] trigger 条件評価
- [ ] DLQ（Dead Letter Queue）+ リトライ
- [ ] コンシューマーヘルスチェックエンドポイント
- [ ] 永続オフセットストア

### Phase 3 — エンタープライズ機能

- [ ] OIDC 認証
- [ ] Webhook 配信フォーマット（Slack テンプレート）
- [ ] auto-discover モード（全エージェント自動検出）
- [ ] キャッチアップ（過去ログ再送）
- [ ] 管理 API（`/api/status`、`/api/watch`、`/api/sessions`）

---

## ライセンス

UNLICENSED
