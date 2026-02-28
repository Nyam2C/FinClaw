// packages/server/src/auto-reply/commands/registry.ts
import type { MsgContext } from '@finclaw/types';

/** 명령어 정의 */
export interface CommandDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly usage: string;
  readonly category: CommandCategory;
  readonly requiredRoles?: readonly string[];
  readonly cooldownMs?: number;
}

export type CommandCategory = 'general' | 'finance' | 'admin' | 'debug';

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
  unregister(name: string): boolean;
  get(name: string): { definition: CommandDefinition; executor: CommandExecutor } | undefined;
  list(): readonly CommandDefinition[];
  listByCategory(category: CommandCategory): readonly CommandDefinition[];
  parse(content: string, prefix: string): ParsedCommand | null;
  execute(parsed: ParsedCommand, ctx: MsgContext): Promise<CommandResult>;
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

  unregister(name: string): boolean {
    const entry = this.commands.get(name);
    if (!entry) {
      return false;
    }

    for (const alias of entry.definition.aliases) {
      this.aliasMap.delete(alias);
    }
    this.commands.delete(name);
    return true;
  }

  get(name: string): CommandEntry | undefined {
    const resolved = this.aliasMap.get(name) ?? name;
    return this.commands.get(resolved);
  }

  list(): readonly CommandDefinition[] {
    return [...this.commands.values()].map((e) => e.definition);
  }

  listByCategory(category: CommandCategory): readonly CommandDefinition[] {
    return [...this.commands.values()]
      .filter((e) => e.definition.category === category)
      .map((e) => e.definition);
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

  async execute(parsed: ParsedCommand, ctx: MsgContext): Promise<CommandResult> {
    const entry = this.get(parsed.name);
    if (!entry) {
      return { content: `알 수 없는 명령어: ${parsed.name}`, ephemeral: true };
    }
    return entry.executor(parsed.args, ctx);
  }
}
