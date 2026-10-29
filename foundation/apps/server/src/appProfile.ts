/** The app profile (app-profile.json): which optional modules are on and what the data policy allows. Read once at start-up. */
import type { AppProfile } from '@hf/shared';
import { readAppProfile } from '@hf/shared/app-profile-file';
import { ConfigError } from './config.js';

export { moduleOn } from '@hf/shared';

/** Missing file -> the default profile (nothing on, nothing out); a bad file -> ConfigError, one plain sentence per problem. */
export function loadAppProfile(file: string): AppProfile {
  const r = readAppProfile(file);
  if (!r.ok) throw new ConfigError(r.problems);
  return r.profile;
}
