'use client';

import { SessionProvider } from 'next-auth/react';

// Providers globais do lado cliente.
// Hoje o principal e o SessionProvider do NextAuth, usado pelas telas para
// saber quem e o usuario logado e quais dados vieram do Cognito.
export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
