import {
  User,
  Job,
  JobStatus,
  JobType,
  RegisterDto,
  LoginDto,
  AuthResponse,
  CreateJobDto,
  JobsListResponse,
  JobStatsSummary,
} from '@forgeflow/shared';

const API_BASE = ''; // Uses Vite proxy or relative path

function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem('forgeflow_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorMsg = `Request failed with status ${res.status}`;
    try {
      const data = await res.json();
      if (data.error) {
        errorMsg = data.error;
        if (data.details && Array.isArray(data.details)) {
          errorMsg += `: ${data.details.map((d: any) => d.message || d).join(', ')}`;
        }
      }
    } catch {
      // ignore json parse error
    }
    throw new Error(errorMsg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // Auth API
  auth: {
    async register(dto: RegisterDto): Promise<AuthResponse> {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      });
      return handleResponse<AuthResponse>(res);
    },

    async login(dto: LoginDto): Promise<AuthResponse> {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      });
      return handleResponse<AuthResponse>(res);
    },

    async getMe(): Promise<User> {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { ...getAuthHeader() },
      });
      return handleResponse<User>(res);
    },
  },

  // Jobs API
  jobs: {
    async list(params?: {
      status?: JobStatus;
      type?: JobType;
      limit?: number;
      offset?: number;
    }): Promise<JobsListResponse> {
      const query = new URLSearchParams();
      if (params?.status) query.set('status', params.status);
      if (params?.type) query.set('type', params.type);
      if (params?.limit) query.set('limit', params.limit.toString());
      if (params?.offset) query.set('offset', params.offset.toString());

      const url = `${API_BASE}/jobs${query.toString() ? `?${query.toString()}` : ''}`;
      const res = await fetch(url, {
        headers: { ...getAuthHeader() },
      });
      return handleResponse<JobsListResponse>(res);
    },

    async getStats(): Promise<JobStatsSummary> {
      const res = await fetch(`${API_BASE}/jobs/stats`, {
        headers: { ...getAuthHeader() },
      });
      return handleResponse<JobStatsSummary>(res);
    },

    async getById(id: string): Promise<Job> {
      const res = await fetch(`${API_BASE}/jobs/${id}`, {
        headers: { ...getAuthHeader() },
      });
      return handleResponse<Job>(res);
    },

    async create(dto: CreateJobDto, idempotencyKey?: string): Promise<Job> {
      const key =
        idempotencyKey ||
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `web-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`);

      const res = await fetch(`${API_BASE}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...getAuthHeader(),
        },
        body: JSON.stringify(dto),
      });
      return handleResponse<Job>(res);
    },

    async cancel(id: string): Promise<Job> {
      const res = await fetch(`${API_BASE}/jobs/${id}/cancel`, {
        method: 'POST',
        headers: { ...getAuthHeader() },
      });
      return handleResponse<Job>(res);
    },
  },
};
