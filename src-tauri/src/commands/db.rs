use tauri_plugin_sql::{Migration, MigrationKind};

pub fn get_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_conversations_table",
            sql: "
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY NOT NULL,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    model_id TEXT,
                    system_prompt TEXT
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY NOT NULL,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT,
                    tool_calls TEXT,
                    tool_call_id TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
                CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
            ",
            kind: MigrationKind::Up,
        }
    ]
}
