import type { CommandContext } from '../../commands/index';

export interface AppShimDeps {
  ctx: CommandContext;
  fileCache: Map<string, string>;
  fakeProcess: any;
}

export function createAppShim(name: string, deps: AppShimDeps): any | null {
  const { ctx, fileCache, fakeProcess } = deps;

  switch (name) {
    case 'dotenv':
    case 'dotenv/config': {
      // dotenv shim - reads .env file and populates process.env
      const config = (options?: { path?: string }) => {
        const envPath = options?.path || '.env';
        const resolved = ctx.fs.resolvePath(envPath, ctx.cwd);
        const content = fileCache.get(resolved);
        if (content) {
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
              const key = trimmed.slice(0, eqIdx).trim();
              let value = trimmed.slice(eqIdx + 1).trim();
              // Remove quotes
              if ((value.startsWith('"') && value.endsWith('"')) ||
                  (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
              }
              ctx.env[key] = value;
              fakeProcess.env[key] = value;
            }
          }
        }
        return { parsed: ctx.env };
      };
      // Auto-run config when imported as 'dotenv/config'
      if (name === 'dotenv/config') {
        config();
      }
      return { config, parse: (src: string) => {
        const result: Record<string, string> = {};
        for (const line of src.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let value = trimmed.slice(eqIdx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            result[key] = value;
          }
        }
        return result;
      }};
    }
    case 'tslib': {
      // tslib shim - TypeScript helper library used by many packages
      const __importDefault = (mod: any) => (mod && mod.__esModule) ? mod : { default: mod };
      const __importStar = (mod: any) => {
        if (mod && mod.__esModule) return mod;
        const result: any = {};
        if (mod != null) for (const k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
        result.default = mod;
        return result;
      };
      const __awaiter = (_this: any, _args: any, _P: any, generator: any) => {
        return new Promise((resolve, reject) => {
          function fulfilled(value: any) { try { step(generator.next(value)); } catch (e) { reject(e); } }
          function rejected(value: any) { try { step(generator.throw(value)); } catch (e) { reject(e); } }
          function step(result: any) { result.done ? resolve(result.value) : Promise.resolve(result.value).then(fulfilled, rejected); }
          step((generator = generator.apply(_this, _args || [])).next());
        });
      };
      const __generator = (_this: any, body: any) => {
        // Simplified generator - just return the body function result
        let f: any, y: any, t: any, g: any;
        return g = { next: verb(0), throw: verb(1), return: verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
        function verb(n: any) { return function(v: any) { return step([n, v]); }; }
        function step(op: any) {
          if (f) throw new TypeError("Generator is already executing.");
          while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
              case 0: case 1: t = op; break;
              case 4: _.label++; return { value: op[1], done: false };
              case 5: _.label++; y = op[1]; op = [0]; continue;
              case 7: op = _.ops.pop(); _.trys.pop(); continue;
              default:
                if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                if (t[2]) _.ops.pop();
                _.trys.pop(); continue;
            }
            op = body.call(_this, _);
          } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
          if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
        }
        let _: any = { label: 0, sent: () => t[0] & 1 ? t[1] : t[1], trys: [] as any[], ops: [] as any[] };
      };
      const __spreadArray = (to: any[], from: any[], _pack?: any) => {
        return to.concat(Array.prototype.slice.call(from));
      };
      const __assign = Object.assign;
      const __rest = (s: any, e: any) => {
        const t: any = {};
        for (const p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) t[p] = s[p];
        return t;
      };
      const __extends = (d: any, b: any) => {
        if (typeof b !== "function" && b !== null)
          throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        Object.setPrototypeOf(d, b);
        d.prototype = b === null ? Object.create(b) : Object.create(b.prototype);
        d.prototype.constructor = d;
      };
      const __exportStar = (m: any, o: any) => {
        for (const p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(o, p)) o[p] = m[p];
      };
      const __createBinding = (o: any, m: any, k: any, k2?: any) => {
        if (k2 === undefined) k2 = k;
        Object.defineProperty(o, k2, { enumerable: true, get: () => m[k] });
      };
      const __values = (o: any) => {
        const s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s];
        let i = 0;
        if (m) return m.call(o);
        if (o && typeof o.length === "number") return {
          next: () => ({ value: o && o[i++], done: !o || i >= o.length })
        };
        throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
      };
      const __read = (o: any, n?: number) => {
        const ar: any[] = [];
        for (let i = 0, r: any; i < (n === undefined ? o.length : n); i++) {
          r = o[i];
          ar.push(r);
        }
        return ar;
      };
      const __spread = (...args: any[]) => {
        const ar: any[] = [];
        for (const a of args) ar.push(...a);
        return ar;
      };
      const __decorate = (decorators: any[], target: any, key?: any, desc?: any) => {
        let c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
        for (let i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
        if (c > 3 && r) Object.defineProperty(target, key, r);
        return r;
      };
      const __param = (paramIndex: number, decorator: any) => (target: any, key: any) => decorator(target, key, paramIndex);
      const __metadata = (_metadataKey: any, _metadataValue: any) => (_target: any, _key: any) => {};
      return {
        __importDefault, __importStar, __awaiter, __generator,
        __spreadArray, __assign, __rest, __extends,
        __exportStar, __createBinding, __values, __read, __spread,
        __decorate, __param, __metadata,
        __esModule: true,
      };
    }
    default:
      return null;
  }
}
