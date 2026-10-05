
import type { Command } from './index';
import { parseArgs, statEntry } from './flags';
import { bytesToText } from '../utils/bytes';
export const file: Command = {
  name: "file",
  description: "Determine file type",
  async exec(ctx) {
    const args = ctx.args;
    const { positional, flags } = parseArgs(args);

    if (positional.length === 0) {
      ctx.stderr += "file: missing operand\n";
      return 1;
    }

    const brief = flags.b;
    const mime = flags.i || flags.mime;
    const mimeType = flags["mime-type"];
    const mimeEncoding = flags["mime-encoding"];

    const output: string[] = [];

    try {
      for (const path of positional) {
        const resolved = ctx.fs.resolvePath(path, ctx.cwd);

        try {
          const stat = await statEntry(ctx.fs, resolved);

          if (stat.type === "dir") {
            const result = brief ? "directory" : `${path}: directory`;
            output.push(result);
            continue;
          }

          // Keep the original bytes available for binary signatures before decoding text.
          const data = await ctx.fs.readFile(resolved);
          const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
          const fileType = detectFileType(bytesToText(bytes), path, bytes);

          let result: string;
          if (mimeType) {
            result = brief ? fileType.mimeType : `${path}: ${fileType.mimeType}`;
          } else if (mimeEncoding) {
            result = brief ? fileType.encoding : `${path}: ${fileType.encoding}`;
          } else if (mime) {
            result = brief
              ? `${fileType.mimeType}; charset=${fileType.encoding}`
              : `${path}: ${fileType.mimeType}; charset=${fileType.encoding}`;
          } else {
            result = brief ? fileType.description : `${path}: ${fileType.description}`;
          }

          output.push(result);
        } catch (e: unknown) {
          output.push(`${path}: cannot open (${e instanceof Error ? e.message : e})`);
        }
      }

      ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `file: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

interface FileTypeInfo {
  mimeType: string;
  encoding: string;
  description: string;
}

function detectFileType(content: string, filename: string, bytes?: Uint8Array): FileTypeInfo {
  // Default
  let mimeType = "text/plain";
  let encoding = "us-ascii";
  let description = "ASCII text";

  // Check for non-ASCII characters
  if (/[^\x00-\x7F]/.test(content)) {
    encoding = "utf-8";
    description = "UTF-8 Unicode text";
  }

  // Empty file
  if (content.length === 0) {
    mimeType = "application/x-empty";
    description = "empty";
    return { mimeType, encoding, description };
  }

  const targa = detectTarga(bytes);
  if (targa) return { mimeType: 'image/x-targa', encoding: 'binary', description: targa };

  // Check by extension
  const ext = filename.split(".").pop()?.toLowerCase();

  if (ext) {
    switch (ext) {
      case "js":
      case "mjs":
        mimeType = "text/javascript";
        description = "JavaScript source";
        break;
      case "ts":
        mimeType = "text/x-typescript";
        description = "TypeScript source";
        break;
      case "json":
        mimeType = "application/json";
        description = "JSON data";
        break;
      case "html":
      case "htm":
        mimeType = "text/html";
        description = "HTML document";
        break;
      case "css":
        mimeType = "text/css";
        description = "CSS stylesheet";
        break;
      case "xml":
        mimeType = "text/xml";
        description = "XML document";
        break;
      case "md":
        mimeType = "text/markdown";
        description = "Markdown text";
        break;
      case "sh":
        mimeType = "text/x-shellscript";
        description = "shell script";
        break;
      case "py":
        mimeType = "text/x-python";
        description = "Python script";
        break;
      case "txt":
        mimeType = "text/plain";
        description = "ASCII text";
        break;
    }
  }

  // Check content signatures
  if (content.startsWith("#!/bin/sh") || content.startsWith("#!/bin/bash")) {
    mimeType = "text/x-shellscript";
    description = "Bourne-Again shell script";
  } else if (content.startsWith("#!/usr/bin/env node")) {
    mimeType = "text/javascript";
    description = "Node.js script";
  } else if (content.startsWith("#!/usr/bin/env python")) {
    mimeType = "text/x-python";
    description = "Python script";
  } else if (content.startsWith("{") && content.trim().endsWith("}")) {
    try {
      JSON.parse(content);
      mimeType = "application/json";
      description = "JSON data";
    } catch {
      // Not valid JSON
    }
  } else if (content.startsWith("<?xml")) {
    mimeType = "text/xml";
    description = "XML document";
  } else if (content.startsWith("<!DOCTYPE html") || content.startsWith("<html")) {
    mimeType = "text/html";
    description = "HTML document";
  }

  return { mimeType, encoding, description };
}

/** Recognize the compact, header-only information used by `file` for Targa images. */
function detectTarga(b?: Uint8Array): string | null {
  if (!b || b.length < 18) return null;
  const cmap = b[1], imageType = b[2], depth = b[16];
  if (![0, 1].includes(cmap) || ![1, 2, 3, 9, 10, 11].includes(imageType) || ![8, 15, 16, 24, 32].includes(depth)) return null;
  const u16 = (i: number) => b[i] | (b[i + 1] << 8);
  const kind = imageType === 3 || imageType === 11 ? 'greyscale' : (depth === 32 || (depth === 16 && (b[17] & 15) > 0) ? 'RGBA' : 'RGB');
  const rle = imageType >= 9 ? ' (RLE)' : '';
  let description = `Targa image data${rle} - ${kind}`;
  if (cmap) description += ` (${u16(3)}-${u16(5)})`;
  description += ` ${u16(12)} x ${u16(14)} x ${depth} +${u16(8)} +${u16(10)}`;
  const alphaBits = b[17] & 15;
  if (alphaBits) description += ` - ${alphaBits}-bit alpha`;
  if (b[17] & 0x10) description += ' - right';
  if (b[17] & 0x20) description += ' - top';
  return description;
}
