import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User, AuthResponse, RegisterDto, LoginDto } from '@forgeflow/shared';
import { userRepository, UserDbRow } from '../repositories/userRepository';
import { env } from '../config/env';

export interface TokenPayload {
  userId: string;
  email: string;
}

export class AuthService {
  private formatUser(row: UserDbRow): User {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private generateToken(user: User): string {
    const payload: TokenPayload = {
      userId: user.id,
      email: user.email,
    };
    return jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as any,
    });
  }

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const existing = await userRepository.findByEmail(dto.email);
    if (existing) {
      const error: any = new Error('A user with this email already exists.');
      error.statusCode = 409;
      throw error;
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(dto.password, salt);

    const userRow = await userRepository.create(
      dto.email,
      passwordHash,
      dto.name
    );
    const user = this.formatUser(userRow);
    const token = this.generateToken(user);

    return { token, user };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const userRow = await userRepository.findByEmail(dto.email);
    if (!userRow) {
      const error: any = new Error('Invalid email or password.');
      error.statusCode = 401;
      throw error;
    }

    const isValid = await bcrypt.compare(dto.password, userRow.password_hash);
    if (!isValid) {
      const error: any = new Error('Invalid email or password.');
      error.statusCode = 401;
      throw error;
    }

    const user = this.formatUser(userRow);
    const token = this.generateToken(user);

    return { token, user };
  }

  async getMe(userId: string): Promise<User> {
    const userRow = await userRepository.findById(userId);
    if (!userRow) {
      const error: any = new Error('User not found.');
      error.statusCode = 404;
      throw error;
    }
    return this.formatUser(userRow);
  }
}

export const authService = new AuthService();
