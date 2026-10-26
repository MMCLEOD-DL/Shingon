import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { AppShell, Avatar, Burger, Group, Menu, NavLink, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconLogout, IconUser } from '@tabler/icons-react';
import { BRAND } from './brand.js';
import { navFor } from './nav.js';
import { useAuth } from './auth.js';
import { notifyError } from './ui/notify.js';

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function Shell() {
  const [opened, { toggle, close }] = useDisclosure(false);
  const { user, signOut } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  if (!user) return null;

  const leave = async () => {
    try {
      await signOut();
      void navigate('/sign-in');
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap" gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={opened ? 'Close the menu' : 'Open the menu'} />
            <Text fw={650} size="lg" truncate>{BRAND.appName}</Text>
          </Group>
          <Menu position="bottom-end" width={220}>
            <Menu.Target>
              <UnstyledButton aria-label="Your account" p={4} style={{ minHeight: 42 }}>
                <Group gap="xs" wrap="nowrap">
                  <Avatar color="highland" radius="xl" size="md">{initials(user.name)}</Avatar>
                  <Text size="sm" visibleFrom="sm" maw={160} truncate>{user.name}</Text>
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{user.email}</Menu.Label>
              <Menu.Item component={Link} to="/profile" leftSection={<IconUser size={16} />}>Profile</Menu.Item>
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => { void leave(); }}>Sign out</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm" aria-label="Main menu">
        {navFor(user.role).map((n) => (
          <NavLink
            key={n.to}
            component={Link}
            to={n.to}
            label={n.label}
            leftSection={<n.icon size={20} />}
            active={loc.pathname === n.to || loc.pathname.startsWith(n.to + '/')}
            onClick={close}
            style={{ minHeight: 44, borderRadius: 'var(--mantine-radius-md)' }}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
