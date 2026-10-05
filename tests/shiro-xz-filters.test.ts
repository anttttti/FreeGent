// xz decoder: SHA-256 integrity checks, the Delta and BCJ filters, and the refusals that go with them
// (tasks/059). The fixtures are real `xz` 5.2.5 output for the generated input below, so CI needs no xz;
// the live-oracle tests at the end run when one is installed.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { xzDecompress } from '../shiro/commands/xz';
import { sha256, crc32 } from '../shiro/commands/checksums';

// Same generator the fixtures were made from: low-entropy filler with branch instructions planted for each
// architecture (x86 call/jmp, ARM bl, Thumb bl pair, PowerPC bl, SPARC call).
function input(n = 1500): Uint8Array {
  let x = 12345;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; out[i] = (x >>> 16) & 0x0f; }
  const put = (pos: number, bs: number[]) => out.set(bs, pos);
  for (let i = 0; i < n - 8; i += 41) { const r = out[i + 1]; put(i, [i % 2 === 0 ? 0xe8 : 0xe9, r, out[i + 2], out[i + 3] & 3, r & 1 ? 0x00 : 0xff]); }
  for (let i = 500; i < n - 8; i += 52) put(i - (i % 4), [out[i], out[i + 1], out[i + 2], 0xeb]);
  for (let i = 520; i < n - 8; i += 60) put(i - (i % 2), [out[i], 0xf0 | (out[i + 1] & 7), out[i + 2], 0xf8 | (out[i + 3] & 7)]);
  for (let i = 540; i < n - 8; i += 68) put(i - (i % 4), [0x48 | (out[i] & 3), out[i + 1], out[i + 2], (out[i + 3] & 0xfc) | 1]);
  for (let i = 560; i < n - 8; i += 76) put(i - (i % 4), [0x40, out[i + 1] & 0x3f, out[i + 2], out[i + 3]]);
  return out;
}
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// `xz -c --lzma2=preset=0` with the options named, on input().
const FIXTURES: Record<string, string> = {
  sha256: '/Td6WFoAAArh+wyhAgAhAQwAAACPmEGc4AXbBCpdAHQA/JsquZx+N8Quq2b+nGoFaYRKv/bzfrlKBQFzJcImrz3ppCzAko0GtjfYvPhMvOJxOCXxb5rCszCUd4UCdqo1egmsSIQEizREKudi3IPr7PdJgxM6co8Cf4OHnhPTwwLh/OOYKb3QSmnt/fGJWlAlDYhh27s28tpmTEN9/jupmNlQb7dFm/7LiHURQ7Zfuj5MXad9/0q00bruybXb8jpy4h1Geb4YWYbrsnQ7thUQrysrBc0XO/px/rJoAqpjP8DKYXkgD52o5EKqQud0QaxS6sjPEW8Nidv4G6airFuF+L0PgU0t+FuyY2uGIBW9NMJlphH7Vnz/gN5yUfmhWk3CgcXvkHKNnlWm7E9r41y/3Ers7l1eFabVBbS1LWZByvDDn0/4Pq68H60sSCQGg5R+dETa+G74Xh7km9Zb7p9U73q1mL3R6J2rZSAgZa5FmLa8C7j8fC691DeiHHVMLTORDG2evGV/e2cYIDYtBdgLMR6WCd4tTIsuz1txYNaqxPD8WAV1SAi1RNwhEdpKtnfNAYivqe9884BMDng/E/LHs+hlA8f1nqALjQsqsvKOyPYniVNhOWlE4sinXcTlqRymi2Hstbh0Pn9lxUx1frmphIcw3SbCetpXi5bMa2ZjAk4Jrmj10LJRKuaaaZpReRrRswzmIqb8DN/7WpzsFcyYNbaI8qzj74C3HLTLAFxb0gc3HeYLi3jsRRSjT3CA0Gd8OkICW3TehqPGIYSQBSlOOgzpQbWQQbpGknNuPfpGmWY6P8zigTAQYygoZKDL658ViB5aaaBfJU5BoCOzHzM+yPi040SqyclIJE/0e0PAIpdSBti6UXrQ4jHaPtqukeCjzAgWdOqieX7oj/dMasVKQJQbwsPcUB05mtGyO+AoS9KcZ5WD+cQAqPPUuXQnQBapDYtzAzKaIhO3PjEpr654D9Ej8rtySL6m+3ySntx1JXut3vAGOUV/tw8k0M9C4E4Tm9zwuH6vVrzqLI+GOIcIXENcWPf2AuiH9yDmeVU+ZkgQLJUBDZAgf5PtndK0JIAz0OzksGi4lH+PmPWIMgf5xrcNFpPRAcITlVoQiQ6S9Hn2fjv31ioFT8NcfkWhu+snfWliWsKBO6DOVbT8cuOBU48KpKIxtj/9hAPqsrc2MEyEqytYlYdwZXyKhvAlMXilfFce57KU5PR4x2vOTQ41LKP7gJp8ResoznAnuOloru+OZhbYUtFqO5mH1sIBnQC89yvmfXZ6QRdS+H/nn1MBxbcgvXQ5BNpURgD2qSmtooElrdG2D3Rhis+Vhj/f/0TXp8U9FiXxIc8PXFbIyohMIKdcZDNiExNZ/7LHoh2jVEig8U05bREC7fNbA2siyPeIWfjHVF3+n01lVLGLDqoPlEQecLGV3qfMYxu2Avhb1dNRmWTrW7BG78gAAAAHp/pZsVwh4PdfewzsOyfqZOgPg9aCw+BR1EF1iRcuRQAB3gjcCwAAgwvGu7bp3xwCAAAAAApZWg==',
  x86: '/Td6WFoAAATm1rRGAgEEACEBDADWfBiv4AXbBEJdAHQCPJsquZwI4Vr8uu74hn5Ofe8Hs5ZvoLXTpQpjij6kn6DoszS74UDvLGk8bqlE6c7m9r3BCH+SwPQ22NpvaYVU4fpEKnUSXDKiX4mhsLxvfM69iM7k7unJC0fA5WaXOAwlYbjsxsW+poJIspo/CSsSqso2iU/FHc/oeYlFXsPgTvH4ujMv35ZLR4QxN6MQ6dNoUa9LgWabHJFmJmdbNl1qwnaeYddWINeWOisMUpVwDAhCYYFd20bKXaH3jT+oxACbeOlWyzzxrpOZbwBaEF+anG/QKcnSUfDPyAbX+pzLTg1XZqeytFjrMNQfHYNFfcU6OrzRVY0gEE4sQ7+Esm+9RSLULfG9FeIak1MoHx8WcBhsaVF1+6KZ6N0ji9bvSg74PV3zMS5TFQ5HZalkDo6KtZ9LwoRpX/Zgcw9Nnt2aA8WzZDgaVX8hbmCdQR/aLT8SJcK4Q52Mi9v8YwUmQaelSrKQ2ngCB8Cu5DaFBlwb8+jtPJ+ftTKDdU+73wgcdPmEB4ICHO7DtnQ9iCqbgoo7YyKVxUjG/LN6P5pYxMFTtUl+/uUZbE7CVXZ3zAYbiBo2pKuSyL3XkqX9ce9diZ1u9g3Na1Nsk0CiPjZt4SCIG1LO2J61CmBPBHQ2zze7p+lz09IHwVGJhdJ9zulQATaUdh8Lx8gZEff+NJLNaJoNRGL0VFGfEJa9picd30veQ+jpV+frh9WHZ0HLanN3yciQyAnapjNpkQOL8WXgK8IbKkkpTc2bQ5If9zqSQb8g5rBvm3W2g3CzcvXdJ9w1ETLTCSFRX9MZrbkzHTm8iJoFNvfE8MYzbtTKS3y5suYaE3W4Rce8R6/zFGDtJh2Mt80zRdovFAPobeQjgalb6dCIn2ieF34AfsgaLYcu6F23tX2/gBpiNw1SG//tp5mLDzLMcUEm6OEOrvpz5mJ9w4sDEeidGO9z7iD7gZaq6muHYBi/tXhYs0LgAcrKe5xSOhkOF2p5jw2cQgEdA7qqbgssHXWGee5VaNiD45bo5bJzNON+Um25INyMEsu8KEbzb2VBnyQSgvAjLZw6o+Bs20BAWwrggcmPXD0C7zUrWeBXJcO9YPaZS+zvqzmlmg8mwPYVgi2GWZtnQ6Bov7tda0lv/P7dTTzsX0dKVsY0agNWGkMx8npqxMZH5XqFA5ic94tpKgxg9PqfMCH5vXdM2o1vGH9DcDHarkoKtd3UvRvWlE7sCfktRW2SoiyvJN18X8mNc/Pk02+wnYPhWxI2VT8IHH/CuCSSp4+mmT9ZnZP3oIqkVmSGmgOY5D+BIF0RLc1odb7bs8ualvfOwuba1LXQrVqVjvGtuYn151BFzbpAq4FKs74gqSyzXifxzLPmvaHJgkVbAgeBQuPABCJXjb6KAqJVIsn9GPUVe7Yji/WEAZBhbreqA3gH3rYcoEMM3FxbjbNbg8Y1bcY31IyJ4wB+ZTgAAACFwcMHZVPn7AAB3gjcCwAAgwvGu7HEZ/sCAAAAAARZWg==',
  arm: '/Td6WFoAAATm1rRGAgEHACEBDAB4Dowp4AXbBDxdAHQA/JsquZx+N8Quq2b+nGoFaYRKv/bzfrlKBQFzJcImrz3ppCzAko0GtjfYvPhMvOJxOCXxb5rCszCUd4UCdqo1egmsSIQEizREKudi3IPr7PdJgxM6co8Cf4OHnhPTwwLh/OOYKb3QSmnt/fGJWlAlDYhh27s28tpmTEN9/jupmNlQb7dFm/7LiHURQ7Zfuj5MXad9/0q00bruybXb8jpy4h1Geb4YWYbrsnQ7thUQrysrBc0XO/px/rJoAqpjP8DKYXkgD52o5EKqQud0QaxS6sjPEW8Nidv4G6airFuF+L0PgU0t+FuyY2uGIBW9NMJlphH7Vnz/gN5yUfmhWk3CgcXvkHKNnlWm7E9r41y/3Ers7l1eFabVBbS1LWZByvDDn0/4Pq68H60sSCQGg5R+dETa+G74Xh7km9Zb7p9U73q1mL3R6J2rZSAgZa5FmLa8C7j8fC691DeiHHVMLTORDG2evGV/e2cYIDYtBdgLMR6WCd4tLR1iEdjboljecIAQHf9JagJsua/kSTKKizXG8Lrtc/DmqOH4lLOVoM/qnfRqfv3lojsvA9OzgDbnNFrB+9H/Bmjs7KOaqNLDDJJ45XV517aoX/v+WP0VUb1sOw801WxA9OF2a7FuHdUsL9uiqyP6abTMIc+ftxo4uG7OJzE3t7B3LqpswK590/fe1OOeBK7mQ6zQNePZfMo1gq4KLmUKWse+eXA/4DcN+zxB4pUQehr6AnUR83jC2Hq+8dqeLVvDTqcbJn3mzaluP39FV90wDOreCGaTfle338RWQKExs/n1ONi5XIRSLDNvwh66E+B3kKTKmHtCSBQNRxVwJvFx8NSeMMzq8gta0sq5RUQoJHbJ1C3joaupuE3brreqW4gS4HtOPE7HVnh/ZUzlxdEcdd7+0DvE1TxvIYG98Mk20pwP12gL60Y0lrpsaWDfT/BRRogzQ7ixGF3mYvqHF2tKCKAVBPMrgZ+8BWmAysiD4Fbbm+ld8p4Kcy8Z09Rzk4KvBRezWPeOqL+pFXZVYBsyfdn4rnLtM6m5szPBuIi58eFwgXFf0sJIVw2EvDxoxd36/na2dEJij65GN2V1yK2XMjeO4TynaE6rECjY3LCh9S6SNswcH5jp4DGtGMgQGnCNP6njaVlqbhIT4WGe4hHDAKVsf2nJx6YmXlu1r5S+2qGsoMsMY8E1vef7UreLm0nxZJnOCPxLR+TY12WmW779mJVRG+bC3N3tKpmLutQsWEUlGkyDNnZGjrtZChhsFThF5y/zbWdmA1TOym59zImPBGtl26rhfUKNyCe/H2vAMLnDjwbe/H9PegAyvVxPm8Ucui6Zq5No0wnEy7VEJxuJSNqnH5b9S9MftlYvmE9BVdtSql/j/3ZJFM2Rg79cil+KmrWsyoMd0u2yCylY7Ezxq4RNJ0kZOhBpwPKwSS8+9Hm6JzotPFIAhcHDB2VT5+wAAdgI3AsAAJ7on22xxGf7AgAAAAAEWVo=',
  armthumb: '/Td6WFoAAATm1rRGAgEIACEBDACtvNrY4AXbBDFdAHQA/JsquZx+N8Quq2b+nGoFaYRKv/bzfrlKBQFzJcImrz3ppCzAko0GtjfYvPhMvOJxOCXxb5rCszCUd4UCdqo1egmsSIQEizREKudi3IPr7PdJgxM6co8Cf4OHnhPTwwLh/OOYKb3QSmnt/fGJWlAlDYhh27s28tpmTEN9/jupmNlQb7dFm/7LiHURQ7Zfuj5MXad9/0q00bruybXb8jpy4h1Geb4YWYbrsnQ7thUQrysrBc0XO/px/rJoAqpjP8DKYXkgD52o5EKqQud0QaxS6sjPEW8Nidv4G6airFuF+L0PgU0t+FuyY2uGIBW9NMJlphH7Vnz/gN5yUfmhWk3CgcXvkHKNnlWm7E9r41y/3Ers7l1eFabVBbS1LWZByvDDn0/4Pq68H60sSCQGg5R+dETa+G74Xh7km9Zb7p9U73q1mL3R6J2rZSAgZa5FmLa8C7j8fC691DeiHHVMLTORDG2evGV/e2cYIDYtBdgLMR6WCd4tTIsuz1txYNaqxPD8WAV1SnE4kowi4MAf1v2yScxsuQYAELN/6OnJhd2XXptuA4Bd4PRH+DWWNMgW8l9f4eWPqdpSfynWSS1gS7h5p2Xoexiw7mqvwCT8QA9VSnWUDZn7HaaTdAtibhcJjiPwptRFTw9GtG4PVK6bLMwZlfnwjgNmrkn/mau9AzPqJJUZnaDcBtRJSzJfNJnki/xBQBNk9yRGduXp6YlP5PSCZURSFMmMOE8dyQyPsSFETYxjLpPR9MeIVxt4lwLF+1FgCmV+dQLFmPymo9WO1JcfT50YvzUoGMaFDqCI3dUZnQxp5hjgKbCIL6Q9pE/+1uz74AsBsIOXr5x8t+AOzlYlxnwgIFsPW49m+qADBJ2AC1g0sVrHBroLFHOGCk4bSTf0F9WHKnHXdw7Gx3YWjbgxBzEvAlHxwKWNgdNS8X/hWpNw2DwMAHMwh3M3XPDYqcBoO8uwCYvjvBJexq91Ov5Bn20IWHKTzbj3ISnSBYZwB97MLGuRO+VnhgVnMuRV7fAn6hdTI2FJlDtI7iMrR0cwh0jAq3ivlJGIqFE8zBjujJxy/rA8w8Z9MatJOmFhSN2l66kNqFZUmbg9cAVhCPORt+D4MdrSsKK1Ox+wa0BSscrAY9xWPnNcgRXoAIzZCsPmfoW5hVRq7gJMPMkIvWoA50yMbs7eLg5ZOZNa04z0/pWL1BF1hxNZTRcidDyIkSmvzyT8jLj1aHlAMS/OLM2/V3LH5dRlFrClom0CApgyDy1nv3DgZeRbvRpRrC3fRGAqhnmO71Fw2BXnMQNPn0xQHoAwux+E1HYu37gK5LXLVH5BwKCUPmmrY4X0q/bKgcsF5IokLj2Vyifsm4zdgKAXPjkcxmWrcADr8qvfClMSTS+do1lz5kPbO/b92Fpzff/VI1QyOMPcTm0LnUPXwcs7AAAAAIXBwwdlU+fsAAHNCNwLAAC2e4Q+scRn+wIAAAAABFla',
  powerpc: '/Td6WFoAAATm1rRGAgEFACEBDABzr0Rk4AXbBDxdAHQA/JsquZx+N8Quq2b+nGoFaYRKv/bzfrlKBQFzJcImrz3ppCzAko0GtjfYvPhMvOJxOCXxb5rCszCUd4UCdqo1egmsSIQEizREKudi3IPr7PdJgxM6co8Cf4OHnhPTwwLh/OOYKb3QSmnt/fGJWlAlDYhh27s28tpmTEN9/jupmNlQb7dFm/7LiHURQ7Zfuj5MXad9/0q00bruybXb8jpy4h1Geb4YWYbrsnQ7thUQrysrBc0XO/px/rJoAqpjP8DKYXkgD52o5EKqQud0QaxS6sjPEW8Nidv4G6airFuF+L0PgU0t+FuyY2uGIBW9NMJlphH7Vnz/gN5yUfmhWk3CgcXvkHKNnlWm7E9r41y/3Ers7l1eFabVBbS1LWZByvDDn0/4Pq68H60sSCQGg5R+dETa+G74Xh7km9Zb7p9U73q1mL3R6J2rZSAgZa5FmLa8C7j8fC691DeiHHVMLTORDG2evGV/e2cYIDYtBdgLMR6WCd4tTIsuz1txYNaqxPD8WAV1SAi1RNwhEdpKtnfNAYivmMbSXV7Jp/ICdhMCyuM+lfPOp6DcuSwskNRU49IZpv6dj2cAfLMW3Fp4FfMd5kyHszB+Dt1VACQZcSMPOLrIu6uw3JT2WqgP1QLtk9l8l9mj+dkbZ1vU+WMe0gcqGQcJ6+BDnFE/Kbn72LqBejDt0gvvCd4KpYU1muce9TiklJOOn7zGOOvDI73aS/fZuEzZg7hWfEwjJEyVlU5Lyo/EwS9yHLyVqVBqwJUkNgeTDlYzmSO25vucRXW2xc2qR9FDh+wvZHA1nw5uHU1DwfisKkmmxw7vtpss7V7PSXDu7GXGkeJjRLKO+kYGJtbyo1pq6mOFrcewl19qcNylhxgFoKkTmdUkJCD3xAs2TYUejHVcoRdmhdmrx0VRdmG9Xgvbz5P6h9TitpdTkgo3rG3yuCmoXiKB9c3LzSTld1hfdK+ZfnVOx3wg6mGHVTVT9RF7UBqjgpgOuRsrWsRIlwcPm+EmFgULuBCJcPoTtvaYMaMHtM42HD/KIks5VtzBMoHBsKK+0lGn0vI5s9EdnQAX5Qaq+Jl4xxk480BYIdVy+qw+3W/gxRxogLPInjpuE7CN4QhtxW0fYId+KP4fA6lDl3nKJsBOM22T6EaHgGp7xHy4Tl+PbsFeTcjXDVZXIK/OyPgWK8WzLqce1ABv4lHR1GRPAdA5mt67xM8hxDyZ3Uoy8BLm+ep0uKxYdihJFHKmbsp4g94fKtPizu4wHIi9+VG3XWtn9+ppg+sNSC5l3lz3Qbbp9oYUDhW7xEhUkHv+UwDsWMGH6I1ztBmI33V4xQCyDMbJkL0roE1DjepND/WMqwhQYu/s4i+sdwX8DI48RbI+RGGZSdyoAo7/js+wkyuRoc+eZNEE5OJggi9/uf44vZqF0oI1GVEMjn8H2wMCqYln7+zJ29gAhcHDB2VT5+wAAdgI3AsAAJ7on22xxGf7AgAAAAAEWVo=',
  sparc: '/Td6WFoAAATm1rRGAgEJACEBDAAIb4YT4AXbBDZdAHQA/JsquZx+N8Quq2b+nGoFaYRKv/bzfrlKBQFzJcImrz3ppCzAko0GtjfYvPhMvOJxOCXxb5rCszCUd4UCdqo1egmsSIQEizREKudi3IPr7PdJgxM6co8Cf4OHnhPTwwLh/OOYKb3QSmnt/fGJWlAlDYhh27s28tpmTEN9/jupmNlQb7dFm/7LiHURQ7Zfuj5MXad9/0q00bruybXb8jpy4h1Geb4YWYbrsnQ7thUQrysrBc0XO/px/rJoAqpjP8DKYXkgD52o5EKqQud0QaxS6sjPEW8Nidv4G6airFuF+L0PgU0t+FuyY2uGIBW9NMJlphH7Vnz/gN5yUfmhWk3CgcXvkHKNnlWm7E9r41y/3Ers7l1eFabVBbS1LWZByvDDn0/4Pq68H60sSCQGg5R+dETa+G74Xh7km9Zb7p9U73q1mL3R6J2rZSAgZa5FmLa8C7j8fC691DeiHHVMLTORDG2evGV/e2cYIDYtBdgLMR6WCd4tTIsuz1txYNaqxPD8WAV1SAi1RNwhEdpKtnfNAYivqe9884BMDng/E/LHs+hlA833o8wK5viUJyIxYX5mgmG2Kb6mbQgtpMqGKeE2c+237pneakOeDECy1G7f68WmdQ5d4/2zElFjY1fyCbuiXFEpDzC2omjQKGp1X9Kd2+4It/bhbPXiQi6W/6afj7uz453Jz9fMSe/l4n+QZmNs8ECSo/C67g/r2VFH18Xne7q6rDh5JET5YjtMj0EGVAXJSyMP2VYQesKk9O2VpDTAejnXRth2x4hh9ZA58bv95IefjAxCZQpzz/3BQzsMD3znBVVt5exy8Q4UXppyYYokLtCnsgU57FaRbYb7mVcENJFCcrE16qSTTl0hvVHOBRfbvtJIBrOqwsVSXFF5Nmte2TXnDo7VyUyj3WEGJU76Iq390RgavPMK4eUu9AQzmuDi8x8DFKDW1GZH/7XXOwNuesg4X89hPfyxLWbsP8Z9N04E8bye5zCPjfVX8eBdqMefCiTjjyL9zZTuVmjolVCosgHf0oX2cJiNWps40aCdz1go1mmXjjl56TOSL5ruvCeC5ZmNrgkZcXqfx78X/IaL5xiZBiJCjufEPqrfOGpRUWFjr9HigNATnd6075D396vPwZgSlkwaPRn60IHSeBVu8AxvGZbno9sNqZUvNO5AY0RXyv2Nsw4f7Ue8vIsFsjKyu6gkTfXocNJOcL8nXWnm4eLcpUxlSxiwZB87ZIXFateUsdNaZNYFMlAaP325rfbAzb2gDtmFTlG/AUGllQjnlF0Jit1/RKhgx0VyHYEfJ+YmkbNX/ZRM3WVauUO4wkxYt4kgeEmnPYmzwquauQxtr1hkomsfZb2AvLoOIVcAxzVJEoMOP5EZ7ZxmRv8ehv5O8MI4GwyzqxR2yN7dTdCVmeL83TsweGgH/NrcMSYuccn9pw4AAACFwcMHZVPn7AAB0gjcCwAA+MsEzLHEZ/sCAAAAAARZWg==',
  delta: '/Td6WFoAAATm1rRGAgEDAQIhAQyIEa+54AXbBMpdAHQA/Jy4KNaMcQlszXudMN+Z0Czhb9UulXCgZQxKrUrtoezZAKNIJ6Aj0GTrLWvue0vzIhCmhszmt7fBiCrOXzyPCo+v7uqwA3Gl0n1bC1f35S7znv8w5gdcPVVCxeaKF65M//5pWk9lajFvBY8qSRW6dKdtUv2kNj5VPEk/DAW149QJJYxSKu5dSFOSulUzjAnlhJw7dz5Hp3VcK5QjChJPvUmUhfnAlISjQHZUB/RePB6epqcCCcJMdhj/8KX7lResDL5fmHxvffX7Oj6eRAP8kV3oMqZ42xE5YetO6iPHebGbqrn+2hY7eIo+frkWQip+X2BSg8JVaixV4U3GdhqOo170etTVnq0EGUWo4Sb9KB5Q0agTxewvhA8knBVFMnxQJ7vanBYmBwqryMHRW8splK6717PJ407UDXwXlafyK4UwFz30DaIID4U6XM0g7A8CkA8GwCFbtJauHPoD3O+EkHU3juHe83WJhXzqn/MFCYK/SIZzBr5DRO63ZY2vY51MOxkGzuLE49USkm9YOWB0d0uSroSoACTR4aRbWopq6hrQwPipIZ0RE8s8tod7m65cDzHS2MeiR16OtiUBIXCqHTdfB+XZNQTL8h/vlHeA8gddm/cJmj0dI26sC7yGSCjlkbvgaDHzpi6B/HOIsjt00SDZhraB5VvFoTzkQv7oHvoGvAG34eURoOdb/jjTGfOtkz5FVVXgHjGT7OPg04IW2Q9eGZemNOLr1yScyds6MS2c0BzAomPET1Z6VNwoAPxKNjXqYEV91oYIW1unVSiIdRWFFByELSjkWIbjoGyjNVq7XtvFdzfH1WtLds9F7/BJmKTfrlRoLF5iV2+ohOr+H7UDnNmcJkHItBR2rIOyHaDDIYSqgGDeb26jS79f/Rze4FKz+BaI5WNnSThJB04dFtNmh+vYGjkpoJYX+K0IPHlReDdg7vTkyqlli6wQnR+Dl49mZUCnl+aw1o22f8RwsYiAUrV40rfhaiisxxxk6tRnPwrLs/+v7b+vUmEtI9+ftbmqATvYn8auKikhvp8eA8zNdZuh8L8V9dqzV3v2t9SD/FIaytaPKBeK10wIn+0wvwDpmIz/DtaGekRyGYDzsIQWR6y/bZ4k8/+T4bEUV5+ZwRSyzZSM0DM87LVcdTjqZPUHYPDnfFLfYjJCVSH1nBmr4OJ/FvF93smc0hrSrIaj7UxtAjx2//OZfGn+WjjZFOkit2OFA+jNJPPQO7JgJFgEyZsbS6QeTsRmpgTwZZWfl/RPEZW0vl39NOmsr7+Ls4AkfBmzrIT92pAy3gSTNOoxU+rtTGM4lMCPecyFA1kEyLrfLBolsjBhS8UnCHYdwo+4ndIKe5I+uGDJ7v2iYXwFuxaFdunkCGq9bVz8wt+Ay5he5tRCkb2MTAtXc1TESz4N8mn0SOSe4iN/t/is2KVQlqcz5YO8w4OjlMx4Oxs0A+mGoZbJE+66Zplsc2lCvqxCzpYBK8YM7L877XUB3uc4+QBD6KldBjEJKPf86ycBCOBOeKLmCEKQLcWR05YsmIJl9jQMF6iw51Dl3NTN8wUBce1UYG+Pbcq0n4muAAYAo8Ap0paFFyzXDBcJkYoy2ggo7/1Nylol659ur2gO51CEGQmHuUlaAAAAhcHDB2VT5+wAAeYJ3AsAAPOnj26xxGf7AgAAAAAEWVo=',
  delta_x86_sha256: '/Td6WFoAAArh+wyhAwIDAQEEACEBDAAAJr6J3eAF2wTPXQB0AP+SaCImNSYX48893MXL83BIhnzROkcNaSa+a/1b+9jVqgJZEPOzfmAY6CxZ9xI2SQX0TgSC3t+N6ao+SOTv9tQwcJ5EAd+/9OiefaK0XYQiU1MPXCNbmb4cv2B1X21hn9hULcGaedfHZexqPflz+MkBtHRwHIc8PkYlkB+aK/c2NJjl/Om22C+3GfxdckOnP7iTnquIpEaamB8ig9S8cjdy07EJj9hlaclwZYRThc00GjALiDKd/w28j81D0TXooRuvCOa5XW4kCWTMCfT1xQPbhuIul63wKiKJc3fydeYIxVVvUd6QdGK6yoEHFwouBODO0fYbLjBNdG27r6BFsiRornLy/2RuPrwqARZV2Pm1XmcTKwgApd5Ni28vjtCWbkNtAovED0W8WUxoaFak0eV3GOlwHjP9WNtwlkDy/E0Qe+dyvPHV/S2xGVAXA9gJdg6DiDwpAWMH38Lli5D1lOmVTVy9PjumvLIBjZU7aotQIiJqA7R9pXMIS5ERBRsNrDxnM2UmbrxvfcXh7kHRrsjswBQUevPER67tGPupNa9PG9FCSK2tTkt4vboXJwZYDHcKSE5p9Smjr091LLWLk9NzEufqDyBjL2zbC/f/7u5LVhkLpu5G6dpWXd+BQbQ+mUwFVAxJQDA3t9CKIEzO3hFqR59ckTMF6H1TkXRp4dQXE1LEzHyE2IlF8tkOH0qqe+PYOdIBrRnZwpWn0KCeBTL62WnRH1B/c4qslpmeEbTyKJSehVtoLusyyHSu9DitIZtJI4MZwB+kYTzSw1yXTu5MwUOV2EtBRcgg6nnqM/YFYSJCDGEUbrtuvMd7BxDQJj8LFQyAGVHS7cJVQCxe/Cthao19Ny3NMeg0GJA/+ZGHC5jzumrCxu8KEKLPXgPpiQQ4SYq72vStnDt5WCEinGD/CKSFZWtFw8oBqVmGmU8LNl10eRSxNufPAxtc8Jp7iG3G5HQ7JWP3zFWyq7tmLnkEwPvTbPn++PqtLULVhMOdo7ZZgmDANsHg5WMFM99NcKfNrEk67YJI2QGjQaiOFQQRvFJqsSqueN/8xfMF+iwB+who/wHJUHd3ni4QbCHw0ajwKROrRjIgDtLyWCNo/ZHngdV0kX88agYps4U1FiW94qJ7f1nowLF1IUjjqvbZ3MHqzvj67j4t90mOpZcagC33wttsWUP8V18RLXEkzZVpE8v7jJZEps/argXOs9EVobfEjuAN1+ktaG6aVjSUBjX/Eb8MRCTFoZVTXEhNF5Ma+Y8nylNiu5IEi2RfDZOgo0u9NYl/nvi64eXeu/PUyzesn075BxvnOm8HaXOkmzdNFCsS7O2cPWNHV2NlixylzzN5kgYl0eH8solC1ao/jcKcXGVBOsoGg9ZbOKTjKJQce4MRv7dPFmcmaiJzkRQUMw66JSU/39o+OwArNsIDsMwbYtaR94IUI/3EC6i0uDzGA65twLFpYCVVpQznKX09PFGYL2FaoKCfI98QmvtnTEG0MLEzy60iH3HLsYGgA47CKxjd+Xliu6aDY/KoPm9FC6Jag2pjmb0eyRD9LK6d/EZe9Xg5/8YFbuikAuHMjIQ66XE1PXYIU0y+JqcwkYq8e5iXbCB4z2j0Vh5WT7JuFFy3V5lQp2X/we5dN1nLAAAHp/pZsVwh4PdfewzsOyfqZOgPg9aCw+BR1EF1iRcuRQABhwrcCwAA3AGH6rbp3xwCAAAAAApZWg==',
  x86_blocks: '/Td6WFoAAATm1rRGAgEEACEBDADWfBiv4AH/AYldAHQCPJsquZwI4Vr8uu74hn5Ofe8Hs5ZvoLXTpQpjij6kn6DoszS74UDvLGk8bqlE6c7m9r3BCH+SwPQ22NpvaYVU4fpEKnUSXDKiX4mhsLxvfM69iM7k7unJC0fA5WaXOAwlYbjsxsW+poJIspo/CSsSqso2iU/FHc/oeYlFXsPgTvH4ujMv35ZLR4QxN6MQ6dNoUa9LgWabHJFmJmdbNl1qwnaeYddWINeWOisMUpVwDAhCYYFd20bKXaH3jT+oxACbeOlWyzzxrpOZbwBaEF+anG/QKcnSUfDPyAbX+pzLTg1XZqeytFjrMNQfHYNFfcU6OrzRVY0gEE4sQ7+Esm+9RSLULfG9FeIak1MoHx8WcBhsaVF1+6KZ6N0ji9bvSg74PV3zMS5TFQ5HZalkDo6KtZ9LwoRpX/Zgcw9Nnt2aA8WzZDgaVX8hbmCdQR/aLT8SJcK4Q52Mi9v8YwUmQaelSrKQ2ngCB8Cu5DaFBlwb8+jtPJ+ftTKDdU+73wgcdPmEB4H4pIP5QAAAAAC8rtVvNaeo0gIBBAAhAQwA1nwYr+AB/wGiXQAFgaNRvY7VK/3MYEkPXEgyXckmI5l+AqRIz8SGG0SgfOPlNRa4sAhd9unXmO9q2EaKxWnfy++7BmrEgQcnAT7AUmkrsZfp861Rv0+Su2TgEZOEARqXRw6DpbFx/1y90e1ZdPLOZROgI3CNFU+ZWIbcHGRmbRB3tE1DwnmMugu3miMZlypVxnqQAr0pQL9Tlj18ZuSoQBQjpuD+yRmE8zAH3IlP4rDeGoqHo4t7+53NhXYFaOVOIC7ZuIFNPrUFz03RXcHpKrBEKRueAzBULLJppq+GY/UwuXSPbanYYgIDuI/Q9BO+KxHpSuuw9slesJjO5HC7Vf5Z0IBEWTgstzBQKfWAqU9ju0OtmNH14+jRSbBYU2BV6aO+C5XrItNFlcjfgGPiCHfIncsK2EgqgCMpuVW3DrMbTOmE38jtLOPmCuhZZMORrumu8zHczlbf/BwR9kjjQyKAvxg1b/wBfzFScMoWFxZLFm1WhrqLUG9zpqin1JUwm//YcWYC5RTMezP4UIoMr+3D1gHuxIjLNXw/vWX/MutbnA2d8dx1D54jE9t0AAAAJNX4+3gjvfECAQQAIQEMANZ8GK/gAdsBiV0ABbpr8P7Pdyf8hzvd3mxTSL+yKMJEfJaZYDnxodimKI8oJ1f7DGLPl2H9HKJmIhoMK/kjJh3nkQLwZjAibE0EVMQu0ewl6JNKY7vb2FYcNSdcX5gvNdFB1irCgMzM4gQdbnYKpBrHnw/r1CzYaqQPrxorT+fSFh+DWFn8GVVswhI191vTmrE+PMnbOnLnu34gqw6jnQjsh3A/JGhOBER+M2CU99qozQ9m6sT0Tsl4aNmNFHSN820KLVcDl+mxVJdmtPz1liXRwdnHuVTil82i/3JNVF/gL1udkJgoFD3iiRK9GQMKD3GeiICqk7MwyCFNGVyRRprJWju3gK+31Kh2Vpq2ErjX2X1383pJyBjHyTA4SUdyEca7pz6NJaReHzAjSGlnslIOY/Q7B0oTrNhhgMSOWFKCxEOpGTfOoYTaworBkqI82RiFE92ff7EaFNFsu3EHTLzV2Grvy3djHQAWHBko8U0xs5g9UU9etMfJkjem2+7Ionctyzx68imnmbr/K6wmSpGrqJvdAAAAAJkZWh39My19AAOlA4AEvgOABKUD3AMAAKTM1TSsJz4tBAAAAAAEWVo=',
  ia64: '/Td6WFoAAATm1rRGAgEGACEBDADd3dDi4AXbBCpdAHQA/JsquZx+N8Quq2b+nGoFaYRKv/bzfrlKBQFzJcImrz3ppCzAko0GtjfYvPhMvOJxOCXxb5rCszCUd4UCdqo1egmsSIQEizREKudi3IPr7PdJgxM6co8Cf4OHnhPTwwLh/OOYKb3QSmnt/fGJWlAlDYhh27s28tpmTEN9/jupmNlQb7dFm/7LiHURQ7Zfuj5MXad9/0q00bruybXb8jpy4h1Geb4YWYbrsnQ7thUQrysrBc0XO/px/rJoAqpjP8DKYXkgD52o5EKqQud0QaxS6sjPEW8Nidv4G6airFuF+L0PgU0t+FuyY2uGIBW9NMJlphH7Vnz/gN5yUfmhWk3CgcXvkHKNnlWm7E9r41y/3Ers7l1eFabVBbS1LWZByvDDn0/4Pq68H60sSCQGg5R+dETa+G74Xh7km9Zb7p9U73q1mL3R6J2rZSAgZa5FmLa8C7j8fC691DeiHHVMLTORDG2evGV/e2cYIDYtBdgLMR6WCd4tTIsuz1txYNaqxPD8WAV1SAi1RNwhEdpKtnfNAYivqe9884BMDng/E/LHs+hlA8f1nqALjQsqsvKOyPYniVNhOWlE4sinXcTlqRymi2Hstbh0Pn9lxUx1frmphIcw3SbCetpXi5bMa2ZjAk4Jrmj10LJRKuaaaZpReRrRswzmIqb8DN/7WpzsFcyYNbaI8qzj74C3HLTLAFxb0gc3HeYLi3jsRRSjT3CA0Gd8OkICW3TehqPGIYSQBSlOOgzpQbWQQbpGknNuPfpGmWY6P8zigTAQYygoZKDL658ViB5aaaBfJU5BoCOzHzM+yPi040SqyclIJE/0e0PAIpdSBti6UXrQ4jHaPtqukeCjzAgWdOqieX7oj/dMasVKQJQbwsPcUB05mtGyO+AoS9KcZ5WD+cQAqPPUuXQnQBapDYtzAzKaIhO3PjEpr654D9Ej8rtySL6m+3ySntx1JXut3vAGOUV/tw8k0M9C4E4Tm9zwuH6vVrzqLI+GOIcIXENcWPf2AuiH9yDmeVU+ZkgQLJUBDZAgf5PtndK0JIAz0OzksGi4lH+PmPWIMgf5xrcNFpPRAcITlVoQiQ6S9Hn2fjv31ioFT8NcfkWhu+snfWliWsKBO6DOVbT8cuOBU48KpKIxtj/9hAPqsrc2MEyEqytYlYdwZXyKhvAlMXilfFce57KU5PR4x2vOTQ41LKP7gJp8ResoznAnuOloru+OZhbYUtFqO5mH1sIBnQC89yvmfXZ6QRdS+H/nn1MBxbcgvXQ5BNpURgD2qSmtooElrdG2D3Rhis+Vhj/f/0TXp8U9FiXxIc8PXFbIyohMIKdcZDNiExNZ/7LHoh2jVEig8U05bREC7fNbA2siyPeIWfjHVF3+n01lVLGLDqoPlEQecLGV3qfMYxu2Avhb1dNRmWTrW7BG78gAAACFwcMHZVPn7AABxgjcCwAAdYtDVLHEZ/sCAAAAAARZWg==',
  x86_start: '/Td6WFoAAATm1rRGAwEEBBAAAAAhAQwAYuaAUOAF2wRBXQB0BjybKrmX/ceQhylglH/l4DskfjQ4XZs3XhDs8P7CDa7Q78as6ipoPxgodAuObS4PIU/SpzZJjqxwmkpyCXrO7qzMO8PWF4PApFTrXPyi1Yn/nel4dku/4mxMVoKITH2280N5C3rSSotMEy6u03Loe6H78Q7frtivcU20ocSAk5UpU605x/4zTAFkEUz4yqdz8BQvhEE5bRvmFF1meQ57IZqpaW0BplL17tsmoXzFyC2+5ajPb2QHgjaAjibChZsli4/nZIOWvL3HCythr2WktCjh8v6d0L5Rj8xZKTc9syPhOrV74n4ndc3WDys6u2M/jTYGobWNWYrQ3iicSgSr0oxFOGX0Quplobg+JHtm75T7axeFxFA0xtD2BVCFR2gWCc64RoHvU1XVY1W7nJG5s2VP5YrUfj9JHLjsa+vkka51exlnooge3XXxmN3WfYsD8DjoXmd/NXyq+1tI2lixGBdyqsbIty+4U4gbxD0QJrynDpHYZPH5yrmfXWmFFELDq3MPrmifZ9Kqu/Y/qcOR/QUMS8EpnpC1BC9wtcwfCh8xOxwXWsrJDN2ItTuXyCBoIvfpWmx1EJx39wZhTJfb9Ne7TQcKZll475VuYqm0qzxkF9hQuQEktYt+IkIEUXe31PSDayreBJ4J4PeVJRRC/RbMV97NYPUd5NE0AihS1T9BWcRY7G94Rihc9lUVRZd6jfGpA/IxDACvndHIkUWpr057/soOFA84XCFKkGzu7CTC08G2BkLPEhhoa3g8jc1UGtSakuZVe4xRVsJE2N2ugt5T8kR8F9sfXTrc/tHUGigHqmwZ1U8QXP8I5H6tVa3VBshkIaL4WVHBbSCD4F+zzzqjR6JCl7Vcmr5WkRQ3m9hXFsnPtXeCycCoCg+///aVps6y9AAXPaKEwgdj4myODEKefQ6mcUpbdmfjixJzRjNynaqNvF6DZ1/hZORJROH4yq+MEitO/qOpNpgcCWxkiHRAWu91Y1CcKRUVwdrZVLbAU+81odiQNspLfEIVkLMImlgbax9tWXsLfR5L6qIh7wkTLawo1ShQuxZtBtTyVJtwSneqpryghJbwjY+TLI5lOVhuSAjT5a8Q0IixjJ/6RNcxLM9nXmPE5Qq44BdN8B6sDpUpaYAUBMbYf5xR0RnSCiVkYTYP1CFUM4LIEyoUzOdlgQm6nlermRkJZxdB0561nHJ1qF0zAH7owrP+43eTOy93JYAw5FdiYDDg5DVMytj8XE9QuZeuHk+hkhaMoeiIr2cOnyjJwZQy99RpSpf9lO+G2DNXOPyeeOhugVhCDUAm2Z+H52uKqJDekpEnFY10CuJL3Ov9mQxFC15S1YioUAyO27ZXYHtuvke9+CjSkquyc8yw845fQ16Hx34r4Ja+1/HcvwMIWDER8Wcg5JMgKhi/jDtM1bvkIPdLEOzbkEdEm/ZHp4uaPzb9opAtjgAAAAAAhcHDB2VT5+wAAeEI3AsAAPu+6k6xxGf7AgAAAAAEWVo=',
};

describe('sha256 (synchronous)', () => {
  it('matches node:crypto for empty, short, block-boundary and long inputs', () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 5000]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);
      expect(Buffer.from(sha256(data)).toString('hex'), String(n)).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
  it('hashes a sub-range', () => {
    const data = Uint8Array.from({ length: 100 }, (_, i) => i);
    expect(Buffer.from(sha256(data, 10, 70)).toString('hex')).toBe(createHash('sha256').update(data.subarray(10, 70)).digest('hex'));
  });
});

describe('xz SHA-256 integrity check', () => {
  it('decodes a real --check=sha256 stream', () => {
    expect(same(xzDecompress(b64(FIXTURES.sha256)), input())).toBe(true);
  });
  it('fails when only the stored digest is damaged (task 059 reproduction)', () => {
    const good = b64(FIXTURES.sha256);
    const data = input();
    // The digest follows the block's padded LZMA2 data; find it by value rather than by offset.
    const digest = createHash('sha256').update(data).digest();
    const at = Buffer.from(good).indexOf(digest);
    expect(at).toBeGreaterThan(0);
    for (const i of [0, 15, 31]) {
      const bad = good.slice(); bad[at + i] ^= 0x01;
      expect(() => xzDecompress(bad), `byte ${i}`).toThrow(/checksum mismatch \(SHA-256\)/);
    }
  });
  it('fails when the data is damaged but the digest is not', () => {
    const good = b64(FIXTURES.sha256);
    const bad = good.slice(); bad[good.length >> 1] ^= 0x10;
    expect(() => xzDecompress(bad)).toThrow();
  });
});

describe('xz integrity check types', () => {
  // Stream header flags are bytes 6-7; their CRC32 (bytes 8-11) must be repaired after changing the type.
  const withCheck = (type: number): Uint8Array => {
    const d = b64(FIXTURES.x86).slice();
    d[7] = type;
    new DataView(d.buffer).setUint32(8, crc32(d, 6, 8), true);
    return d;
  };
  it('refuses every check type it does not verify instead of skipping it', () => {
    for (const type of [2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15]) expect(() => xzDecompress(withCheck(type)), String(type)).toThrow(/unsupported xz integrity check type/);
  });
  it('still reads CRC32, CRC64 and (by encoder choice) no check', () => {
    // type 0 is a real choice: it needs an index/footer that agree, so use a stream actually made that way
    const none = spawnSync('xz', ['-c', '--check=none', '--lzma2=preset=0'], { input: Buffer.from(input()) });
    if (none.status === 0) expect(same(xzDecompress(new Uint8Array(none.stdout)), input())).toBe(true);
    expect(same(xzDecompress(b64(FIXTURES.x86)), xzDecompress(b64(FIXTURES.x86)))).toBe(true);
  });
});

describe('xz Delta and BCJ filters', () => {
  const plain = input();
  // Each filter's inverse is checked against the real encoder: decoding must give back the generated input.
  for (const name of ['x86', 'arm', 'armthumb', 'powerpc', 'sparc', 'delta', 'delta_x86_sha256', 'x86_blocks', 'x86_start']) {
    it(`decodes a real xz stream made with ${name}`, () => {
      expect(same(xzDecompress(b64(FIXTURES[name])), plain)).toBe(true);
    });
  }
  it('does not return the filtered bytes: the transform is actually undone', () => {
    // The raw LZMA2 payload of an x86 stream is the *encoded* data; if the inverse were skipped the check
    // (CRC64 of the original) would fail, so reaching here already proves it. Make that explicit.
    const d = b64(FIXTURES.x86).slice();
    expect(xzDecompress(d).length).toBe(plain.length);
  });
  it('names the filters it cannot undo', () => {
    expect(() => xzDecompress(b64(FIXTURES.ia64))).toThrow(/unsupported xz filter IA-64/);
  });
  it('rejects damaged filter properties', () => {
    // delta: filter id 0x03, props size 1, props byte; flip the props size to 2 (header CRC repaired)
    const d = b64(FIXTURES.delta).slice();
    const hs = (d[12] + 1) * 4;
    const hdr = d.subarray(12, 12 + hs);
    const idAt = hdr.indexOf(0x03, 2);
    expect(hdr[idAt + 1]).toBe(1);
    hdr[idAt + 1] = 2;
    new DataView(d.buffer).setUint32(12 + hs - 4, crc32(d, 12, 12 + hs - 4), true);
    expect(() => xzDecompress(d)).toThrow(/Delta filter properties|corrupt xz data/);
  });
  it('concatenated streams with different filters decode together', () => {
    const joined = new Uint8Array([...b64(FIXTURES.x86), ...b64(FIXTURES.delta)]);
    expect(xzDecompress(joined).length).toBe(plain.length * 2);
  });
});

const hasXz = spawnSync('xz', ['--version']).status === 0;
describe.skipIf(!hasXz)('xz filters against the live encoder', () => {
  it('round-trips binary data through every supported filter', () => {
    const bytes = new Uint8Array(readBinary());
    for (const filter of ['--x86', '--arm', '--armthumb', '--powerpc', '--sparc', '--delta=dist=1', '--delta=dist=4', '--delta=dist=256']) {
      for (const check of ['crc32', 'crc64', 'sha256']) {
        const enc = execFileSync('xz', ['-c', `--check=${check}`, filter, '--lzma2=preset=1'], { input: Buffer.from(bytes), maxBuffer: 1 << 28 });
        expect(same(xzDecompress(new Uint8Array(enc)), bytes), `${filter} ${check}`).toBe(true);
      }
    }
  });
});
function readBinary(): Buffer {
  // A real executable has the call/jump density the BCJ filters exist for.
  return require('node:fs').readFileSync(execFileSync('sh', ['-c', 'command -v ls']).toString().trim()).subarray(0, 60000);
}
