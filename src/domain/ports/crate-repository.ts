/** Persistence for user crates. Scoped by user via a real
 *  user_id column; `userId` is "" when auth is disabled. */
export interface CrateRepository {
  all(userId: string): Promise<Record<string, string[]>>;
  put(userId: string, name: string, trackIds: string[]): Promise<void>;
  remove(userId: string, name: string): Promise<void>;
}
