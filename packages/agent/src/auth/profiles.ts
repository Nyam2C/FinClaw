// packages/agent/src/auth/profiles.ts
import type { AuthProfile } from '@finclaw/types';
import type { ProviderId } from '../models/catalog.js';
import type { CooldownTracker } from './cooldown.js';
import type { ProfileHealthMonitor } from './health.js';

/**
 * CRUD 수명주기 필드가 추가된 관리형 인증 프로필.
 * @finclaw/types의 AuthProfile(provider, apiKey 등 기본 필드)을 확장.
 */
export interface ManagedAuthProfile extends AuthProfile {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly priority: number;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly failureCount: number;
  readonly cooldownUntil: Date | null;
}

/** 프로필 생성 입력 */
export interface CreateProfileInput {
  readonly name: string;
  readonly provider: ProviderId;
  readonly apiKey: string;
  readonly organizationId?: string;
  readonly baseUrl?: string;
  readonly priority?: number;
}

/** 프로필 CRUD 저장소 인터페이스 */
export interface AuthProfileStore {
  list(provider?: ProviderId): Promise<readonly ManagedAuthProfile[]>;
  get(id: string): Promise<ManagedAuthProfile | undefined>;
  create(input: CreateProfileInput): Promise<ManagedAuthProfile>;
  update(
    id: string,
    patch: Partial<Pick<ManagedAuthProfile, 'name' | 'isActive' | 'priority' | 'apiKey'>>,
  ): Promise<ManagedAuthProfile>;
  delete(id: string): Promise<boolean>;
  selectNext(provider: ProviderId): Promise<ManagedAuthProfile | undefined>;
  recordUsage(id: string, success: boolean): Promise<void>;
}

/** 인메모리 프로필 저장소 */
export class InMemoryAuthProfileStore implements AuthProfileStore {
  private readonly profiles = new Map<string, ManagedAuthProfile>();
  private nextId = 1;

  constructor(
    private readonly cooldownTracker: CooldownTracker,
    private readonly healthMonitor: ProfileHealthMonitor,
  ) {}

  async list(provider?: ProviderId): Promise<readonly ManagedAuthProfile[]> {
    const all = [...this.profiles.values()];
    if (!provider) {
      return all;
    }
    return all.filter((p) => p.provider === provider);
  }

  async get(id: string): Promise<ManagedAuthProfile | undefined> {
    return this.profiles.get(id);
  }

  async create(input: CreateProfileInput): Promise<ManagedAuthProfile> {
    const id = `profile-${this.nextId++}`;
    const profile: ManagedAuthProfile = {
      id,
      name: input.name,
      provider: input.provider,
      apiKey: input.apiKey,
      organizationId: input.organizationId,
      baseUrl: input.baseUrl,
      isActive: true,
      priority: input.priority ?? 0,
      createdAt: new Date(),
      lastUsedAt: null,
      failureCount: 0,
      cooldownUntil: null,
    };
    this.profiles.set(id, profile);
    return profile;
  }

  async update(
    id: string,
    patch: Partial<Pick<ManagedAuthProfile, 'name' | 'isActive' | 'priority' | 'apiKey'>>,
  ): Promise<ManagedAuthProfile> {
    const existing = this.profiles.get(id);
    if (!existing) {
      throw new Error(`Profile not found: ${id}`);
    }
    const updated = { ...existing, ...patch } as ManagedAuthProfile;
    this.profiles.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.profiles.delete(id);
  }

  /**
   * 라운드 로빈 프로필 선택
   *
   * 1. provider 필터
   * 2. isActive === true
   * 3. 쿨다운 중이 아닌 프로필
   * 4. 건강 상태가 'disabled'가 아닌 프로필
   * 5. priority 내림차순, lastUsedAt 오름차순 정렬
   * 6. 첫 번째 프로필 선택 + lastUsedAt 업데이트
   */
  async selectNext(provider: ProviderId): Promise<ManagedAuthProfile | undefined> {
    const profiles = await this.list(provider);

    const available = profiles.filter(
      (p) =>
        p.isActive &&
        !this.cooldownTracker.isInCooldown(p.id) &&
        this.healthMonitor.getHealth(p.id) !== 'disabled',
    );

    if (available.length === 0) {
      return undefined;
    }

    const sorted = [...available].toSorted((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      const aTime = a.lastUsedAt?.getTime() ?? 0;
      const bTime = b.lastUsedAt?.getTime() ?? 0;
      return aTime - bTime;
    });

    const selected = sorted[0];
    // lastUsedAt 업데이트
    this.profiles.set(selected.id, { ...selected, lastUsedAt: new Date() });
    return selected;
  }

  /** 사용 결과 기록 */
  async recordUsage(id: string, success: boolean): Promise<void> {
    const profile = this.profiles.get(id);
    if (!profile) {
      return;
    }

    this.healthMonitor.recordResult(id, success);

    if (success) {
      this.profiles.set(id, { ...profile, failureCount: 0, lastUsedAt: new Date() });
    } else {
      this.profiles.set(id, {
        ...profile,
        failureCount: profile.failureCount + 1,
        lastUsedAt: new Date(),
      });
    }
  }
}
