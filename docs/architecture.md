# アーキテクチャ概要

## 設計原則

Agent Log Broker は以下の原則に基づいて設計されています。

### 1. Broker はパイプである

Broker の責務は 7 つだけ:

| 責務 | 説明 |
|------|------|
| Discover | エージェントのログファイルの場所を見つける |
| Watch | ファイル変更を検知する |
| Parse | JSONL を共通モデルに変換する |
| Redact | PII をマスクする |
| Flag | セキュリティ/禁止語の検出、フラグ付与 |
| Distribute | コンシューマーにファンアウト配信する |
| Offset Track | どこまで読んだかを記憶する |

Broker が **やらないこと**:
- ログの永続化保存（コンシューマーの仕事）
- エージェントの制御（AskOS の仕事）
- UI 表示（session-replay の仕事）
- 判断・意思決定（コンシューマーの仕事）

### 2. エージェント非依存（BRK-AGENT-AGNOSTIC）

エージェントに変更を要求しない。ログファイルを外から読むだけ。
新しいエージェントの追加はアダプターを書くだけで対応可能。

### 3. 障害耐性

- Broker が落ちてもエージェントは動く。データは失われない
- 1 コンシューマーが落ちても他のコンシューマーへの配信は続く
- オフセット追跡により crash 復旧時に未読分から再開

## モジュール構成

```
src/
├── broker/
│   ├── core.ts              # ファンアウトエンジン
│   │                        # イベント受信 → フィルタ適用 → 配信
│   └── subscription.ts      # サブスクリプションモデル
│                            # full_stream / filtered / trigger
├── consumers/
│   ├── types.ts             # コンシューマーコールバック契約
│   │                        # POST callback_url → 2xx/4xx/5xx
│   └── registry.ts          # コンシューマー登録・ヘルス管理
│
├── adapters/
│   └── file-watcher.ts      # ファイル監視アダプター
│                            # ~/.claude/projects/ の JSONL 監視
│                            # discover_sessions + watch + parse_line
└── security/
    └── redaction.ts          # Redaction パイプライン
                             # PII マスク + セキュリティフラグ付与
```

## データフロー

```
[JSONL ファイル]
       │
       ▼
  FileWatcher.watchSession()
       │  新しい行を検出
       ▼
  Parse (JSONL → AgentMessage)
       │
       ▼
  RedactionPipeline.process()
       │  PII マスク + セキュリティフラグ付与
       ▼
  BrokerEvent 生成 (envelope + session meta + message)
       │
       ▼
  SubscriptionManager.matches()
       │  各コンシューマーのフィルタ/トリガーを評価
       ▼
  BrokerCore.distribute()
       │  マッチしたコンシューマーに並行配信
       ▼
  [Consumer callback POST]
       │
       ├── 2xx → 成功 → ConsumerRegistry.recordDelivery(true)
       ├── 5xx → リトライ (3回) → 失敗 → DLQ
       └── 4xx → 永続エラー → スキップ
```

## プロトコル

### Broker -> Consumer メッセージフォーマット

全メッセージは `BrokerEvent` エンベロープで包まれる:

- `_broker`: バージョン、メッセージID、配信タイムスタンプ、配信試行回数
- `_session`: セッションID、セッションパス、プロジェクトパス、エージェント種別
- `_index`: メッセージインデックス、バイトオフセット
- `type`: イベント種別（message / session.discovered / session.idle / session.lost）
- `message`: エージェントメッセージ本体（role, text, toolUses, etc.）
- `securityFlags`: セキュリティフラグ配列
- `bannedWordHits`: 禁止語ヒット配列

### Consumer -> Broker API

```
POST   /api/subscribe            # コンシューマー登録
DELETE /api/subscribe/:id        # コンシューマー解除
GET    /api/subscribe/:id        # コンシューマー状態確認
POST   /api/subscribe/:id/retry-dlq  # DLQ 再送

POST   /api/watch                # ウォッチ追加
DELETE /api/watch                # ウォッチ削除
GET    /api/watch                # ウォッチ一覧

GET    /api/status               # 全体状態
GET    /api/sessions             # 検出済みセッション一覧
```

## Redaction レベル

| レベル | 対象 |
|--------|------|
| minimal | PII パターンのみ（SSN, email, phone） |
| standard | PII + credential + secret |
| strict | PII + credential + secret + file path |

## セッションライフサイクルイベント

- `session.discovered`: 新しいセッションの JSONL ファイルを検出
- `session.idle`: N 分間ファイルが更新されていない
- `session.lost`: JSONL ファイルが削除/移動された
