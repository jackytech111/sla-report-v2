// Opaque, HMAC-SHA256-signed pagination cursors: base64url(JSON payload) + '.' + base64url(sig).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequest } from './validate.ts';

export interface CursorPayload {
  v: 1;
  snap: number;
  q: string;
  /** [sort value of last returned row (null allowed), last returned row id] */
  k: [number | null, number];
}

export interface CursorCodec {
  encode(payload: CursorPayload): string;
  decode(s: string): CursorPayload;
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function createCursorCodec(secret?: Buffer): CursorCodec {
  const key = secret ?? randomBytes(32);
  const sign = (body: string): Buffer => createHmac('sha256', key).update(body).digest();

  return {
    encode(payload: CursorPayload): string {
      const body = Buffer.from(
        JSON.stringify({ v: payload.v, snap: payload.snap, q: payload.q, k: payload.k }),
      ).toString('base64url');
      return `${body}.${sign(body).toString('base64url')}`;
    },

    decode(s: string): CursorPayload {
      const bad = (): never => {
        throw new BadRequest('invalid cursor');
      };
      if (typeof s !== 'string' || s.length > 4096) bad();
      const parts = s.split('.');
      if (parts.length !== 2) bad();
      const [body, sig] = parts as [string, string];
      if (!B64URL_RE.test(body) || !B64URL_RE.test(sig)) bad();

      const expected = sign(body);
      const given = Buffer.from(sig, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) bad();
      // Reject non-canonical encodings of the signature (trailing bits) as well.
      if (given.toString('base64url') !== sig) bad();

      let p: unknown;
      try {
        p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return bad();
      }
      if (typeof p !== 'object' || p === null) return bad();
      const o = p as Record<string, unknown>;
      if (o.v !== 1) bad();
      if (!Number.isSafeInteger(o.snap)) bad();
      if (typeof o.q !== 'string') bad();
      const k = o.k;
      if (!Array.isArray(k) || k.length !== 2) return bad();
      const [kv, kid] = k as unknown[];
      if (!(kv === null || (typeof kv === 'number' && Number.isFinite(kv)))) bad();
      if (!Number.isSafeInteger(kid)) bad();
      return { v: 1, snap: o.snap as number, q: o.q as string, k: [kv as number | null, kid as number] };
    },
  };
}
