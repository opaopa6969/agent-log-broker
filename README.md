# Agent Log Broker

AskOS ワークスペースエコシステムの中央ログブローカー。

## 概要

Agent Log Broker は LLM エージェントのログを受信し、複数のコンシューマーにファンアウト配信するサービスです。

**設計哲学: 「俺はパイプであって、裁判官じゃない」**

Broker はログの内容を理解しません。入力を受け取り、出力するだけです。
唯一の例外は **Redaction（PII マスク）** と **Security Flagging（危険操作の検出・フラグ付与）** です。

## エコシステムにおける位置づけ

```
Agent (Claude Code, Codex, Gemini...)
  │
  │  JSONL ログファイル出力
  ▼
┌─────────────────────────┐
│   Agent Log Broker      │
│                         │
│  ・Discover (ログ検出)   │
│  ・Watch (変更検知)      │
│  ・Parse (共通モデル変換) │
│  ・Redact (PII マスク)   │
│  ・Flag (セキュリティ)   │
│  ・Distribute (配信)     │
└────────┬────────────────┘
         │ fan-out
         ├──→ AskOS (進捗・異常のみ)
         ├──→ session-replay UI (全メッセージ蓄積・再生)
         ├──→ Slack (セキュリティアラートのみ)
         └──→ Dashboard (メタデータのみ)
```

## 3つのサブスクリプションモデル

### 1. Full Stream (全メッセージ受信)

session-replay が使用。全エージェントの全メッセージをそのまま受け取る。

```json
{
  "mode": "full_stream",
  "consumer_id": "session-replay"
}
```

### 2. Filtered (条件付き受信)

AskOS が使用。特定プロジェクトの特定ロール・フィールドだけを受け取る。

```json
{
  "mode": "filtered",
  "filter": {
    "projectPath": "/home/opa/work/my-project",
    "includeRoles": ["assistant"],
    "includeFields": ["toolUses", "text", "securityFlags"],
    "excludeFields": ["toolResults", "thinking"]
  }
}
```

### 3. Trigger (条件発火)

Slack webhook が使用。セキュリティアラートなど特定条件に合致したときだけ通知。

```json
{
  "mode": "trigger",
  "trigger": {
    "conditions": [
      { "field": "securityFlags", "op": "not_empty" }
    ],
    "throttleSeconds": 300
  }
}
```

## claude-session-replay との関係

`claude-session-replay` は Broker のコンシューマーとして動作します:

- **従来**: session-replay が直接ログファイルを読んでいた
- **今後**: Broker が読み取り・パース・配信を担当し、session-replay は受信側（UI + 蓄積）に専念

session-replay のアダプター（claude-log2model, codex-log2model 等）は Broker のアダプター層に移行します。

## ロードマップ

### Phase 1: ファイルウォッチャー + 基本ファンアウト

- `~/.claude/projects/` の JSONL ファイル監視
- 基本的なパース（JSONL -> 共通モデル）
- シンプルなコンシューマー登録と配信
- オフセット追跡（どこまで読んだか記憶）

### Phase 2: サブスクリプション管理 + セキュリティ

- 3つのサブスクリプションモデル（full_stream / filtered / trigger）
- Redaction パイプライン（minimal / standard / strict）
- Security flagging（危険コマンド検出）
- DLQ（Dead Letter Queue）とリトライ
- コンシューマーヘルスチェック

### Phase 3: エンタープライズ機能

- DLS（Document Level Security）
- OIDC 認証
- Webhook 配信
- auto-discover モード（全エージェント自動検出）
- キャッチアップ（過去ログ再送）
- 管理 API (`/api/status`, `/api/watch`, `/api/sessions`)

## 開発

```bash
npm install
npm run build       # TypeScript コンパイル
npm run dev         # 開発モード（ホットリロード）
npm test            # テスト実行
npm run typecheck   # 型チェック
```

## ライセンス

UNLICENSED
