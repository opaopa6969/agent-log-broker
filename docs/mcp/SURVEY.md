# MCP 化調査（Phase 1）— agent-log-broker

## 概要

**リポジトリ**: `agent-log-broker`（`@unlaxer/agent-log-broker` v0.1.0）
**種類**: library（npm パッケージとしての公開 API を持つ。HTTP API サーバーは未実装）
**調査日**: 2026-08-21

AskOS ワークスペースエコステムのセントラルログブローカー。LLM エージェント（Claude Code 等）の JSONL セッションログを `~/.claude/projects/` から監視し、PII リダクション・セキュリティフラグ付けを経て、登録済みコンシューマへファンアウト配信する。

設計原則: **"I am a pipe, not a judge."** — ログ内容を解釈せず、受信し、リダクションし、配信する。

### 現状の実装成熟度

7 つの責務のうち、Discover / Watch / Redact / Offset Track は実装済みだが、**パイプライン全体が未接続**:

| 責務 | 状態 |
|---|---|
| Discover | 実装済み（symlink 解決は未実装） |
| Watch | 実装済み（fs.watch, byte offset） |
| Parse | **未実装**（JSONL → AgentMessage 変換コードなし） |
| Redact | 実装済み（ただし distribute() から呼ばれない） |
| Flag | 部分実装（危険コマンドのみ、banned word なし） |
| Distribute | **スタブ**（deliverToConsumer が常に success:true を返す） |
| Offset Track | 実装済み（インメモリのみ） |

HTTP API サーバー（`/api/subscribe`, `/api/consumers` 等）は未実装。`src/index.ts` はモジュールの再エクスポートのみ。

volta catalog にはサービスとして登録済み（port 3100, wsl 環境）だが、MCP バックエンドは未所持、`volta.service.json` も未配置。

---

## 判定と理由

### 判定: `defer`（保留）

**根拠**:

1. **MCP 化の価値は描ける**: エージェントからの配信制御（コンシューマ登録・解除）、セッション状態の照会、リダクションの実行、ブローカー状態の監視という操作群は、tool として公開する意味がある。
2. **しかし動作する配信エンジンがない**: パイプラインが未接続（parse 未実装、deliverToConsumer がスタブ、HTTP API サーバー未実装）のため、MCP に公開できる操作対象が存在しない。
3. **Phase 1 完了が前提**: deliverToConsumer の実装、HTTP API サーバー立ち上げ、orchestrator によるパイプライン接続が完了してから再評価すべき。

### 再評価条件

- `deliverToConsumer` の実 HTTP POST 実装完了
- HTTP API サーバー（Express/Fastify）の立ち上げ
- パイプライン接続（orchestrator: watch → parse → redact → flag → match → distribute）
- JSONL → AgentMessage パースステージの実装

再評価時の想定判定: `wrap`（既存 HTTP API を薄く MCP tool として包む）

---

## 公開候補

| kind | name | io | 副作用 | 長時間 |
|---|---|---|---|---|
| tool | `discover_sessions` | `{ basePath?: string } → DiscoveredSession[]` | read | no |
| tool | `watch_session` | `{ sessionPath: string } → { started: boolean }` | write | no |
| tool | `unwatch_session` | `{ sessionPath: string } → { stopped: boolean }` | write | no |
| tool | `register_consumer` | `{ consumerId, callbackUrl, mode, filter?, trigger? } → Consumer` | write | no |
| tool | `unregister_consumer` | `{ consumerId } → { removed: boolean }` | write | no |
| tool | `list_consumers` | `{} → Consumer[]` | read | no |
| tool | `get_consumer_state` | `{ consumerId } → ConsumerState \| null` | read | no |
| tool | `redact_text` | `{ text, level? } → { redactedText, redactionCount, securityFlags }` | read | no |
| tool | `get_status` | `{} → { watchedSessions, consumers, consumerStates }` | read | no |
| resource | `spec` | `broker://spec` — 能力の機械可読仕様 | — | — |
| resource | `guide` | `broker://guide` — 使い方 | — | — |
| resource | `schema` | `broker://schema/broker-event` — BrokerEvent JSON Schema | — | — |
| resource | `lifecycle` | `broker://lifecycle` — コンシューマライフサイクル仕様 | — | — |
| skill | `operate-broker` | ログ監視ブローカーの運用手順 | — | — |

> 壊す系 tool（`watch_session`, `unwatch_session`, `register_consumer`, `unregister_consumer`）は `confirm: bool=false` を持ち、false なら dry-run とする。

---

## 組み合わせ例

1. `broker__discover_sessions → broker__watch_session → broker__register_consumer (mode=full_stream) → claude-session-replay が BrokerEvent を HTTP POST で受信して蓄積・再生`
2. `broker__register_consumer (mode=trigger, conditions=[{field:'securityFlags',op:'not_empty'}]) → securityFlags 検出時のみ Slack webhook へ配信`
3. `broker__redact_text → 問題のあるテキストを事前スキャンし、SecurityFlag を抽出 → askos__create_task でレビュータスクを起票`

---

## 依存と協調

| 相手 repo | 方向 | 能力 | 現在あるか | 備考 |
|---|---|---|---|---|
| `tramli` | depends_on | ConsumerState ライフサイクル管理（FlowDefinition / FlowEngine / InMemoryFlowStore） | yes | tramli は library として volta catalog に登録済み。MCP バックエンド未所持。`ConsumerRegistry` が直接 import して使用。 |
| `claude-session-replay` | provides_to | BrokerEvent の full_stream 配信（コンシューマとして受信） | no | volta catalog にサービス登録済み（docker で稼働）。ブローカーの HTTP API が未実装のため未接続。Phase 1 完了後に接続予定。 |
| `AskOS` | provides_to | BrokerEvent の filtered 配信（コンシューマとして受信） | no | volta catalog にサービス登録済み（systemd で稼働）。ブローカーの HTTP API が未実装のため未接続。 |
| `issue-broker` | depends_on | issue-broker MCP server（.mcp.json で stdio クライアントとして設定済み） | yes | `.mcp.json` に issue-broker を stdio で登録済み。開発時の issue 管理に使用。agent-log-broker 自体の MCP 化とは無関係だが、issue-hub 協調で Phase 2 が使う可能性あり。 |

---

## ライブラリのサーバ化

本リポジトリは library として実装されているが、MCP 化には常駐サーバ化が必要。

### 必要な新規実装

| 項目 | 詳細 |
|---|---|
| HTTP API サーバー | Express/Fastify で `/mcp`, `/healthz` エンドポイントを実装 |
| PORT 環境変数 | `0.0.0.0` bind、`PORT` 環境変数でポート指定 |
| `volta.service.json` | manifest をリポジトリ root に配置 |
| systemd unit / docker | 常駐起動の設定 |
| MCP server | `@modelcontextprotocol/sdk` 等で MCP server を新規実装 |
| パイプライン接続 | orchestrator: watch → parse → redact → flag → match → distribute |
| parse ステージ | JSONL → AgentMessage 変換コードの実装 |
| deliverToConsumer | 実 HTTP POST 実装（タイムアウト・リトライ付き） |
| confirm パラメータ | 壊す系 tool に `confirm: bool=false` を付与 |

### 推定規模: L

Phase 1 の既存 TODO（parse, HTTP API, orchestrator, deliverToConsumer）と MCP 化の新規実装が重なるため、工数は大。

---

## リスク

- **パイプライン未接続**: 現状では MCP 化しても動作する配信エンジンがない。Phase 1 実装が前提。
- **PII リダクションの取り扱い**: `redact_text` tool は read-only だが、元テキストがエージェントのコンテキストに残る点に注意。
- **オフセットのインメモリ限定**: プロセス再起動で全セッションを再読み込み → コンシューマに重複イベントが配信される。冪等性はコンシューマ側で担保が必要。
- **破壊的操作**: `unwatch_session`, `unregister_consumer` は稼働中の配信を停止する。`confirm` パラメータを必須とする。
- **シンボリックリンク未解決**: `projectPath` がハッシュ文字列のまま。フィルタリング時の指定が直感と異なる可能性。
- **trigger 条件評価スタブ**: trigger モードのコンシューマは現在機能しない。

---

## 持ち主への質問

1. Phase 1（parse, HTTP API, orchestrator, deliverToConsumer 実装）はいつ完了するか？完了後に再評価が必要。
2. MCP 化する場合、既存の HTTP API（Phase 1 で計画中の `/api/subscribe` 等）をそのまま MCP tool として薄く包む（wrap）形にするか、MCP 専用の tool 実装を書くか？
3. namespace は `broker` で確定か？volt catalog ではサービス ID が `agent-log-broker` だが、MCP namespace として `broker` は適切か？（`catalog`/`probe`/`skill` は予約語）
4. `redact_text` tool を単独で公開する場合、ブローカーの設計原則（pipe, not judge）と整合するか？
5. `claude-session-replay` と `AskOS` が MCP バックエンドを取得した後、ブローカー自体の MCP 化優先度はどう変わるか？（コンシューマ側が MCP で直接 BrokerEvent を受信できる形があれば、ブローカー自体の MCP 化は不要になる可能性も）
