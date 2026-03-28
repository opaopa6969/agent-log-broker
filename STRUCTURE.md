# ドキュメント構造

## ディレクトリ構成

```
docs/                              # ユーザ向けドキュメント（確定した仕様・ガイド）
├── features/
│   ├── completed/                 # 実装済み機能仕様
│   ├── in-progress/               # 実装中の機能仕様
│   └── planned/                   # 未着手の機能仕様
└── (その他プロジェクト固有ドキュメント)

design-materials/                  # 設計の材料（DGE セッション出力���）
├── intake/                        # DGE 出力の受け入れ口（未レビュー）
├── dge-sessions/
│   ├── completed/                 # 仕様化済みセッション
│   ├── in-progress/               # 仕様化途中
│   └── raw/                       # 未整理
├── stories/                       # 会話劇・ユースケースストーリー
├── reviews/                       # レビュー・論戦
└── archive/                       # 旧バージョン・スナップショット
```

## ワークフロー

### 新しいドキュメントの追加

1. **DGE セッション出力** → `design-materials/intake/` に配置
2. **レビュー**: 内容を確認し、以下のいずれかに移動
   - `design-materials/dge-sessions/{completed,in-progress,raw}` — 設計材料として保持
   - `docs/features/{completed,in-progress,planned}` — 確定仕様に昇格
   - `design-materials/archive/` — 不要・旧版

### 原則

- **`intake/` にある限り、既存ドキュメントには一切触れない**（誤上書き防止）
- `docs/` は「確定した仕様・ガイド」のみ
- `design-materials/` は「それを作るための材料」
- 実装が完了したら `docs/features/in-progress/` → `completed/` に移動

### ステータスの定義

| ステータス | 意味 |
|---|---|
| `completed` | 実装済み。コードが存在しテスト通過 |
| `in-progress` | 部分的に実装済み。仕様は確定 |
| `planned` | 仕様は確定しているが未実装 |
| `raw` (design-materials) | DGE出力のまま。仕様化されていない |

