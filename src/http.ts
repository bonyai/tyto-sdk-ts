import { TytoApiError } from "./errors.js";
import type { ResolvedConfig } from "./config.js";

type Query = Record<string, string | number | boolean | undefined>;

export class HttpClient {
  constructor(private readonly config: ResolvedConfig) {}

  private buildUrl(path: string, query?: Query): string {
    const u = new URL(this.config.apiUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` };
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      const err = body as { error?: string; message?: string } | null;
      throw new TytoApiError(
        res.status,
        err?.error,
        err?.message ?? `HTTP ${res.status}`,
      );
    }
    return body as T;
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const res = await fetch(this.buildUrl(path, query), {
      headers: this.authHeader(),
    });
    return this.parse<T>(res);
  }

  async post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    const res = await fetch(this.buildUrl(path, query), {
      method: "POST",
      headers: { ...this.authHeader(), "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parse<T>(res);
  }

  async put<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    const res = await fetch(this.buildUrl(path, query), {
      method: "PUT",
      headers: { ...this.authHeader(), "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parse<T>(res);
  }

  async delete<T>(path: string, query?: Query): Promise<T> {
    const res = await fetch(this.buildUrl(path, query), {
      method: "DELETE",
      headers: this.authHeader(),
    });
    return this.parse<T>(res);
  }

  async putBinary(
    path: string,
    data: Uint8Array | Buffer,
    contentType: string,
    query: Query,
  ): Promise<void> {
    const res = await fetch(this.buildUrl(path, query), {
      method: "PUT",
      headers: { ...this.authHeader(), "Content-Type": contentType },
      body: data,
    });
    await this.parse<void>(res);
  }

  async getBinary(
    path: string,
    query?: Query,
  ): Promise<{ data: Buffer; kind: "file" | "dir" }> {
    const res = await fetch(this.buildUrl(path, query), {
      headers: this.authHeader(),
    });
    if (!res.ok) {
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      const err = body as { error?: string; message?: string } | null;
      throw new TytoApiError(
        res.status,
        err?.error,
        err?.message ?? `HTTP ${res.status}`,
      );
    }
    const kind = (res.headers.get("X-Tyto-FS-Kind") ?? "file") as
      | "file"
      | "dir";
    const ab = await res.arrayBuffer();
    return { data: Buffer.from(ab), kind };
  }
}
