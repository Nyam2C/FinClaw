// packages/server/src/auto-reply/commands/registry.ts
import type { MsgContext } from '@finclaw/types';

/** 명령어 정의 */
export interface CommandDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly usage: string;
}

/** 명령어 실행 함수 */
export type CommandExecutor = (args: readonly string[], ctx: MsgContext) => Promise<CommandResult>;

/** 명령어 실행 결과 */
export interface CommandResult {
  readonly content: string;
  readonly ephemeral: boolean;
}

/** 파싱된 명령어 */
export interface ParsedCommand {
  readonly name: string;
  readonly args: readonly string[];
  readonly raw: string;
}

/** 명령어 레지스트리 인터페이스 */
export interface CommandRegistry {
  register(definition: CommandDefinition, executor: CommandExecutor): void;
  get(name: string): { definition: CommandDefinition; executor: CommandExecutor } | undefined;
  list(): readonly CommandDefinition[];
  parse(content: string, prefix: string): ParsedCommand | null;
}

interface CommandEntry {
  readonly definition: CommandDefinition;
  readonly executor: CommandExecutor;
}

/** 인메모리 명령어 레지스트리 구현 */
export class InMemoryCommandRegistry implements CommandRegistry {
  private readonly commands = new Map<string, CommandEntry>();
  private readonly aliasMap = new Map<string, string>();

  register(definition: CommandDefinition, executor: CommandExecutor): void {
    const entry: CommandEntry = { definition, executor };
    this.commands.set(definition.name, entry);

    for (const alias of definition.aliases) {
      this.aliasMap.set(alias, definition.name);
    }
  }

  get(name: string): CommandEntry | undefined {
    const resolved = this.aliasMap.get(name) ?? name;
    return this.commands.get(resolved);
  }

  list(): readonly CommandDefinition[] {
    return [...this.commands.values()].map((e) => e.definition);
  }

  parse(content: string, prefix: string): ParsedCommand | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith(prefix)) {
      return null;
    }

    const withoutPrefix = trimmed.slice(prefix.length);
    const parts = withoutPrefix.split(/\s+/);
    const name = parts[0];
    if (!name) {
      return null;
    }

    return {
      name: name.toLowerCase(),
      args: parts.slice(1),
      raw: trimmed,
    };
  }
}
