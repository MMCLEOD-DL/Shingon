import { Link, Navigate, createBrowserRouter, type RouteObject } from 'react-router';
import { Button, Container } from '@mantine/core';
import type { Permission } from '@hf/shared';
import { RequireAuth } from './auth.js';
import { Shell } from './Shell.js';
import { SignIn } from './pages/account/SignIn.js';
import { ForgotPassword } from './pages/account/ForgotPassword.js';
import { ResetPassword } from './pages/account/ResetPassword.js';
import { AcceptInvite } from './pages/account/AcceptInvite.js';
import { Profile } from './pages/account/Profile.js';
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
    ],
  },
  { path: '/sign-in', element: <SignIn /> },
  { path: '/forgot-password', element: <ForgotPassword /> },
  { path: '/reset-password', element: <ResetPassword /> },
  { path: '/accept-invite', element: <AcceptInvite /> },
  { path: '*', element: <NotFound /> },
];

export const router = createBrowserRouter(routeObjects);
