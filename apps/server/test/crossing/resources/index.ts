import type { TestApp } from '../../helpers/testApp.js';
import type { IDS, WorldResource } from '../world.js';
import { seedUsersAndTeams } from './users.js';
import { seedFiles } from './files.js';
import { seedNotes } from './notes.js';

/** Seeds one kind of resource into a freshly truncated database and describes each row it made. */
export type ResourceSeeder = (t: TestApp, ids: typeof IDS) => Promise<WorldResource[]>;

// Later tasks append a seeder here for each new resource type (files, notes, client resources).
export const RESOURCE_SEEDERS: ResourceSeeder[] = [seedUsersAndTeams, seedFiles, seedNotes];
