/**
 * x86-64 Runtime — top-level entry point for executing ELF binaries.
 * Connects the CPU, memory, decoder, ELF loader, and syscalls together.
 */

import { CPU } from './cpu';
import { VirtualMemory } from './memory';
import { Decoder } from './decode';
import { loadElf } from './elf';
import { LinuxSyscalls, X86Exit } from './syscalls';
import type { FileSystem } from '../filesystem';

const MAX_INSTRUCTIONS = 100_000_000; // Safety limit: 100M instructions

interface X86Context {
  fs: FileSystem;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
}

interface DebugOptions {
  breakpoints?: bigint[];     // addresses to break at
  watchpoints?: bigint[];     // memory addresses to watch for writes
  dumpAddr?: bigint;          // hex dump start address
  dumpSize?: number;          // hex dump size (bytes)
  maxSteps?: number;          // max instructions to execute
}

/** Execute an ELF64 binary in the x86-64 emulator */
export async function executeElf(
  path: string,
  args: string[],
  ctx: X86Context,
): Promise<number> {
  // Read the ELF binary
  let elfData: Uint8Array;
  try {
    const raw = await ctx.fs.readFile(path);
    if (raw instanceof Uint8Array) {
      elfData = raw;
    } else {
      // String — convert to bytes
      const encoder = new TextEncoder();
      elfData = encoder.encode(raw as string);
    }
  } catch (e: any) {
    ctx.writeStderr(`shiro: ${path}: ${e.message}\r\n`);
    return 1;
  }

  // Set up emulator
  const cpu = new CPU();
  const mem = new VirtualMemory();
  const decoder = new Decoder(cpu, mem);

  // Build argv (program name + args)
  const argv = [path, ...args];

  // Build envp from shell environment
  const envp = Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`);

  // Load ELF into memory
  try {
    const info = loadElf(elfData, mem, cpu, argv, envp);
    if (!info.isStaticLinked) {
      ctx.writeStderr(`shiro: ${path}: dynamically-linked ELF binaries are not supported (need static linking)\r\n`);
      return 126;
    }
  } catch (e: any) {
    ctx.writeStderr(`shiro: ${path}: ${e.message}\r\n`);
    return 126;
  }

  // Set up syscall handling
  const syscalls = new LinuxSyscalls(
    cpu, mem, ctx.fs, ctx.cwd,
    ctx.writeStdout, ctx.writeStderr,
    ctx.stdin,
  );

  decoder.onSyscall = () => {
    // Mark that a syscall needs to be handled
    (decoder as any)._pendingSyscall = true;
  };

  // Execute
  let instructionCount = 0;
  try {
    while (!cpu.halted && instructionCount < MAX_INSTRUCTIONS) {
      (decoder as any)._pendingSyscall = false;
      decoder.step();
      instructionCount++;

      if ((decoder as any)._pendingSyscall) {
        await syscalls.handleSyscall();
      }
    }

    if (instructionCount >= MAX_INSTRUCTIONS) {
      ctx.writeStderr(`shiro: ${path}: exceeded instruction limit (${MAX_INSTRUCTIONS})\r\n`);
      return 1;
    }
  } catch (e: any) {
    if (e instanceof X86Exit) {
      return e.code;
    }
    ctx.writeStderr(`shiro: ${path}: ${e.message}\r\n`);
    return 1;
  }

  return 0;
}

/** Execute an ELF64 binary from a pre-loaded Uint8Array (for xpkg cached binaries) */
export async function executeElfFromBytes(
  elfData: Uint8Array,
  argv0: string,
  args: string[],
  ctx: X86Context,
): Promise<number> {
  const cpu = new CPU();
  const mem = new VirtualMemory();
  const decoder = new Decoder(cpu, mem);

  const argv = [argv0, ...args];
  const envp = Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`);

  try {
    const info = loadElf(elfData, mem, cpu, argv, envp);
    if (!info.isStaticLinked) {
      ctx.writeStderr(`shiro: ${argv0}: dynamically-linked ELF binaries are not supported (need static linking)\r\n`);
      return 126;
    }
  } catch (e: any) {
    ctx.writeStderr(`shiro: ${argv0}: ${e.message}\r\n`);
    return 126;
  }

  const syscalls = new LinuxSyscalls(
    cpu, mem, ctx.fs, ctx.cwd,
    ctx.writeStdout, ctx.writeStderr,
    ctx.stdin,
  );

  decoder.onSyscall = () => {
    (decoder as any)._pendingSyscall = true;
  };

  let instructionCount = 0;
  try {
    while (!cpu.halted && instructionCount < MAX_INSTRUCTIONS) {
      (decoder as any)._pendingSyscall = false;
      decoder.step();
      instructionCount++;

      if ((decoder as any)._pendingSyscall) {
        await syscalls.handleSyscall();
      }
    }

    if (instructionCount >= MAX_INSTRUCTIONS) {
      ctx.writeStderr(`shiro: ${argv0}: exceeded instruction limit (${MAX_INSTRUCTIONS})\r\n`);
      return 1;
    }
  } catch (e: any) {
    if (e instanceof X86Exit) {
      return e.code;
    }
    ctx.writeStderr(`shiro: ${argv0}: ${e.message}\r\n`);
    return 1;
  }

  return 0;
}
