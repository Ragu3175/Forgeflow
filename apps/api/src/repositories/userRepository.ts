import { query } from '../db';

export interface UserDbRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export class UserRepository {
  async findByEmail(email: string): Promise<UserDbRow | null> {
    const res = await query<UserDbRow>(
      'SELECT id, email, password_hash, name, created_at, updated_at FROM users WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );
    return res.rows[0] || null;
  }

  async findById(id: string): Promise<UserDbRow | null> {
    const res = await query<UserDbRow>(
      'SELECT id, email, password_hash, name, created_at, updated_at FROM users WHERE id = $1',
      [id]
    );
    return res.rows[0] || null;
  }

  async create(
    email: string,
    passwordHash: string,
    name: string
  ): Promise<UserDbRow> {
    const res = await query<UserDbRow>(
      `INSERT INTO users (email, password_hash, name, created_at, updated_at)
       VALUES (LOWER($1), $2, $3, NOW(), NOW())
       RETURNING id, email, password_hash, name, created_at, updated_at`,
      [email.trim(), passwordHash, name.trim()]
    );
    return res.rows[0];
  }
}

export const userRepository = new UserRepository();
