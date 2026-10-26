import type { Role } from '@hf/shared';
import { audit } from '../../audit/audit.js';
import { teams, users } from '../../db/schema/index.js';
import type { Actor } from '../../auth/sessions.js';
import { registerSeeder, type SeedCtx } from '../registry.js';

export const DEMO_DOMAIN = 'demo.test'; // reserved (RFC 6761): can never deliver mail
const TEAM_NAMES = ['Operations', 'Sales'] as const;
const MANAGER_LOCAL: Record<(typeof TEAM_NAMES)[number], string> = { Operations: 'ops.manager', Sales: 'sales.manager' };

const asciiName = (s: string): string => s.normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '');

function addUser(ctx: SeedCtx, key: string, id: string): void {
  (ctx.created[key] ??= []).push(id);
}

registerSeeder({
  name: 'people',
  order: 10,
  async run(ctx) {
    const { tx, faker } = ctx;

    const [adminRow] = await tx.insert(users).values({
      email: `admin@${DEMO_DOMAIN}`, name: 'Morgan Admin', role: 'admin', teamId: null, passwordHash: ctx.passwordHash,
    }).returning();
    if (!adminRow) throw new Error('The demo admin was not created.');
    const admin: Actor = { id: adminRow.id, email: adminRow.email, name: adminRow.name, role: 'admin', teamId: null };
    addUser(ctx, 'user:admin', admin.id);
    await audit(tx, { actor: null }, { action: 'user.invited', targetType: 'user', targetId: admin.id, details: { email: admin.email, role: 'admin', via: 'seed' } });
    ctx.signIns.push({ email: admin.email, role: 'admin', team: null });

    const taken = new Set<string>();
    const makePerson = async (team: { id: string; name: string }, role: Role, email: string, name: string, active: boolean) => {
      const [row] = await tx.insert(users).values({
        email, name, role, teamId: team.id, passwordHash: active ? ctx.passwordHash : null,
      }).returning({ id: users.id });
      if (!row) throw new Error('A demo person was not created.');
      await audit(tx, { actor: admin }, { action: 'user.invited', targetType: 'user', targetId: row.id, details: { email, role, teamId: team.id } });
      if (active) {
        await audit(tx, { actor: { id: row.id, email, name, role, teamId: team.id } }, { action: 'user.invite_accepted', targetType: 'user', targetId: row.id });
        ctx.signIns.push({ email, role, team: team.name });
      }
      return row.id;
    };
    const uniqueEmail = (): { email: string; name: string } => {
      for (;;) {
        const first = faker.person.firstName();
        const last = faker.person.lastName();
        const local = `${asciiName(first)}.${asciiName(last)}`;
        const email = `${local}@${DEMO_DOMAIN}`;
        if (local.length > 3 && !taken.has(email)) { taken.add(email); return { email, name: `${first} ${last}` }; }
      }
    };
    taken.add(adminRow.email);

    for (const teamName of TEAM_NAMES) {
      const [team] = await tx.insert(teams).values({ name: teamName }).returning({ id: teams.id, name: teams.name });
      if (!team) throw new Error('A demo team was not created.');
      addUser(ctx, `team:${teamName}`, team.id);
      await audit(tx, { actor: admin }, { action: 'team.created', targetType: 'team', targetId: team.id, details: { name: team.name } });

      const managerEmail = `${MANAGER_LOCAL[teamName]}@${DEMO_DOMAIN}`;
      taken.add(managerEmail);
      const mgr = faker.person;
      const managerId = await makePerson(team, 'manager', managerEmail, `${mgr.firstName()} ${mgr.lastName()}`, true);
      addUser(ctx, `user:${MANAGER_LOCAL[teamName]}`, managerId);

      for (let i = 1; i <= 3; i++) {
        const p = uniqueEmail();
        addUser(ctx, `user:${teamName.toLowerCase()}.member`, await makePerson(team, 'member', p.email, p.name, true));
      }
      if (teamName === 'Sales') {
        const p = uniqueEmail();
        addUser(ctx, 'user:sales.invited', await makePerson(team, 'member', p.email, p.name, false));
      }
    }
    ctx.counts['teams'] = TEAM_NAMES.length;
    ctx.counts['people'] = 1 + TEAM_NAMES.length * 4 + 1;
  },
});
