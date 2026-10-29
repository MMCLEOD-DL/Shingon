// The app's scheduled jobs, as ops loads them (`@hf/server/jobs`). Ops runs them only when "scheduled-jobs" is in
// app-profile.json. One import line per job file: a client feature adds its own file next to this one, calling
// registerAppJob, and a line here, like seed/seeders/index.ts. The foundation itself has none.
export * from './registry.js';
