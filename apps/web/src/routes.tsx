import { Link, Navigate, createBrowserRouter, type RouteObject } from 'react-router';
import { Button, Container } from '@mantine/core';
import type { Permission } from '@hf/shared';
import { RequireAuth, RequirePermission } from './auth.js';
import { Shell } from './Shell.js';
import { SignIn } from './pages/account/SignIn.js';
import { ForgotPassword } from './pages/account/ForgotPassword.js';
import { ResetPassword } from './pages/account/ResetPassword.js';
import { AcceptInvite } from './pages/account/AcceptInvite.js';
import { Profile } from './pages/account/Profile.js';
import { Users } from './pages/admin/Users.js';
import { Teams } from './pages/admin/Teams.js';
import { Audit } from './pages/admin/Audit.js';
import { NotesList } from './pages/notes/NotesList.js';
import { NoteNew } from './pages/notes/NoteNew.js';
import { NoteView } from './pages/notes/NoteView.js';
import { EmptyState } from './ui/index.js';

export interface AppPath { path: string; auth: 'public' | 'signed-in'; permission?: Permission }

/** The single list of pages. Task 14's page registry is checked against it, so a page cannot exist without being listed here. */
export const APP_PATHS: AppPath[] = [
  { path: '/', auth: 'signed-in' },
  { path: '/sign-in', auth: 'public' },
  { path: '/forgot-password', auth: 'public' },
  { path: '/reset-password', auth: 'public' },
  { path: '/accept-invite', auth: 'public' },
  { path: '/profile', auth: 'signed-in' },
  { path: '/notes', auth: 'signed-in' },
  { path: '/notes/new', auth: 'signed-in' },
  { path: '/notes/:id', auth: 'signed-in' },
  { path: '/admin/users', auth: 'signed-in', permission: 'users:list' },
  { path: '/admin/teams', auth: 'signed-in', permission: 'teams:manage' },
  { path: '/admin/audit', auth: 'signed-in', permission: 'audit:read' },
];

function NotFound() {
  return (
    <Container size="sm" py="xl">
      <EmptyState title="We couldn't find that page" body="The link may be old, or the page may have moved." action={<Button component={Link} to="/">Go to the start</Button>} />
    </Container>
  );
}

// Signed-in pages live inside the shell; public pages (sign in, reset password) sit outside it. Later tasks add their routes here.
export const routeObjects: RouteObject[] = [
  {
    element: <RequireAuth><Shell /></RequireAuth>,
    children: [
      { path: '/', element: <Navigate to="/notes" replace /> },
      { path: '/profile', element: <Profile /> },
      { path: '/notes', element: <NotesList /> },
      { path: '/notes/new', element: <NoteNew /> },
      { path: '/notes/:id', element: <NoteView /> },
      { path: '/admin/users', element: <RequirePermission perm="users:list"><Users /></RequirePermission> },
      { path: '/admin/teams', element: <RequirePermission perm="teams:manage"><Teams /></RequirePermission> },
      { path: '/admin/audit', element: <RequirePermission perm="audit:read"><Audit /></RequirePermission> },
    ],
  },
  { path: '/sign-in', element: <SignIn /> },
  { path: '/forgot-password', element: <ForgotPassword /> },
  { path: '/reset-password', element: <ResetPassword /> },
  { path: '/accept-invite', element: <AcceptInvite /> },
  { path: '*', element: <NotFound /> },
];

export const router = createBrowserRouter(routeObjects);
