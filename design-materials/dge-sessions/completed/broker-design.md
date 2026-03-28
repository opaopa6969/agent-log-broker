# Agent Log Broker — 会話劇 × Protocol × API 設計

## この文書の目的

Agent Log Broker の設計を以下の視点で会話劇にして、
Protocol と API を策定する。

```
視点:
  1. Broker 自身の心（何を責務とし、何をしないか）
  2. Consumer の心（AskOS, Replay, Slack, Dashboard それぞれの欲求）
  3. Agent の心（何を出力し、Broker にどう見つけられるか）
  4. Operator の心（何を見たいか、何を制御したいか）
  5. 障害時のシチュエーション（誰が落ちても全体が壊れない）
```

---

## Part 1: Broker 自身の心 —「俺は配達員であって、中身は読まない」

### Scene 1: Broker の設計哲学

```
broker: 俺の仕事は 3 つだけ。

    1. Agent のログファイルを見つける (Discover)
    2. 新しい行が追加されたら読む (Watch)
    3. 読んだ行を consumer に配る (Distribute)
    
    俺がやらないこと:
    ・中身の意味を理解する → consumer の仕事
    ・agent を制御する → AskOS の仕事
    ・ログを永続化する → consumer か OpenSearch の仕事
    ・UI を持つ → session-replay の仕事
    
    俺は「パイプ」。入力を受け取って出力する。
    判断しない。蓄積しない。制御しない。

operator: でも redaction は broker でやるべきでしょ？
    PII が consumer に流れるのは防ぎたい。

broker: 確かに。redaction だけは俺がやる。
    全 consumer に redacted data が行く方が安全。
    
    あと security analysis も俺がやった方がいい。
    flag を付けるだけで、判断はしない。
    
    整理すると:
    
    ✅ 俺がやること:
    ・discover (agent log の場所を見つける)
    ・watch (ファイル変更を検知)
    ・parse (JSONL → common model に変換)
    ・redact (PII マスク)
    ・flag (security/banned word の検出、flag 付与)
    ・distribute (consumer に fan-out)
    ・offset tracking (どこまで読んだか記憶)
    
    ❌ 俺がやらないこと:
    ・ログの永続化保存
    ・agent の制御（start/stop）
    ・UI 表示
    ・判断・意思決定
    ・consumer の health check（consumer 側の責務）
```

### Scene 2: Subscription モデル

```
operator: consumer の受け取り方は何パターンある？

broker: 3 つのモデルを用意する。

    ── Model A: Full stream (全部受け取る) ──
    
    session-replay が使う。全メッセージを受け取って蓄積・再生。
    
    POST /api/subscribe {
      "consumer_id": "session-replay",
      "callback_url": "http://localhost:5100/api/ingest",
      "mode": "full_stream"
    }
    → 全 agent の全メッセージが流れる
    
    
    ── Model B: Filtered stream (条件付き受信) ──
    
    AskOS が使う。特定の agent の特定の event だけ受け取る。
    
    POST /api/subscribe {
      "consumer_id": "askos-agent-01",
      "callback_url": "http://localhost:3000/api/agents/agt_01/session-events",
      "mode": "filtered",
      "filter": {
        "project_path": "/home/opa/work/unlaxer-common",
        "agent_types": ["claude", "codex"],
        "include_roles": ["assistant"],
        "include_fields": ["tool_uses", "text", "security_flags"],
        "exclude_fields": ["tool_results", "thinking"]
      }
    }
    → unlaxer-common の assistant メッセージだけ。
      tool_use と text だけ。thinking は送らない。
    
    
    ── Model C: Trigger (条件発火) ──
    
    Slack webhook が使う。特定の条件に合致したときだけ通知。
    
    POST /api/subscribe {
      "consumer_id": "slack-security",
      "callback_url": "https://hooks.slack.com/services/xxx",
      "mode": "trigger",
      "trigger": {
        "conditions": [
          { "field": "security_flags", "op": "not_empty" },
          { "field": "security_flags[].severity", "op": "in", "value": ["high", "critical"] }
        ],
        "throttle_seconds": 60,
        "format": "slack"
      }
    }
    → security_flags に high/critical が含まれるときだけ Slack に通知。
      60 秒以内に同じ条件で再発火しない (throttle)。

operator: AskOS は agent ごとに subscribe するの？
    10 体の agent がいたら 10 個 subscribe する？

broker: 2 つの方法がある:

    a) Agent ごとに subscribe (粒度が細かい)
       → 各 agent の callback_url が違う
       → AskOS が agent 起動のたびに subscribe
    
    b) Project ごとに subscribe (粒度が粗い)
       → project_path でフィルタ
       → message に session metadata が付くので
         AskOS 側で agent を特定
    
    推奨は b)。AskOS が 1 project に 1 subscribe。
    message の session metadata から agent を特定する方がシンプル。
    
    POST /api/subscribe {
      "consumer_id": "askos-unlaxer",
      "callback_url": "http://localhost:3000/api/broker/events",
      "mode": "filtered",
      "filter": {
        "project_path": "/home/opa/work/unlaxer-common"
      }
    }
    
    broker が送る message:
    {
      "session_id": "abc123",
      "session_path": "/home/opa/.claude/projects/xxxx/sessions/yyy/log.jsonl",
      "project_path": "/home/opa/work/unlaxer-common",
      "agent_type": "claude",
      "message": { ... common model message ... }
    }
    
    AskOS 側が session_path or project_path から agent_id を逆引き。
```

### 発見

- **BRK-THREE-MODELS**: full_stream, filtered, trigger の 3 subscription モデル
- **BRK-FILTER-FIELDS**: include/exclude で送信フィールドを制御
- **BRK-TRIGGER-CONDITIONS**: 条件式 + throttle で発火制御
- **BRK-PROJECT-SUBSCRIBE**: agent 単位ではなく project 単位で subscribe

---

## Part 2: Consumer の心 — 各アプリが欲しいもの

### Scene 3: AskOS の欲求 —「進捗と異常だけ教えて」

```
askos: 俺が欲しいのは 5 種類のイベントだけ。

    1. narration.step — agent が何かの tool を使った
       → /agent watch のリアルタイム表示
       → progress tracking
    
    2. narration.blocked — agent が止まってる
       → stale detection の補完
       → operator に通知
    
    3. security.alert — 危険な操作を検出
       → question として escalate
    
    4. session.started — 新しい session が始まった
       → agent の session_id を記録
    
    5. session.ended — session が終了した
       → task.completed の検知（capture-pane より確実）
    
    逆に要らないもの:
    ・tool_result の中身（ファイル内容そのもの）→ でかすぎる
    ・thinking の全文 → context が無駄に増える
    ・user role のメッセージ → agent への instruction は AskOS が送ったもの

broker: filter で設定すればいい:
    
    {
      "filter": {
        "include_roles": ["assistant"],
        "include_fields": ["tool_uses", "text", "security_flags"],
        "exclude_fields": ["tool_results", "thinking"],
        "min_interval_ms": 1000
      }
    }
    
    min_interval_ms: 1000 → 1 秒に 1 回以上は送らない。
    agent が高速で tool を叩いてるときにバーストしない。

askos: あと、session.ended を確実に検知したい。
    今の capture-pane ベースだと「完了したかどうか」が不確実。

broker: 2 つのシグナルを組み合わせる:
    
    a) JSONL ファイルが N 分間更新されない → session.idle
    b) Claude Code のプロセスが終了した → session.ended (確実)
    
    b) は broker が tmux session の alive チェックをするか、
    OS の process 監視で検出する。
    
    ただし b) は broker の責務を超える可能性がある。
    「ファイルを見る」のが broker の仕事で、
    「プロセスを見る」のは AskOS の仕事。
    
    → session.idle を broker が出して、
      session.ended は AskOS が tmux session 消失で判断する。
      両方のシグナルを組み合わせる。
```

### Scene 4: session-replay の欲求 —「全部くれ。後で再生するから」

```
replay: 俺は全部欲しい。一文字も削るな。

    ・全 role (user, assistant)
    ・全 fields (text, tool_uses, tool_results, thinking)
    ・全 timestamp
    ・security_flags も
    ・redaction 前のデータ... は無理か。

broker: redaction 後のデータしか渡せない。
    PII が入ってる可能性があるから、全 consumer に redacted data。
    
    ただし replay 専用で redaction を緩くする設定はある:
    
    {
      "filter": {
        "redaction_level": "minimal"
      }
    }
    
    minimal: PII パターン（SSN, email, phone）だけ redact
    standard: PII + credential + secret を redact
    strict: PII + credential + secret + file path を redact

replay: session 単位で蓄積したいんだけど、
    broker は session の開始と終了を教えてくれる？

broker: session lifecycle event を出す:
    
    {
      "type": "session.discovered",
      "session_id": "abc123",
      "agent_type": "claude",
      "project_path": "/home/opa/work/unlaxer-common",
      "jsonl_path": "~/.claude/projects/xxx/sessions/yyy/log.jsonl",
      "timestamp": "..."
    }
    
    {
      "type": "session.idle",
      "session_id": "abc123",
      "idle_since": "...",
      "idle_minutes": 15
    }
    
    replay は session.discovered で新しい session の蓄積を開始し、
    session.idle で「たぶん終わった」と判断。

replay: catch-up は？ broker が起動する前のログは？

broker: subscribe 時に catch_up オプション:
    
    POST /api/subscribe {
      "mode": "full_stream",
      "catch_up": {
        "since": "2026-03-27T00:00:00Z",
        "sessions": "all"
      }
    }
    
    → broker が過去のログを再読み込みして送る。
      offset_tracker で「ここまで送った」を管理してるので、
      同じメッセージを二重に送ることはない。
```

### Scene 5: Slack webhook の欲求 —「ヤバいときだけ起こして」

```
slack: 俺は 99% のメッセージに興味がない。
    「agent が .env を読んだ」とか
    「rm -rf を実行した」とか、ヤバいやつだけ。

broker: trigger モードがそのためにある。
    
    POST /api/subscribe {
      "consumer_id": "slack-security",
      "mode": "trigger",
      "trigger": {
        "conditions": [
          {
            "field": "security_flags",
            "op": "exists_where",
            "sub_field": "severity",
            "value": ["high", "critical"]
          }
        ],
        "throttle_seconds": 300,
        "cooldown_per_session": true,
        "format": "slack",
        "template": {
          "text": "🚨 Agent security alert",
          "blocks": [
            {
              "type": "section",
              "text": "Agent {{agent_type}} in {{project_path}}: {{security_flags[0].detail}}"
            }
          ]
        }
      },
      "callback_url": "https://hooks.slack.com/services/T00/B00/xxx"
    }
    
    cooldown_per_session: 同じ session で同じ種類の alert を
    5 分以内に再送しない。agent が .env を 3 回読んでも通知は 1 回。

slack: banned word も欲しい。

broker: conditions を OR で複数設定:
    
    "conditions": [
      { "field": "security_flags", "op": "not_empty" },
      { "field": "banned_word_hits", "op": "not_empty" }
    ],
    "condition_logic": "or"
```

### Scene 6: Monitoring Dashboard の欲求 —「集計データだけくれ」

```
dashboard: 俺はメッセージの中身は要らない。
    「agent が 1 分間に何回 tool を使ったか」とか、
    「session の長さ」とか、メトリクスだけ。

broker: それは broker がやるべきか？
    → やるべきじゃない。broker は raw data を流すだけ。
    
    dashboard は consumer として subscribe して、
    自分で集計すべき。
    
    ただし broker が出す metadata は集計に便利:
    
    message に付く metadata:
    {
      "session_id": "abc123",
      "message_index": 42,
      "agent_type": "claude",
      "project_path": "/home/opa/work/xxx",
      "timestamp": "2026-03-27T10:30:00Z",
      "message_type": "tool_use",  // summary field
      "tool_names": ["Write", "Bash"],  // quick access
      "text_length": 150,
      "tool_use_count": 2,
      "thinking_count": 1
    }
    
    dashboard は filter で metadata だけ受け取る:
    
    {
      "filter": {
        "include_fields": ["_metadata"],
        "exclude_fields": ["text", "tool_uses", "tool_results", "thinking"]
      }
    }
    
    → message の中身なしで、metadata だけ。軽い。
```

### 発見

- **BRK-METADATA-ENVELOPE**: 全 message に session/project/agent metadata を付ける
- **BRK-REDACTION-LEVELS**: minimal / standard / strict の 3 段階 redaction
- **BRK-SESSION-LIFECYCLE**: session.discovered / session.idle event
- **BRK-CATCH-UP**: subscribe 時に過去ログの再送
- **BRK-TRIGGER-TEMPLATE**: Slack 用のテンプレート置換
- **BRK-THROTTLE-COOLDOWN**: session 単位の cooldown で重複通知を抑制
- **BRK-METADATA-ONLY**: 中身なしの metadata だけ配信

---

## Part 3: Agent の心 —「俺はログを書いてるだけ」

### Scene 7: Agent は Broker を知らない

```
agent (Claude Code): 俺は JSONL にログを書いてるだけ。
    Broker の存在を知らない。Protocol もない。
    ~/.claude/projects/{hash}/sessions/{id}/ に書く。
    
    俺が出力する行の種類:
    ・type: "user" — ユーザーからの入力
    ・type: "assistant" — 俺の応答
    ・type: "system" — システムメッセージ
    
    各行に content[] があって:
    ・text — テキスト
    ・tool_use — tool 呼び出し (Read, Write, Bash, etc.)
    ・tool_result — tool の実行結果
    ・thinking — 思考ブロック

broker: 俺は agent に何も要求しない。
    agent が書いた JSONL を外から読むだけ。
    これが takt との根本的な違い。
    
    takt: agent を subprocess として起動して stdout を直接受ける
    broker: agent のログファイルを外から読む
    
    agent に変更を求めない → どんな agent でも動く
    Claude Code, Codex, Gemini, Aider, 将来の新しい agent...
    adapter を追加するだけ。

operator: AskOS の ###EVENT### マーカーは？

broker: それは AskOS 独自の protocol。
    Broker とは別レイヤー。
    
    AskOS managed agent: CLAUDE.md で ###EVENT### を出すよう指示
      → stdout-watcher が検出 → AskOS に直接入る
    
    Broker 経由: JSONL を読む → common model → AskOS に配信
      → ###EVENT### は不要。tool_use から narration を推定
    
    両方のパスがある。###EVENT### は AskOS 専用の高速パス。
    Broker は汎用の低速パス。両方使える。
```

### Scene 8: 新しい Agent の追加

```
operator: Windsurf の agent も Broker で見たいんだけど。

broker: adapter を追加すればいい。
    
    1. Windsurf のログファイルの場所を調べる
    2. windsurf-log2model.py を書く
       ・discover_sessions() → session 一覧
       ・parse_messages(path) → common model message[]
    3. broker の ADAPTER_FILES に登録
    
    adapter の contract:
    
    def discover_sessions() -> List[{ path, project, agent_type }]
    def parse_messages(path) -> List[Message]
    # または JSONL の場合:
    def parse_line(line_text) -> Optional[Message]
    
    Message = {
      role: "user" | "assistant",
      text: str,
      tool_uses: List[ToolUse],
      tool_results: List[ToolResult],
      thinking: List[str],
      timestamp: str
    }
    
    これが session-replay の共通モデルそのもの。
    既存の data-model.md が adapter の contract になる。
```

### 発見

- **BRK-AGENT-AGNOSTIC**: Agent に変更を要求しない。ログファイルを外から読むだけ
- **BRK-ADAPTER-CONTRACT**: discover_sessions + parse_line が adapter の最小 interface
- **BRK-DUAL-PATH**: AskOS は ###EVENT### (高速) と Broker (汎用) の 2 パスを持つ

---

## Part 4: Operator の心 —「全部見たい、でも簡単に」

### Scene 9: Operator の日常

```
operator: 朝起きて、昨晩の agent の活動を見たい。

    a) AskOS の /morning → サマリー（何が完了、何がブロック）
    b) session-replay の Web UI → 詳細（何をどう書いたか再生）
    c) Slack → 異常（security alert、banned word）
    
    全部が同じ Broker から流れてきたデータ。
    でも見え方が全然違う。
    
    AskOS: 「3 tasks 完了、1 question 待ち」
    replay: 「agent が 142 回 tool を使って 3 ファイルを書いた」  
    Slack:  「⚠️ agent が .env を読んだ」

operator: Broker の管理画面が欲しいんだけど。

broker: /api/status で全 watch の状態が見える:
    
    GET /api/status
    {
      "watches": [
        {
          "project_path": "/home/opa/work/unlaxer-common",
          "agent_type": "claude",
          "active_sessions": 1,
          "total_messages_processed": 3842,
          "last_activity": "2026-03-27T10:30:00Z",
          "consumers": ["askos-unlaxer", "session-replay", "slack-security"]
        }
      ],
      "consumers": [
        {
          "id": "askos-unlaxer",
          "mode": "filtered",
          "callback_url": "http://localhost:3000/api/broker/events",
          "status": "healthy",
          "messages_delivered": 1205,
          "last_delivery": "2026-03-27T10:30:01Z",
          "errors": 0
        },
        {
          "id": "session-replay",
          "mode": "full_stream",
          "status": "healthy",
          "messages_delivered": 3842,
          "errors": 0
        }
      ],
      "offset_state": {
        "tracked_files": 12,
        "total_bytes_read": 45_000_000
      }
    }

operator: consumer が落ちてたらどうなる？

broker: delivery に失敗したら:
    1. retry (3 回、backoff 付き)
    2. 全部失敗 → DLQ に書く
    3. consumer.status = "unhealthy" に変更
    4. consumer が復帰したら DLQ を再送
    
    broker 自身は止まらない。
    1 consumer が落ちても他の consumer への配信は続く。
```

### Scene 10: 動的な watch 管理

```
operator: AskOS で新しい agent を起動した。
    Broker にも watch を追加したい。

askos (自動):
    POST http://broker:5200/api/watch {
      "project_path": "/home/opa/work/tinyExpression",
      "agent_types": ["claude"]
    }

broker: 了解。
    ~/.claude/projects/ を scanning...
    tinyExpression にマッチする session を発見。
    watch を開始しました。
    
    → 既存の subscriber に session.discovered event を配信

operator: agent を止めた。watch も止めたい。

askos (自動):
    DELETE http://broker:5200/api/watch {
      "project_path": "/home/opa/work/tinyExpression"
    }

broker: watch を停止。
    ※ ログファイルは残る。replay で後から見れる。
    
operator: 全 project を一括で watch したい。

broker: auto-discover モード:
    
    POST /api/watch {
      "mode": "auto",
      "scan_paths": ["~/.claude/projects", "~/.codex/sessions"],
      "interval_seconds": 30
    }
    
    → 30 秒ごとに新しい session を自動検出。
    → AskOS が agent 起動のたびに手動登録する必要がない。
```

### 発見

- **BRK-STATUS-API**: watch + consumer の全状態を 1 endpoint で
- **BRK-CONSUMER-HEALTH**: delivery 失敗 → retry → DLQ → unhealthy
- **BRK-DYNAMIC-WATCH**: API で watch を動的に追加/削除
- **BRK-AUTO-DISCOVER**: 新 session を定期スキャンで自動検出

---

## Part 5: 障害シチュエーション —「誰が落ちても世界は回る」

### Scene 11: Broker が落ちた

```
状況: Broker プロセスが crash。
    agent は動き続けている。JSONL は書かれ続けている。

影響:
  ・AskOS: narration が来ない。capture-pane フォールバックが動く。
  ・session-replay: 新しいメッセージが来ない。過去分は見れる。
  ・Slack: security alert が来ない。

復旧:
  Broker 再起動 → offset_tracker で「ここまで読んだ」を復元
  → 未読分を再読み込み → consumer に配信
  → catch-up 完了

設計原則: Broker が落ちても agent は動く。データは失われない。
```

### Scene 12: Consumer (AskOS) が落ちた

```
状況: AskOS が crash。Broker は動いている。

影響:
  ・Broker が AskOS に POST → connection refused
  ・Broker: retry 3 回 → 失敗 → DLQ に書く
  ・Broker: consumer status = "unhealthy"
  ・他の consumer (replay, Slack) は影響なし

復旧:
  AskOS 再起動 → Broker の status API で "unhealthy" を確認
  → POST /api/consumers/askos-unlaxer/retry-dlq
  → Broker が DLQ のメッセージを再送
  → AskOS が受信 → narration + progress を復元
```

### Scene 13: Agent が crash した

```
状況: Claude Code が OOM で死んだ。tmux session も消えた。

Broker の検出:
  ・JSONL ファイルが更新されなくなる
  ・N 分後に session.idle event を consumer に配信

AskOS の検出:
  ・Broker から session.idle → agent が活動してない
  ・tmux session 消失 → heartbeat-monitor が DEAD 検知
  ・両方のシグナルで確実に検出

復旧:
  AskOS が agent を restart
  → 新しい tmux session + 新しい Claude Code session
  → 新しい JSONL が書かれ始める
  → Broker が auto-discover で新 session を検出
  → AskOS に watch 登録（自動） → 配信再開
```

### 発見

- **BRK-OFFSET-PERSISTENCE**: crash 復旧時に offset から再開
- **BRK-DLQ-PER-CONSUMER**: consumer ごとに DLQ。1 consumer の障害が他に影響しない
- **BRK-IDLE-DETECTION**: ファイル更新停止 → session.idle event
- **BRK-AUTO-DISCOVER-ON-RESTART**: 再起動時に新 session を自動検出

---

## Part 6: Protocol 定義

### Broker → Consumer Message Format

```json
{
  "_broker": {
    "version": "1.0",
    "message_id": "msg_01HXY...",
    "delivered_at": "2026-03-27T10:30:01Z",
    "delivery_attempt": 1
  },
  "_session": {
    "session_id": "abc123",
    "session_path": "/home/opa/.claude/projects/xxx/sessions/yyy/log.jsonl",
    "project_path": "/home/opa/work/unlaxer-common",
    "agent_type": "claude"
  },
  "_index": {
    "message_index": 42,
    "byte_offset": 128000
  },
  "type": "message",
  "message": {
    "role": "assistant",
    "text": "JWT認証のミドルウェアを実装しました",
    "tool_uses": [...],
    "tool_results": [...],
    "thinking": [...],
    "timestamp": "2026-03-27T10:30:00Z"
  },
  "security_flags": [...],
  "banned_word_hits": [...]
}
```

### Broker Lifecycle Events

```json
// 新しい session が見つかった
{
  "type": "session.discovered",
  "_session": { ... },
  "discovered_at": "..."
}

// session が N 分間更新されていない
{
  "type": "session.idle",
  "_session": { ... },
  "idle_since": "...",
  "idle_minutes": 15
}

// session の JSONL ファイルが削除/移動された
{
  "type": "session.lost",
  "_session": { ... },
  "reason": "file_not_found"
}
```

### Consumer → Broker API

```
POST   /api/subscribe          ← consumer 登録
DELETE /api/subscribe/:id      ← consumer 解除
GET    /api/subscribe/:id      ← consumer 状態確認
POST   /api/subscribe/:id/retry-dlq  ← DLQ 再送

POST   /api/watch              ← watch 追加
DELETE /api/watch              ← watch 削除
GET    /api/watch              ← watch 一覧

GET    /api/status             ← 全体状態
GET    /api/sessions           ← 検出済み session 一覧
GET    /api/sessions/:id       ← session 詳細 (message count, etc.)

POST   /api/health             ← consumer が alive ping (optional)
```

### Consumer Callback Contract

Consumer は以下を満たす必要がある:

```
POST {callback_url}
  Body: Broker → Consumer Message Format
  Response: 2xx → delivery 成功
            4xx → 永続的エラー → DLQ に送らない（consumer の問題）
            5xx → 一時的エラー → retry → DLQ
  Timeout: 5 seconds (configurable)
```

---

## Part 7: session-replay リストラクチャ計画

### 現在の構造

```
claude-session-replay/
├── claude-log2model.py      ← Claude adapter
├── codex-log2model.py       ← Codex adapter
├── gemini-log2model.py      ← Gemini adapter
├── log-model-renderer.py    ← renderer (MD, HTML, Player, Terminal)
├── log-replay.py            ← CLI wrapper
├── log-replay-mp4.py        ← MP4 recorder
├── session-shipper.py       ← shipper (watch + parse + ship)
├── session-stats.py         ← statistics
├── search_utils.py          ← session discovery
├── web_ui.py                ← Flask Web UI
└── templates/               ← HTML templates
```

### リストラクチャ後

```
agent-log-platform/  (renamed or monorepo)
├── broker/
│   ├── __init__.py
│   ├── service.py           ← Flask API server (新規)
│   ├── watcher.py           ← FileWatcher (session-shipper.py から抽出)
│   ├── distributor.py       ← fan-out to consumers (新規)
│   ├── subscriber.py        ← subscription management (新規)
│   ├── offset_tracker.py    ← OffsetTracker (session-shipper.py から抽出)
│   ├── dlq.py               ← DeadLetterQueue (session-shipper.py から抽出)
│   └── config.py            ← broker config (session-shipper.py から抽出)
│
├── adapters/
│   ├── __init__.py
│   ├── base.py              ← adapter interface (新規)
│   ├── claude.py            ← claude-log2model.py のコア
│   ├── codex.py             ← codex-log2model.py のコア
│   ├── gemini.py            ← gemini-log2model.py のコア
│   └── discovery.py         ← search_utils.py のコア
│
├── pipeline/
│   ├── __init__.py
│   ├── redaction.py         ← session-shipper.py から抽出
│   ├── security.py          ← session-shipper.py から抽出
│   └── truncation.py        ← session-shipper.py から抽出
│
├── consumers/
│   ├── __init__.py
│   ├── opensearch.py        ← OpenSearchTransport
│   ├── file_export.py       ← FileExportTransport
│   └── webhook.py           ← Slack/generic webhook
│
├── replay/
│   ├── __init__.py
│   ├── renderer.py          ← log-model-renderer.py
│   ├── mp4.py               ← log-replay-mp4.py
│   ├── stats.py             ← session-stats.py
│   ├── web_ui.py            ← web_ui.py (consumer として動作)
│   └── templates/           ← HTML templates
│
├── cli/
│   ├── replay.py            ← log-replay.py (CLI entry point)
│   ├── ship.py              ← session-shipper.py (CLI entry point, consumer として)
│   └── broker.py            ← broker server 起動 (新規)
│
├── common/
│   ├── __init__.py
│   ├── model.py             ← common model 型定義
│   ├── envelope.py          ← identity envelope
│   ├── auth.py              ← OIDC (session-shipper.py から)
│   └── encryption.py        ← encryption (session-shipper.py から)
│
├── docs/
│   ├── data-model.md        ← 既存
│   ├── architecture.md      ← 更新
│   ├── broker-protocol.md   ← 新規 (この文書から策定)
│   ├── adapter-guide.md     ← 新規
│   └── consumer-guide.md    ← 新規
│
├── tests/
├── broker-config.json       ← broker 設定
├── shipper-config.json      ← shipper (consumer) 設定
└── README.md                ← 更新
```

### Migration path (段階的に移行)

```
Phase 1: ディレクトリ分け (breaking change なし)
  ・既存ファイルを adapters/, pipeline/, consumers/ に移動
  ・cli/ に entry point を残して互換性維持
  ・import path を更新

Phase 2: Broker service 追加
  ・broker/ に新規コード
  ・cli/broker.py で起動
  ・既存の CLI (replay, ship) はそのまま動く

Phase 3: Consumer 化
  ・replay/web_ui.py を broker の consumer として動作可能に
  ・ship.py (OpenSearch) を consumer として broker に subscribe 可能に
  ・単体でも動く (broker なしの直接モード)

Phase 4: volta-platform 統合
  ・services.json に broker を追加
  ・AskOS が broker に自動 subscribe
```

### 後方互換

```
既存の使い方 (変更なし):
  python3 log-replay.py --agent claude -f player     ← そのまま動く
  python3 session-shipper.py batch                    ← そのまま動く
  python3 web_ui.py                                   ← そのまま動く

新しい使い方 (追加):
  python3 -m cli.broker                               ← broker server 起動
  python3 -m cli.broker --auto-discover               ← 全 agent 自動検出
  curl http://localhost:5200/api/subscribe             ← consumer 登録
  curl http://localhost:5200/api/status                ← 状態確認
```
