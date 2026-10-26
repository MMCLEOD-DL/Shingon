import { z } from 'zod';

// The app's content security policy forbids evaluating strings as code. Zod's speed-up needs that, and its probe would be
// reported as a policy violation in every browser's console, so switch it off before any schema is built (import this first).
z.config({ jitless: true });
