import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from './api/auth/[...nextauth]/auth';
import { getAllowedRoutes, getRoleForEmail } from '@/lib/auth/roles';

// Rota inicial da aplicacao.
// O usuario nunca fica parado em "/": se nao estiver autenticado, vai para o
// Cognito/NextAuth; se estiver, e redirecionado para a primeira pagina liberada
// pela role/permissoes.
export default async function HomePage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect('/login?callbackUrl=/');
  }

  const role = (session.user as any).role || getRoleForEmail(session.user.email);
  const permissions = (session.user as any).permissions;
  const [firstAllowedRoute] = getAllowedRoutes(role, permissions);

  redirect(firstAllowedRoute || '/upload');
}
