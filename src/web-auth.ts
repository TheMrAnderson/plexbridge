import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

interface StoredWebAuth {
  version: 1;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  sessionSecret: string;
}

export class WebAuth {
  private stored?: StoredWebAuth;
  private loading?: Promise<void>;

  constructor(
    private readonly configDir: string,
    private readonly configuredUsername?: string,
    private readonly configuredPassword?: string
  ) {}

  async initialize(): Promise<void> {
    if (this.stored) return;
    this.loading ??= this.load();
    await this.loading;
  }

  async verify(username: string, password: string): Promise<boolean> {
    await this.initialize();
    if (username !== this.username()) return false;
    const hash = scryptSync(password, this.stored?.passwordSalt ?? '', 64);
    return timingSafeEqual(hash, Buffer.from(this.passwordHash(), 'hex'));
  }

  canUseLocalSetup(): boolean {
    return !this.configuredPassword;
  }

  async setCredentials(username: string, password: string): Promise<void> {
    await this.initialize();
    const passwordSalt = randomBytes(16).toString('hex');
    this.stored = {
      version: 1,
      username,
      passwordSalt,
      passwordHash: scryptSync(password, passwordSalt, 64).toString('hex'),
      sessionSecret: this.stored?.sessionSecret ?? randomBytes(32).toString('base64url')
    };
    await writeFile(join(this.configDir, 'web-auth.json'), `${JSON.stringify(this.stored, null, 2)}\n`, {
      mode: 0o600
    });
  }

  username(): string {
    return this.configuredUsername || this.stored?.username || 'admin';
  }

  createSession(): string {
    if (!this.stored) throw new Error('Web authentication is not initialized');
    const payload = Buffer.from(
      JSON.stringify({ sub: this.username(), exp: Date.now() + 7 * 24 * 60 * 60_000 })
    ).toString('base64url');
    const signature = createHmac('sha256', this.stored.sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  validSession(value: string | undefined): boolean {
    if (!value || !this.stored) return false;
    const [payload, signature] = value.split('.');
    if (!payload || !signature) return false;
    const expected = createHmac('sha256', this.stored.sessionSecret).update(payload).digest('base64url');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
      return false;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string; exp?: number };
      return parsed.sub === this.username() && typeof parsed.exp === 'number' && parsed.exp > Date.now();
    } catch {
      return false;
    }
  }

  private passwordHash(): string {
    if (this.configuredPassword)
      return scryptSync(this.configuredPassword, this.stored?.passwordSalt ?? '', 64).toString('hex');
    return this.stored?.passwordHash ?? '';
  }

  private async load(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    const path = join(this.configDir, 'web-auth.json');
    try {
      this.stored = JSON.parse(await readFile(path, 'utf8')) as StoredWebAuth;
      return;
    } catch {
      const password = randomBytes(18).toString('base64url');
      const passwordSalt = randomBytes(16).toString('hex');
      this.stored = {
        version: 1,
        username: this.configuredUsername || 'admin',
        passwordSalt,
        passwordHash: scryptSync(this.configuredPassword || password, passwordSalt, 64).toString('hex'),
        sessionSecret: randomBytes(32).toString('base64url')
      };
      await writeFile(path, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 });
      if (!this.configuredPassword)
        console.info(JSON.stringify({ event: 'web_auth_bootstrap', username: this.stored.username, password }));
    }
  }
}
