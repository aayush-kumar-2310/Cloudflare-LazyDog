export type Note = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
};

type NoteRow = {
  id: string;
  title: string;
  content: string;
  created_at: string;
};

const toNote = (row: NoteRow): Note => ({
  id: row.id,
  title: row.title,
  content: row.content,
  createdAt: row.created_at
});

export const LIMITS = {
  titleChars: 200,
  contentChars: 50_000,
  listDefault: 20,
  listMax: 100
} as const;

/** D1-backed notes, always scoped to a single verified user. */
export class NotesRepository {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string
  ) {}

  async create(title: string, content: string): Promise<Note> {
    const note: Note = {
      id: `note_${crypto.randomUUID()}`,
      title,
      content,
      createdAt: new Date().toISOString()
    };
    await this.db
      .prepare(
        "INSERT INTO notes (id, user_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(note.id, this.userId, note.title, note.content, note.createdAt)
      .run();
    return note;
  }

  async list(limit: number = LIMITS.listDefault): Promise<Omit<Note, "content">[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, title, created_at FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .bind(this.userId, Math.min(limit, LIMITS.listMax))
      .all<Omit<NoteRow, "content">>();
    return results.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at
    }));
  }

  async get(id: string): Promise<Note | null> {
    const row = await this.db
      .prepare(
        "SELECT id, title, content, created_at FROM notes WHERE id = ? AND user_id = ?"
      )
      .bind(id, this.userId)
      .first<NoteRow>();
    return row ? toNote(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
      .bind(id, this.userId)
      .run();
    return result.meta.changes > 0;
  }
}
