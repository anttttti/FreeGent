/**
 * Node.js 'crypto' module shim.
 * Extracted from node-cmd.ts case 'crypto'.
 */

export interface CryptoDeps {
  sha256sync: (data: Uint8Array) => Uint8Array;
  sha1sync: (data: Uint8Array) => Uint8Array;
  fnvHash: (data: Uint8Array, size: number) => Uint8Array;
  FakeBuffer: any;
}

// getRandomValues refuses more than 65536 bytes at once; Node's randomBytes and randomFillSync do not.
function fillRandom(bytes: Uint8Array, start = 0, end = bytes.length): void {
  for (let i = start; i < end; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(end, i + 65536)) as Uint8Array<ArrayBuffer>);
}

export function createCryptoModule(deps: CryptoDeps): any {
  const { sha256sync, sha1sync, fnvHash, FakeBuffer } = deps;

  return {
    randomBytes: (n: number, cb?: Function) => {
      const bytes = new Uint8Array(n);
      fillRandom(bytes);
      Object.setPrototypeOf(bytes, FakeBuffer.prototype);
      if (cb) { setTimeout(() => cb(null, bytes), 0); return; }
      return bytes;
    },
    createHash: (algo: string) => {
      // sha384 and sha512 are not implemented here, and a made-up digest under their name is worse than an error (day/night exploration N011).
      if (/^sha-?(384|512)$/i.test(algo)) throw new Error(`Digest method not supported: ${algo}`);
      algo = algo.toLowerCase();
      const chunks: Uint8Array[] = [];
      const hashObj: any = {
        update: (d: string | Uint8Array, encoding?: string) => {
          if (typeof d === 'string') {
            if (encoding === 'hex') {
              const hex = d.replace(/[^0-9a-fA-F]/g, '');
              const bytes = new Uint8Array(hex.length / 2);
              for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
              chunks.push(bytes);
            } else if (encoding === 'base64' || encoding === 'base64url') {
              chunks.push(Uint8Array.from(atob(d.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
            } else {
              chunks.push(new TextEncoder().encode(d));
            }
          } else {
            // A copy: the caller may refill the same buffer for its next read before digest() runs (N012).
            chunks.push(d instanceof Uint8Array ? d.slice() : new Uint8Array(d));
          }
          return hashObj;
        },
        digest: (enc?: string) => {
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const all = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { all.set(c, off); off += c.length; }
          // Real SHA-256 (synchronous implementation for PKCE etc.)
          const result = (algo === 'sha256' || algo === 'sha-256') ? sha256sync(all)
            : algo === 'sha1' || algo === 'sha-1' ? sha1sync(all)
            : fnvHash(all, algo === 'md5' ? 16 : 32);
          if (enc === 'hex') return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
          if (enc === 'base64' || enc === 'base64url') { let s = ''; for (let i = 0; i < result.length; i++) s += String.fromCharCode(result[i]); const b64 = btoa(s); return enc === 'base64url' ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64; }
          Object.setPrototypeOf(result, FakeBuffer.prototype);
          return result;
        },
      };
      return hashObj;
    },
    createHmac: (algo: string, key: string | Uint8Array) => {
      // A real HMAC (RFC 2104), where the old shim hashed key||data, which no verifier accepts. sha256 and sha1 only, as createHash.
      const a = String(algo).toLowerCase();
      if (a !== 'sha256' && a !== 'sha-256' && a !== 'sha1' && a !== 'sha-1') throw new Error(`Invalid digest: ${algo}`);
      const H = (b: Uint8Array) => (a.endsWith('256') ? sha256sync(b) : sha1sync(b)) as Uint8Array;
      let k: Uint8Array = typeof key === "string" ? new TextEncoder().encode(key) : Uint8Array.from(key);
      if (k.length > 64) k = H(k);
      const ipad = new Uint8Array(64).fill(0x36), opad = new Uint8Array(64).fill(0x5c);
      for (let i = 0; i < k.length; i++) { ipad[i] ^= k[i]; opad[i] ^= k[i]; }
      const inner = createCryptoModule(deps).createHash(a);
      inner.update(ipad);
      const mac: any = { update: (d: any, enc?: string) => { inner.update(d, enc); return mac; } };
      mac.digest = (enc?: string) => {
        const outer = createCryptoModule(deps).createHash(a);
        outer.update(opad); outer.update(inner.digest());
        return outer.digest(enc);
      };
      return mac;
    },
    randomUUID: () => crypto.randomUUID(),
    randomFillSync: (buf: ArrayBufferView, offset = 0, size?: number) => {
      const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      fillRandom(u, offset, offset + (size ?? u.length - offset));
      return buf;
    },
    // Compares the bytes of any ArrayBuffer, view or Buffer, as node does; element-wise it called two DataViews or Float32Array([1.1])/([1.9]) equal (exploration O013).
    timingSafeEqual: (a: ArrayBufferLike | ArrayBufferView, b: ArrayBufferLike | ArrayBufferView) => {
      const bytes = (v: any, n: string) => {
        if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) return new Uint8Array(v);
        if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        throw new TypeError(`The "${n}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`);
      };
      const x = bytes(a, 'buf1'), y = bytes(b, 'buf2');
      if (x.length !== y.length) throw new RangeError('Input buffers must have the same byte length');
      let result = 0;
      for (let i = 0; i < x.length; i++) result |= x[i] ^ y[i];
      return result === 0;
    },
    getHashes: () => ['sha1', 'sha256', 'sha384', 'sha512', 'md5'],
    getCiphers: () => ['aes-256-cbc', 'aes-128-cbc', 'aes-256-gcm'],
    createPrivateKey: (key: any) => ({ type: 'private', export: () => key }),
    createPublicKey: (key: any) => ({ type: 'public', export: () => key }),
    createSecretKey: (key: any) => ({ type: 'secret', export: () => key }),
    KeyObject: class KeyObject { type = 'secret'; constructor(type?: string) { if (type) this.type = type; } export() { return new Uint8Array(0); } },
    // Web Crypto API for jose and other crypto libraries
    webcrypto: crypto,
    subtle: crypto.subtle,
  };
}
